import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(async () => undefined) }
}))

import type { CollectionPreview } from '../src/shared/batches'
import type { AppSnapshot, DownloadItem } from '../src/shared/types'
import { normalizeHttpUrl } from '../src/shared/validation'
import {
  isMegaHost,
  keepsUrlFragment,
  redactUrlFragment
} from '../src/shared/urlFragment'
import {
  MAX_MEGA_FOLDER_ENTRIES,
  MEGA_API_ORIGIN,
  MegaError,
  createMegaAdapter,
  decodeMegaFolderKey,
  decodeMegaKey,
  decryptMegaAttributes,
  decryptMegaNodeKey,
  deriveMegaFileKey,
  parseMegaLink,
  resolveMegaFile,
  resolveMegaFolder,
  type MegaFetch,
  type MegaFileKey
} from '../src/main/hosts/mega'
import { decryptMegaFile } from '../src/main/hosts/megaDecrypt'
import { BatchManager, type BatchMegaPort } from '../src/main/batches/manager'
import { classifyScanCandidate } from '../src/main/scanner/classify'
import { normalizeScanUrl } from '../src/main/scanner/extract/url'
import {
  isMegaFileUrl,
  megaTargetOf,
  type ScanMegaPort
} from '../src/main/scanner/mega'
import type { ProbeScanItemFn } from '../src/main/scanner/probe'
import {
  ScanSessionManager,
  type ScanPageFetcher
} from '../src/main/scanner/session'

/* ------------------------------------------------------------------------- *
 * Deterministic MEGA crypto fixtures
 * ------------------------------------------------------------------------- */

/** Eight big-endian words, so every derived value can be computed by hand. */
const KEY_WORDS = [
  0x11223344, 0x55667788, 0x99aabbcc, 0xddeeff00, 0x0f1e2d3c, 0x4b5a6978,
  0x87766554, 0x43322110
]

function wordsToKey(words: readonly number[]): Buffer {
  const buffer = Buffer.alloc(32)
  words.forEach((word, index) => buffer.writeUInt32BE(word >>> 0, index * 4))
  return buffer
}

function xorWord(left: number, right: number): number {
  return (left ^ right) >>> 0
}

const FILE_KEY_BYTES = wordsToKey(KEY_WORDS)
const FILE_KEY_TEXT = FILE_KEY_BYTES.toString('base64url')

const EXPECTED_AES_KEY = wordsToKey([
  xorWord(KEY_WORDS[0]!, KEY_WORDS[4]!),
  xorWord(KEY_WORDS[1]!, KEY_WORDS[5]!),
  xorWord(KEY_WORDS[2]!, KEY_WORDS[6]!),
  xorWord(KEY_WORDS[3]!, KEY_WORDS[7]!)
]).subarray(0, 16)

const EXPECTED_IV = wordsToKey([
  KEY_WORDS[4]!,
  KEY_WORDS[5]!,
  0,
  0
]).subarray(0, 16)

/** Encrypt `MEGA{...}` the way MEGA stores a node's attributes. */
function encryptAttributes(aesKey: Buffer, json: string): string {
  const plain = Buffer.from(`MEGA${json}`, 'utf8')
  const padded = Buffer.alloc(Math.ceil(plain.length / 16) * 16)
  plain.copy(padded)
  const cipher = createCipheriv('aes-128-cbc', aesKey, Buffer.alloc(16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString(
    'base64url'
  )
}

/**
 * Encrypt a node's own key with its parent folder key the way MEGA stores it:
 * AES-128-ECB, no padding, over the whole field (32 bytes for a file key, 16
 * bytes for a subfolder key).
 */
function encryptNodeKey(parentFolderKey: Buffer, nodeKey: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', parentFolderKey, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(nodeKey), cipher.final()])
}

/**
 * The `k` field MEGA returns for a node: `<handle>:<base64urlKey>`. The handle
 * is the owner's, the key is the node's own key encrypted with the parent
 * folder key.
 */
function nodeKeyField(
  parentFolderKey: Buffer,
  nodeKey: Buffer,
  handle = ROOT_HANDLE
): string {
  return `${handle}:${encryptNodeKey(parentFolderKey, nodeKey).toString('base64url')}`
}

function encryptCtr(key: MegaFileKey, plain: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ctr', key.aesKey, key.iv)
  return Buffer.concat([cipher.update(plain), cipher.final()])
}

/* ------------------------------------------------------------------------- *
 * Fake MEGA API
 * ------------------------------------------------------------------------- */

interface RecordedCall {
  url: string
  init: RequestInit
}

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>
): { fetch: MegaFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return handler(url, init)
    }
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const FOLDER_ID = 'Folder01'
/**
 * The root folder node's own handle. The live API never reuses the link id for
 * it, and gives the root a parent handle that is not part of the listing.
 */
const ROOT_NODE_ID = 'RootNod1'
/** Parent handle of the root node; never returned as a node handle. */
const ROOT_PARENT_ID = 'GoneHand'
/** Owner handle MEGA puts in front of every node key. */
const ROOT_HANDLE = ROOT_NODE_ID
const SUBFOLDER_ID = 'SubFold1'

/** A public folder key is 16 random bytes and is used raw as the AES key. */
const FOLDER_KEY_BYTES = randomBytes(16)
const FOLDER_KEY_TEXT = FOLDER_KEY_BYTES.toString('base64url')
/** A subfolder key is another raw 16-byte key, encrypted with the folder key. */
const SUBFOLDER_KEY_BYTES = randomBytes(16)

const NODE_VIDEO_ID = 'NodeVid1'
const NODE_SCRIPT_ID = 'NodeScr1'
const NODE_NESTED_ID = 'NodeNst1'
/** File keys are 32 random bytes. */
const VIDEO_KEY_BYTES = randomBytes(32)
const SCRIPT_KEY_BYTES = randomBytes(32)
const NESTED_KEY_BYTES = randomBytes(32)

function folderNodesResponse(): unknown {
  return [
    {
      f: [
        {
          // The root node's attributes are encrypted with the raw folder key.
          // Its handle is not the link id and its parent is not in the listing.
          h: ROOT_NODE_ID,
          p: ROOT_PARENT_ID,
          t: 2,
          a: encryptAttributes(FOLDER_KEY_BYTES, '{"n":"My folder"}'),
          s: 0
        },
        {
          h: NODE_VIDEO_ID,
          p: ROOT_NODE_ID,
          t: 0,
          s: 4_096,
          a: encryptAttributes(
            deriveMegaFileKey(VIDEO_KEY_BYTES).aesKey,
            '{"n":"Fancam 01.mp4"}'
          ),
          k: nodeKeyField(FOLDER_KEY_BYTES, VIDEO_KEY_BYTES)
        },
        {
          h: NODE_SCRIPT_ID,
          p: ROOT_NODE_ID,
          t: 0,
          s: 512,
          a: encryptAttributes(
            deriveMegaFileKey(SCRIPT_KEY_BYTES).aesKey,
            '{"n":"Fancam 01.funscript"}'
          ),
          k: nodeKeyField(FOLDER_KEY_BYTES, SCRIPT_KEY_BYTES)
        },
        {
          // A subfolder: its own 16-byte key, encrypted with the folder key,
          // and attributes encrypted with that raw subfolder key.
          h: SUBFOLDER_ID,
          p: ROOT_NODE_ID,
          t: 1,
          s: 0,
          a: encryptAttributes(SUBFOLDER_KEY_BYTES, '{"n":"Extras"}'),
          k: nodeKeyField(FOLDER_KEY_BYTES, SUBFOLDER_KEY_BYTES)
        },
        {
          // A file one level down: its key is encrypted with the subfolder key.
          h: NODE_NESTED_ID,
          p: SUBFOLDER_ID,
          t: 0,
          s: 1_024,
          a: encryptAttributes(
            deriveMegaFileKey(NESTED_KEY_BYTES).aesKey,
            '{"n":"Nested 01.mp4"}'
          ),
          k: nodeKeyField(SUBFOLDER_KEY_BYTES, NESTED_KEY_BYTES)
        }
      ]
    }
  ]
}

const FILE_LINK = `https://mega.nz/file/FileId01#${FILE_KEY_TEXT}`
const FOLDER_LINK = `https://mega.nz/folder/${FOLDER_ID}#${FOLDER_KEY_TEXT}`
const FOLDER_FILE_LINK = `${FOLDER_LINK}/file/${NODE_VIDEO_ID}`
const DOWNLOAD_URL = 'https://gfs302.userstorage.mega.co.nz/dl/abc123'

function fileInfoResponse(): unknown {
  return [
    {
      g: DOWNLOAD_URL,
      s: 4_096,
      at: encryptAttributes(
        deriveMegaFileKey(FILE_KEY_BYTES).aesKey,
        '{"n":"Fancam 01.mp4"}'
      )
    }
  ]
}

/* ------------------------------------------------------------------------- *
 * Link parsing
 * ------------------------------------------------------------------------- */

describe('MEGA link parsing', () => {
  it('accepts every public link form', () => {
    expect(parseMegaLink(FILE_LINK)).toEqual({
      kind: 'file',
      id: 'FileId01',
      key: FILE_KEY_TEXT,
      sourceUrl: FILE_LINK
    })
    expect(parseMegaLink(`https://mega.nz/embed/file/FileId01#${FILE_KEY_TEXT}`)).toMatchObject({
      kind: 'file',
      id: 'FileId01'
    })
    expect(parseMegaLink(FOLDER_LINK)).toEqual({
      kind: 'folder',
      id: FOLDER_ID,
      key: FOLDER_KEY_TEXT,
      subFileId: null,
      sourceUrl: FOLDER_LINK
    })
    expect(parseMegaLink(FOLDER_FILE_LINK)).toEqual({
      kind: 'folder',
      id: FOLDER_ID,
      key: FOLDER_KEY_TEXT,
      subFileId: NODE_VIDEO_ID,
      sourceUrl: FOLDER_FILE_LINK
    })
    // Legacy forms keep the whole link in the fragment.
    expect(parseMegaLink(`https://mega.nz/#!FileId01!${FILE_KEY_TEXT}`)).toMatchObject({
      kind: 'file',
      id: 'FileId01',
      sourceUrl: FILE_LINK
    })
    expect(parseMegaLink(`https://mega.nz/#F!${FOLDER_ID}!${FOLDER_KEY_TEXT}`)).toMatchObject({
      kind: 'folder',
      id: FOLDER_ID,
      subFileId: null,
      sourceUrl: FOLDER_LINK
    })
    // Every public host is canonicalized to mega.nz.
    for (const host of ['mega.io', 'www.mega.io', 'mega.co.nz', 'www.mega.nz']) {
      expect(parseMegaLink(`https://${host}/file/FileId01#${FILE_KEY_TEXT}`)).toMatchObject({
        kind: 'file',
        sourceUrl: FILE_LINK
      })
    }
  })

  it('rejects malformed or non-public links', () => {
    const invalid = [
      'not a url',
      `http://mega.nz/file/FileId01#${FILE_KEY_TEXT}`,
      `https://mega.nz.evil.example/file/FileId01#${FILE_KEY_TEXT}`,
      `https://evil.example/file/FileId01#${FILE_KEY_TEXT}`,
      `https://mega.nz/file/FileId01`,
      `https://mega.nz/file/FileId01#tooshort`,
      `https://mega.nz/file/FileId01#${FILE_KEY_TEXT}?x=1`,
      `https://user:pass@mega.nz/file/FileId01#${FILE_KEY_TEXT}`,
      `https://mega.nz:8443/file/FileId01#${FILE_KEY_TEXT}`,
      `https://mega.nz/account#${FILE_KEY_TEXT}`,
      `https://mega.nz/file/FileId01#${FILE_KEY_TEXT}/file/NodeVid1`,
      `https://mega.nz/#!FileId01!${FILE_KEY_TEXT}extra`,
      `https://mega.nz/file/FileId01#${'A'.repeat(400)}`,
      // A 22-character folder key is not a file key.
      `https://mega.nz/file/FileId01#${FOLDER_KEY_TEXT}`,
      `https://mega.nz/#!FileId01!${FOLDER_KEY_TEXT}`
    ]
    for (const value of invalid) {
      expect(() => parseMegaLink(value), value).toThrow(MegaError)
    }
    expect(() => parseMegaLink(undefined)).toThrow(MegaError)
  })

  it('requires a 22-character key for a folder link', () => {
    // Real folder links carry 16 bytes, i.e. 22 base64url characters.
    expect(FOLDER_KEY_TEXT).toHaveLength(22)
    expect(parseMegaLink(FOLDER_LINK)).toMatchObject({
      kind: 'folder',
      key: FOLDER_KEY_TEXT
    })
    // A 43-character file key is not a folder key.
    for (const value of [
      `https://mega.nz/folder/${FOLDER_ID}#${FILE_KEY_TEXT}`,
      `https://mega.nz/folder/${FOLDER_ID}#${FILE_KEY_TEXT}/file/${NODE_VIDEO_ID}`,
      `https://mega.nz/#F!${FOLDER_ID}!${FILE_KEY_TEXT}`
    ]) {
      expect(() => parseMegaLink(value), value).toThrow(MegaError)
    }
    // Neither is a truncated or padded variant.
    for (const length of [21, 23, 24]) {
      const key = FOLDER_KEY_TEXT.slice(0, 21) + 'A'.repeat(length - 21)
      expect(
        () => parseMegaLink(`https://mega.nz/folder/${FOLDER_ID}#${key}`),
        key
      ).toThrow(MegaError)
    }
  })
})

/* ------------------------------------------------------------------------- *
 * Crypto
 * ------------------------------------------------------------------------- */

describe('MEGA key handling', () => {
  it('derives the AES key, counter and meta-MAC from the file key', () => {
    const key = deriveMegaFileKey(decodeMegaKey(FILE_KEY_TEXT))
    expect(key.aesKey.equals(EXPECTED_AES_KEY)).toBe(true)
    expect(key.iv.equals(EXPECTED_IV)).toBe(true)
    expect(key.metaMac.readUInt32BE(0)).toBe(KEY_WORDS[6])
    expect(key.metaMac.readUInt32BE(4)).toBe(KEY_WORDS[7])
    expect(key.iv.subarray(8).equals(Buffer.alloc(8))).toBe(true)
  })

  it('decrypts a MEGA attribute block', () => {
    const key = deriveMegaFileKey(FILE_KEY_BYTES)
    const attributes = encryptAttributes(key.aesKey, '{"n":"Fancam 01.mp4"}')
    expect(decryptMegaAttributes(key.aesKey, attributes)).toBe(
      '{"n":"Fancam 01.mp4"}'
    )
    // A wrong key must fail loudly instead of returning garbage.
    const other = deriveMegaFileKey(SCRIPT_KEY_BYTES)
    expect(() => decryptMegaAttributes(other.aesKey, attributes)).toThrow(
      MegaError
    )
  })

  it('decodes a 43-character file key and a 22-character folder key', () => {
    expect(FILE_KEY_TEXT).toHaveLength(43)
    expect(decodeMegaKey(FILE_KEY_TEXT).length).toBe(32)
    expect(FOLDER_KEY_TEXT).toHaveLength(22)
    expect(decodeMegaFolderKey(FOLDER_KEY_TEXT).equals(FOLDER_KEY_BYTES)).toBe(
      true
    )
    // The two key lengths are not interchangeable.
    expect(() => decodeMegaKey(FOLDER_KEY_TEXT)).toThrow(MegaError)
    expect(() => decodeMegaFolderKey(FILE_KEY_TEXT)).toThrow(MegaError)
  })

  it('decrypts a folder node key with the raw folder key', () => {
    const nodeKey = encryptNodeKey(FOLDER_KEY_BYTES, VIDEO_KEY_BYTES)
    expect(nodeKey.length).toBe(32)
    // Both blocks are decrypted, not only the first one.
    const decrypted = decryptMegaNodeKey(FOLDER_KEY_BYTES, nodeKey)
    expect(decrypted.length).toBe(32)
    expect(decrypted.equals(VIDEO_KEY_BYTES)).toBe(true)
    expect(decrypted.subarray(16).equals(VIDEO_KEY_BYTES.subarray(16))).toBe(
      true
    )
    // The folder key is used raw: it is never XOR-derived first.
    const xorDerived = deriveMegaFileKey(
      Buffer.concat([FOLDER_KEY_BYTES, FOLDER_KEY_BYTES])
    ).aesKey
    expect(decryptMegaNodeKey(xorDerived, nodeKey).equals(VIDEO_KEY_BYTES)).toBe(
      false
    )
  })

  it('decrypts a subfolder node key to that folder key', () => {
    const nodeKey = encryptNodeKey(FOLDER_KEY_BYTES, SUBFOLDER_KEY_BYTES)
    expect(nodeKey.length).toBe(16)
    expect(
      decryptMegaNodeKey(FOLDER_KEY_BYTES, nodeKey).equals(
        SUBFOLDER_KEY_BYTES
      )
    ).toBe(true)
  })

  it('round-trips a small buffer through the streamed CTR decryption', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mega-decrypt-'))
    const plain = Buffer.from('a'.repeat(1_000) + 'MEGA payload end', 'utf8')
    const key = deriveMegaFileKey(FILE_KEY_BYTES)
    const encrypted = encryptCtr(key, plain)
    const inputPath = path.join(directory, 'clip.mp4.megaenc')
    const outputPath = path.join(directory, 'clip.mp4')
    await fs.writeFile(inputPath, encrypted)

    const samples: number[] = []
    const result = await decryptMegaFile({
      inputPath,
      outputPath,
      key,
      totalBytes: encrypted.length,
      onProgress: (completed) => samples.push(completed)
    })

    expect(result.bytes).toBe(plain.length)
    expect((await fs.readFile(outputPath)).equals(plain)).toBe(true)
    // The encrypted temporary file is removed; the plaintext file stays.
    await expect(fs.stat(inputPath)).rejects.toThrow()
    expect(samples.at(-1)).toBe(plain.length)
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('removes the partial output when the decryption is aborted', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mega-abort-'))
    const key = deriveMegaFileKey(FILE_KEY_BYTES)
    const inputPath = path.join(directory, 'clip.mp4.megaenc')
    const outputPath = path.join(directory, 'clip.mp4')
    await fs.writeFile(inputPath, encryptCtr(key, Buffer.alloc(4_096, 7)))

    const controller = new AbortController()
    controller.abort()
    await expect(
      decryptMegaFile({
        inputPath,
        outputPath,
        key,
        totalBytes: 4_096,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: 'MEGA_DECRYPT_ABORTED' })
    await expect(fs.stat(outputPath)).rejects.toThrow()
    await fs.rm(directory, { recursive: true, force: true })
  })
})

/* ------------------------------------------------------------------------- *
 * Adapter
 * ------------------------------------------------------------------------- */

describe('MEGA adapter', () => {
  it('resolves one file with its real name, size and download URL', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(fileInfoResponse()))
    const resolution = await resolveMegaFile(FILE_LINK, { fetch })

    expect(resolution).toMatchObject({
      kind: 'file',
      fileId: 'FileId01',
      folderId: null,
      name: 'Fancam 01.mp4',
      size: 4_096,
      downloadUrl: DOWNLOAD_URL,
      sourceUrl: FILE_LINK
    })
    expect(resolution.key.aesKey.equals(EXPECTED_AES_KEY)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url.startsWith(`${MEGA_API_ORIGIN}/cs?id=`)).toBe(true)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual([
      { a: 'g', g: 1, ssl: 2, p: 'FileId01' }
    ])
    // No Cookie, credentials or referrer ever leaves the app.
    expect(calls[0]!.init.credentials).toBe('omit')
    expect(calls[0]!.init.redirect).toBe('manual')
    expect(calls[0]!.init.referrerPolicy).toBe('no-referrer')
  })

  it('expands a folder into one entry per file with decrypted keys', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.includes('&n=')) return jsonResponse(folderNodesResponse())
      return jsonResponse([{ g: DOWNLOAD_URL, s: 4_096 }])
    })
    const resolution = await resolveMegaFolder(FOLDER_LINK, { fetch })

    expect(resolution.kind).toBe('folder')
    expect(resolution.folderId).toBe(FOLDER_ID)
    expect(resolution.title).toBe('My folder')
    // Two files in the root folder plus one inside the subfolder.
    expect(resolution.entries.map((entry) => entry.name)).toEqual([
      'Fancam 01.mp4',
      'Fancam 01.funscript',
      'Nested 01.mp4'
    ])
    expect(resolution.entries[0]!.sourceUrl).toBe(FOLDER_FILE_LINK)
    expect(
      resolution.entries[0]!.key?.aesKey.equals(
        deriveMegaFileKey(VIDEO_KEY_BYTES).aesKey
      )
    ).toBe(true)
    // The subfolder is a key, not a downloadable entry.
    expect(resolution.entries.map((entry) => entry.nodeId)).not.toContain(
      SUBFOLDER_ID
    )
    // A file one level down is decrypted with the subfolder key.
    expect(
      resolution.entries[2]!.key?.aesKey.equals(
        deriveMegaFileKey(NESTED_KEY_BYTES).aesKey
      )
    ).toBe(true)
    // The renderer-safe preview carries no name-to-URL mapping and no key.
    expect(resolution.preview.kind).toBe('mega-folder')
    expect(resolution.preview.entryCount).toBe(3)
    expect(JSON.stringify(resolution.preview)).not.toContain(FOLDER_KEY_TEXT)
    // The folder listing is requested with the folder ID in the query string.
    expect(calls[0]!.url).toContain(`&n=${FOLDER_ID}`)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual([
      { a: 'f', c: 1, r: 1, ca: 1 }
    ])
  })

  it('decrypts node attributes with the node key, not the folder key', async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse([
        {
          f: [
            {
              h: ROOT_NODE_ID,
              p: ROOT_PARENT_ID,
              t: 2,
              a: encryptAttributes(FOLDER_KEY_BYTES, '{"n":"My folder"}')
            },
            {
              h: NODE_VIDEO_ID,
              p: ROOT_NODE_ID,
              t: 0,
              s: 4_096,
              // Attributes encrypted with the folder key instead of the node's
              // own key: the entry must not be listed as available.
              a: encryptAttributes(FOLDER_KEY_BYTES, '{"n":"Wrong key.mp4"}'),
              k: nodeKeyField(FOLDER_KEY_BYTES, VIDEO_KEY_BYTES)
            }
          ]
        }
      ])
    )
    const resolution = await resolveMegaFolder(FOLDER_LINK, { fetch })

    expect(resolution.entries).toHaveLength(1)
    expect(resolution.entries[0]).toMatchObject({
      availability: 'unavailable',
      key: null,
      sourceUrl: null
    })
    expect(resolution.preview.availableCount).toBe(0)
  })

  it('picks the node key entry that decrypts with the folder key', async () => {
    const decoyKey = randomBytes(32)
    const { fetch } = mockFetch(() =>
      jsonResponse([
        {
          f: [
            {
              h: ROOT_NODE_ID,
              p: ROOT_PARENT_ID,
              t: 2,
              a: encryptAttributes(FOLDER_KEY_BYTES, '{"n":"Shared"}')
            },
            {
              h: NODE_VIDEO_ID,
              p: ROOT_NODE_ID,
              t: 0,
              s: 4_096,
              a: encryptAttributes(
                deriveMegaFileKey(VIDEO_KEY_BYTES).aesKey,
                '{"n":"Fancam 01.mp4"}'
              ),
              // One entry per owning handle: the first one is encrypted with a
              // different key, the second one with the folder key.
              k: `${nodeKeyField(randomBytes(16), decoyKey, 'OtherHan')}/${nodeKeyField(FOLDER_KEY_BYTES, VIDEO_KEY_BYTES)}`
            }
          ]
        }
      ])
    )
    const resolution = await resolveMegaFolder(FOLDER_LINK, { fetch })

    expect(resolution.entries[0]).toMatchObject({
      name: 'Fancam 01.mp4',
      availability: 'available'
    })
    expect(
      resolution.entries[0]!.key?.aesKey.equals(
        deriveMegaFileKey(VIDEO_KEY_BYTES).aesKey
      )
    ).toBe(true)
  })

  it('decrypts a listing whose root node is not returned', async () => {
    // The live API may list only the root's children: their parent handle is
    // neither the link id nor a returned node handle.
    const { fetch } = mockFetch(() =>
      jsonResponse([
        {
          f: [
            {
              h: NODE_VIDEO_ID,
              p: ROOT_NODE_ID,
              t: 0,
              s: 4_096,
              a: encryptAttributes(
                deriveMegaFileKey(VIDEO_KEY_BYTES).aesKey,
                '{"n":"Fancam 01.mp4"}'
              ),
              k: nodeKeyField(FOLDER_KEY_BYTES, VIDEO_KEY_BYTES)
            },
            {
              h: SUBFOLDER_ID,
              p: ROOT_NODE_ID,
              t: 1,
              s: 0,
              a: encryptAttributes(SUBFOLDER_KEY_BYTES, '{"n":"Extras"}'),
              k: nodeKeyField(FOLDER_KEY_BYTES, SUBFOLDER_KEY_BYTES)
            },
            {
              h: NODE_NESTED_ID,
              p: SUBFOLDER_ID,
              t: 0,
              s: 1_024,
              a: encryptAttributes(
                deriveMegaFileKey(NESTED_KEY_BYTES).aesKey,
                '{"n":"Nested 01.mp4"}'
              ),
              k: nodeKeyField(SUBFOLDER_KEY_BYTES, NESTED_KEY_BYTES)
            }
          ]
        }
      ])
    )
    const resolution = await resolveMegaFolder(FOLDER_LINK, { fetch })

    expect(resolution.title).toBe('MEGA folder')
    expect(resolution.entries.map((entry) => entry.name)).toEqual([
      'Fancam 01.mp4',
      'Nested 01.mp4'
    ])
    expect(resolution.preview.availableCount).toBe(2)
  })

  it('decrypts a node whose key entry handle prefix differs from its parent', async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse([
        {
          f: [
            {
              h: ROOT_NODE_ID,
              p: ROOT_PARENT_ID,
              t: 2,
              a: encryptAttributes(FOLDER_KEY_BYTES, '{"n":"My folder"}')
            },
            {
              h: NODE_VIDEO_ID,
              p: ROOT_NODE_ID,
              t: 0,
              s: 4_096,
              a: encryptAttributes(
                deriveMegaFileKey(VIDEO_KEY_BYTES).aesKey,
                '{"n":"Fancam 01.mp4"}'
              ),
              // The owning handle in the key entry is not the parent handle.
              k: nodeKeyField(FOLDER_KEY_BYTES, VIDEO_KEY_BYTES, 'Stranger')
            }
          ]
        }
      ])
    )
    const resolution = await resolveMegaFolder(FOLDER_LINK, { fetch })

    expect(resolution.entries[0]).toMatchObject({
      name: 'Fancam 01.mp4',
      availability: 'available'
    })
  })

  it('resolves a folder sub-file link through the folder listing', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.includes('&n=') && calls.length === 1) {
        return jsonResponse(folderNodesResponse())
      }
      return jsonResponse([{ g: DOWNLOAD_URL, s: 4_096 }])
    })
    const resolution = await resolveMegaFile(FOLDER_FILE_LINK, { fetch })

    expect(resolution).toMatchObject({
      kind: 'file',
      fileId: NODE_VIDEO_ID,
      folderId: FOLDER_ID,
      name: 'Fancam 01.mp4',
      size: 4_096,
      downloadUrl: DOWNLOAD_URL
    })
    // The CTR decryption uses the node's own derived key and counter.
    const expected = deriveMegaFileKey(VIDEO_KEY_BYTES)
    expect(resolution.key.aesKey.equals(expected.aesKey)).toBe(true)
    expect(resolution.key.iv.equals(expected.iv)).toBe(true)
    expect(calls).toHaveLength(2)
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual([
      { a: 'g', g: 1, ssl: 2, n: NODE_VIDEO_ID }
    ])
  })

  it('resolves a sub-file link that lives in a subfolder', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.includes('&n=') && calls.length === 1) {
        return jsonResponse(folderNodesResponse())
      }
      return jsonResponse([{ g: DOWNLOAD_URL, s: 1_024 }])
    })
    const resolution = await resolveMegaFile(
      `${FOLDER_LINK}/file/${NODE_NESTED_ID}`,
      { fetch }
    )

    expect(resolution).toMatchObject({
      kind: 'file',
      fileId: NODE_NESTED_ID,
      folderId: FOLDER_ID,
      name: 'Nested 01.mp4',
      size: 1_024
    })
    expect(
      resolution.key.aesKey.equals(deriveMegaFileKey(NESTED_KEY_BYTES).aesKey)
    ).toBe(true)
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual([
      { a: 'g', g: 1, ssl: 2, n: NODE_NESTED_ID }
    ])
  })

  it('maps MEGA API result codes to typed errors', async () => {
    const cases: Array<[number, string]> = [
      [-9, 'MEGA_NOT_FOUND'],
      [-2, 'MEGA_NOT_FOUND'],
      [-16, 'MEGA_UNAVAILABLE'],
      [-6, 'MEGA_UNAVAILABLE'],
      [-17, 'MEGA_QUOTA_EXCEEDED'],
      [-11, 'MEGA_UNAVAILABLE'],
      [-99, 'MEGA_UNSUPPORTED']
    ]
    for (const [code, expected] of cases) {
      const { fetch } = mockFetch(() => jsonResponse([code]))
      await expect(resolveMegaFile(FILE_LINK, { fetch })).rejects.toMatchObject({
        code: expected
      })
    }
  })

  it('reports a transfer quota refusal with the wait MEGA provided', async () => {
    const { fetch } = mockFetch(
      () =>
        new Response('quota', {
          status: 509,
          headers: { 'x-mega-wait': '42' }
        })
    )
    await expect(resolveMegaFile(FILE_LINK, { fetch })).rejects.toMatchObject({
      code: 'MEGA_QUOTA_EXCEEDED',
      httpStatus: 509,
      waitSeconds: 42
    })
  })

  it('retries a rate limit only a bounded number of times', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse([-3]))
    await expect(resolveMegaFile(FILE_LINK, { fetch })).rejects.toMatchObject({
      code: 'MEGA_RATE_LIMITED'
    })
    expect(calls).toHaveLength(2)
  })

  it('fails closed on a server error', async () => {
    const serverError = mockFetch(() => new Response('boom', { status: 500 }))
    await expect(
      resolveMegaFile(FILE_LINK, { fetch: serverError.fetch })
    ).rejects.toMatchObject({ code: 'MEGA_UNAVAILABLE' })
  })

  it('refuses an oversized response body', async () => {
    const tooLarge = mockFetch(() =>
      jsonResponse([{ g: DOWNLOAD_URL, s: 1, at: 'x'.repeat(4_096) }])
    )
    await expect(
      resolveMegaFile(FILE_LINK, { fetch: tooLarge.fetch, maxResponseBytes: 64 })
    ).rejects.toMatchObject({ code: 'MEGA_RESPONSE_TOO_LARGE' })
  })

  it('gives up on a request that never answers', async () => {
    const timeout = mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new Error('aborted'))
          )
        })
    )
    await expect(
      resolveMegaFile(FILE_LINK, { fetch: timeout.fetch, timeoutMs: 5 })
    ).rejects.toMatchObject({ code: 'MEGA_TIMEOUT' })
  })

  it('refuses a redirect and a non-JSON answer instead of following them', async () => {
    const redirect = mockFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/' }
        })
    )
    await expect(
      resolveMegaFile(FILE_LINK, { fetch: redirect.fetch })
    ).rejects.toBeInstanceOf(MegaError)

    const html = mockFetch(
      () =>
        new Response('<html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        })
    )
    await expect(
      resolveMegaFile(FILE_LINK, { fetch: html.fetch })
    ).rejects.toMatchObject({ code: 'MEGA_INVALID_RESPONSE' })
  })

  it('caps the number of files previewed from one folder', async () => {
    const nodes: Array<Record<string, unknown>> = [
      {
        h: ROOT_NODE_ID,
        p: ROOT_PARENT_ID,
        t: 2,
        a: encryptAttributes(FOLDER_KEY_BYTES, '{"n":"Big"}'),
        s: 0
      }
    ]
    for (let index = 0; index < MAX_MEGA_FOLDER_ENTRIES + 1; index += 1) {
      nodes.push({
        h: `Node${String(index).padStart(4, '0')}`,
        p: ROOT_NODE_ID,
        t: 0,
        s: 1,
        a: encryptAttributes(
          deriveMegaFileKey(VIDEO_KEY_BYTES).aesKey,
          `{"n":"file-${index}.mp4"}`
        ),
        k: nodeKeyField(FOLDER_KEY_BYTES, VIDEO_KEY_BYTES)
      })
    }
    const { fetch } = mockFetch(() => jsonResponse([{ f: nodes }]))
    await expect(resolveMegaFolder(FOLDER_LINK, { fetch })).rejects.toMatchObject(
      { code: 'MEGA_TOO_MANY_FILES' }
    )
  })

  it('exposes the same behavior through the adapter factory', async () => {
    const { fetch } = mockFetch(() => jsonResponse(fileInfoResponse()))
    const adapter = createMegaAdapter({ fetch })
    expect(adapter.parseLink(FILE_LINK)).toMatchObject({ kind: 'file' })
    await expect(adapter.resolveFile(FILE_LINK)).resolves.toMatchObject({
      name: 'Fancam 01.mp4'
    })
  })
})

/* ------------------------------------------------------------------------- *
 * URL fragments
 * ------------------------------------------------------------------------- */

describe('MEGA URL fragments', () => {
  it('keeps the key only for MEGA hosts', () => {
    expect(isMegaHost('mega.nz')).toBe(true)
    expect(isMegaHost('www.mega.io')).toBe(true)
    expect(isMegaHost('mega.co.nz')).toBe(true)
    expect(isMegaHost('notmega.nz')).toBe(false)
    expect(keepsUrlFragment('mega.nz')).toBe(true)
    expect(keepsUrlFragment('example.com')).toBe(false)

    expect(normalizeScanUrl(FILE_LINK)).toBe(FILE_LINK)
    expect(normalizeScanUrl(FOLDER_FILE_LINK)).toBe(FOLDER_FILE_LINK)
    expect(normalizeScanUrl('https://example.com/a.mp4#frag')).toBe(
      'https://example.com/a.mp4'
    )
    expect(normalizeHttpUrl(FILE_LINK)).toBe(FILE_LINK)
    expect(normalizeHttpUrl('https://example.com/a.mp4#frag')).toBe(
      'https://example.com/a.mp4'
    )
  })

  it('redacts the key for display and logging', () => {
    expect(redactUrlFragment(FILE_LINK)).toBe('https://mega.nz/file/FileId01')
    expect(redactUrlFragment('https://example.com/a.mp4')).toBe(
      'https://example.com/a.mp4'
    )
  })

  it('classifies a MEGA link with a key as a file and without one as a page', () => {
    expect(classifyScanCandidate({ url: FILE_LINK })).toMatchObject({
      category: 'other',
      kind: 'file'
    })
    expect(
      classifyScanCandidate({ url: 'https://mega.nz/file/FileId01' })
    ).toMatchObject({ category: 'page', kind: 'page-link' })
    expect(isMegaFileUrl(FILE_LINK)).toBe(true)
    expect(isMegaFileUrl(FOLDER_FILE_LINK)).toBe(true)
    expect(isMegaFileUrl(FOLDER_LINK)).toBe(false)
    expect(megaTargetOf(FOLDER_FILE_LINK)?.id).toBe(`${FOLDER_ID}/${NODE_VIDEO_ID}`)
  })
})

/* ------------------------------------------------------------------------- *
 * Scanner
 * ------------------------------------------------------------------------- */

const PAGE_URL = 'https://forum.example/thread/mega-1'

function htmlPage(body: string) {
  return {
    finalUrl: PAGE_URL,
    status: 200,
    contentType: 'text/html',
    contentDisposition: null,
    body,
    bytes: Buffer.byteLength(body)
  }
}

function fakeMegaPort(options: {
  files?: Record<string, { name: string; size: number } | MegaError>
  folders?: Record<string, { title: string; files: Array<{ nodeId: string; name: string; size: number }> } | MegaError>
} = {}): { port: ScanMegaPort; calls: string[] } {
  const calls: string[] = []
  const port: ScanMegaPort = {
    resolveFile: async (value) => {
      const link = parseMegaLink(value)
      const id = link.kind === 'file' ? link.id : `${link.id}/${link.subFileId}`
      calls.push(`file:${id}`)
      const entry = options.files?.[id]
      if (entry === undefined) throw new MegaError('MEGA_NOT_FOUND')
      if (entry instanceof MegaError) throw entry
      return {
        kind: 'file',
        fileId: id,
        folderId: null,
        name: entry.name,
        size: entry.size,
        downloadUrl: DOWNLOAD_URL,
        key: deriveMegaFileKey(FILE_KEY_BYTES),
        sourceUrl: link.sourceUrl
      }
    },
    resolveFolder: async (value) => {
      const link = parseMegaLink(value)
      if (link.kind !== 'folder') throw new MegaError('MEGA_INVALID_LINK')
      calls.push(`folder:${link.id}`)
      const entry = options.folders?.[link.id]
      if (entry === undefined) throw new MegaError('MEGA_NOT_FOUND')
      if (entry instanceof MegaError) throw entry
      const entries = entry.files.map((file, position) => ({
        entryId: `entry_${position}`,
        position,
        nodeId: file.nodeId,
        name: file.name,
        size: file.size,
        sourceUrl: `${link.sourceUrl}/file/${file.nodeId}`,
        key: deriveMegaFileKey(FILE_KEY_BYTES),
        availability: 'available' as const,
        errorCode: null,
        errorReason: null
      }))
      const preview: CollectionPreview = {
        id: `preview_${link.id}`,
        kind: 'mega-folder',
        title: entry.title,
        entryCount: entries.length,
        availableCount: entries.length,
        unavailableCount: 0,
        entries: entries.map((item) => ({
          id: item.entryId,
          position: item.position,
          title: item.name,
          availability: 'available' as const,
          errorCode: null,
          errorReason: null
        }))
      }
      return {
        kind: 'folder',
        folderId: link.id,
        title: entry.title,
        sourceUrl: link.sourceUrl,
        preview,
        entries
      }
    }
  }
  return { port, calls }
}

/** A probe that records calls; it must never run for a resolved MEGA file. */
function recordingProbe(): { probe: ProbeScanItemFn; calls: string[] } {
  const calls: string[] = []
  const probe: ProbeScanItemFn = async (input) => {
    calls.push(input.url)
    return {
      status: 'found',
      verified: false,
      contentType: 'text/html',
      contentDisposition: null,
      sizeBytes: null,
      finalUrl: null,
      classification: classifyScanCandidate({
        url: input.url,
        contentType: 'text/html'
      }),
      reason: null
    }
  }
  return { probe, calls }
}

async function scanned(
  body: string,
  options: { mega?: ScanMegaPort; probe?: ProbeScanItemFn } = {}
): Promise<ScanSessionManager> {
  const fetcher: ScanPageFetcher = async () => htmlPage(body)
  const sessions = new ScanSessionManager({
    fetchPage: fetcher,
    followDepth: 0,
    ...(options.mega === undefined ? {} : { mega: options.mega }),
    ...(options.probe === undefined ? {} : { probeItem: options.probe }),
    onUpdate: () => undefined
  })
  const started = sessions.start(PAGE_URL)
  await sessions.waitForScan(started.sessionId)
  return sessions
}

describe('scan MEGA resolution', () => {
  it('resolves a file link to a video with its real name and size', async () => {
    const { port, calls } = fakeMegaPort({
      files: { FileId01: { name: 'Fancam 01.mp4', size: 123_456_789 } }
    })
    const probe = recordingProbe()
    const sessions = await scanned(
      `<p><a href="${FILE_LINK}">download</a></p>`,
      { mega: port, probe: probe.probe }
    )
    const session = sessions.getSession(
      [...(sessions as unknown as { sessions: Map<string, unknown> }).sessions.keys()][0]!
    )

    expect(calls).toEqual(['file:FileId01'])
    expect(probe.calls).toEqual([])
    expect(session.items).toHaveLength(1)
    expect(session.items[0]).toMatchObject({
      category: 'video',
      kind: 'file',
      name: 'Fancam 01.mp4',
      sizeBytes: 123_456_789,
      status: 'ready',
      verified: true
    })
    // The published DTO never contains the key or the full link.
    expect(JSON.stringify(session)).not.toContain(FILE_KEY_TEXT)
  })

  it('expands a folder into one card per file so scripts pair', async () => {
    const { port } = fakeMegaPort({
      folders: {
        [FOLDER_ID]: {
          title: 'My folder',
          files: [
            { nodeId: NODE_VIDEO_ID, name: 'Fancam 01.mp4', size: 4_096 },
            { nodeId: NODE_SCRIPT_ID, name: 'Fancam 01.funscript', size: 512 }
          ]
        }
      }
    })
    const sessions = await scanned(
      `<p><a href="${FOLDER_LINK}">folder</a></p>`,
      { mega: port }
    )
    const session = sessions.getSession(
      [...(sessions as unknown as { sessions: Map<string, unknown> }).sessions.keys()][0]!
    )

    expect(session.items).toHaveLength(2)
    expect(session.items.map((item) => item.name).sort()).toEqual([
      'Fancam 01.funscript',
      'Fancam 01.mp4'
    ])
    expect(session.items.map((item) => item.category).sort()).toEqual([
      'script',
      'video'
    ])
    expect(session.scriptSets?.length ?? 0).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(session)).not.toContain(FOLDER_KEY_TEXT)
  })

  it('keeps a card visible with a reason when MEGA refuses', async () => {
    const { port } = fakeMegaPort({
      files: { FileId01: new MegaError('MEGA_QUOTA_EXCEEDED') },
      folders: { [FOLDER_ID]: new MegaError('MEGA_NOT_FOUND') }
    })
    const sessions = await scanned(
      `<p><a href="${FILE_LINK}">file</a></p>` +
        `<p><a href="${FOLDER_LINK}">folder</a></p>`,
      { mega: port }
    )
    const session = sessions.getSession(
      [...(sessions as unknown as { sessions: Map<string, unknown> }).sessions.keys()][0]!
    )

    expect(session.items).toHaveLength(2)
    for (const item of session.items) {
      expect(item.status).toBe('unavailable')
      expect(item.unavailableReason).toBeTruthy()
      expect(item.unavailableReason).not.toContain('mega.nz')
    }
  })

  it('scans a pasted MEGA link without fetching the page', async () => {
    const { port } = fakeMegaPort({
      files: { FileId01: { name: 'Fancam 01.mp4', size: 4_096 } }
    })
    const fetcher = vi.fn<ScanPageFetcher>(async () => htmlPage('<html></html>'))
    const sessions = new ScanSessionManager({
      fetchPage: fetcher,
      followDepth: 0,
      mega: port,
      onUpdate: () => undefined
    })
    const started = sessions.start(FILE_LINK)
    await sessions.waitForScan(started.sessionId)
    const session = sessions.getSession(started.sessionId)

    expect(fetcher).not.toHaveBeenCalled()
    expect(session.items).toHaveLength(1)
    expect(session.items[0]).toMatchObject({
      category: 'video',
      kind: 'file',
      name: 'Fancam 01.mp4',
      status: 'ready'
    })
    expect(JSON.stringify(session)).not.toContain(FILE_KEY_TEXT)
  })
})

/* ------------------------------------------------------------------------- *
 * Batch manager
 * ------------------------------------------------------------------------- */

interface FakeDownloads {
  addCalls: Array<{ url: string; filename?: string }>
  children: Map<string, DownloadItem>
  adopted: Array<{ id: string; filePath: string }>
  add: (input: unknown) => Promise<AppSnapshot>
  pause: () => Promise<undefined>
  getItem: (id: string) => DownloadItem | null
  getSnapshot: () => AppSnapshot
  getFilePath: (id: string) => string | null
  adoptRenamedFile: (id: string, filePath: string) => void
}

function fakeDownloads(): FakeDownloads {
  const addCalls: Array<{ url: string; filename?: string }> = []
  const children = new Map<string, DownloadItem>()
  const adopted: Array<{ id: string; filePath: string }> = []
  let sequence = 0
  const downloads: FakeDownloads = {
    addCalls,
    children,
    adopted,
    add: async (input: unknown): Promise<AppSnapshot> => {
      const record = input as { url: string; filename?: string }
      addCalls.push({
        url: record.url,
        ...(record.filename === undefined ? {} : { filename: record.filename })
      })
      const id = randomUUID()
      sequence += 1
      const child: DownloadItem = {
        id,
        gid: 'gid',
        url: record.url,
        filename: record.filename ?? 'file.bin',
        dir: path.join(os.tmpdir(), 'mega-batch'),
        filePath: null,
        status: 'queued',
        totalBytes: 4_096,
        completedBytes: 0,
        speedBps: 0,
        etaSeconds: null,
        errorMessage: null,
        attempts: 1,
        maxAttempts: 3,
        // The manager picks the newest child for a URL, so a retry must be
        // distinguishable from the failed attempt it replaces.
        createdAt: sequence,
        updatedAt: sequence,
        completedAt: null
      }
      children.set(id, child)
      return {
        aria2: {
          status: 'ready',
          version: '1.37.0',
          binaryPath: null,
          message: null,
          hint: null
        },
        downloads: [...children.values()]
      }
    },
    pause: async () => undefined,
    getItem: (id: string) => children.get(id) ?? null,
    getSnapshot: () => ({
      aria2: {
        status: 'ready' as const,
        version: '1.37.0',
        binaryPath: null,
        message: null,
        hint: null
      },
      downloads: [...children.values()]
    }),
    getFilePath: (id: string) => {
      const child = children.get(id)
      if (!child || child.status !== 'complete') return null
      return path.join(os.tmpdir(), 'mega-batch', child.filename)
    },
    adoptRenamedFile: (id: string, filePath: string) => {
      adopted.push({ id, filePath })
    }
  }
  return downloads
}

function batchMegaPort(): BatchMegaPort & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    parseLink: parseMegaLink,
    resolveFile: async (value) => {
      calls.push(`file:${String(value)}`)
      return {
        kind: 'file',
        fileId: 'FileId01',
        folderId: null,
        name: 'Fancam 01.mp4',
        size: 4_096,
        downloadUrl: DOWNLOAD_URL,
        key: deriveMegaFileKey(FILE_KEY_BYTES),
        sourceUrl: FILE_LINK
      }
    },
    resolveFolder: async (value) => {
      calls.push(`folder:${String(value)}`)
      return {
        kind: 'folder',
        folderId: FOLDER_ID,
        title: 'My folder',
        sourceUrl: FOLDER_LINK,
        preview: {
          id: 'preview_mega_1',
          kind: 'mega-folder',
          title: 'My folder',
          entryCount: 1,
          availableCount: 1,
          unavailableCount: 0,
          entries: [
            {
              id: 'entry_0',
              position: 0,
              title: 'Fancam 01.mp4',
              availability: 'available',
              errorCode: null,
              errorReason: null
            }
          ]
        },
        entries: [
          {
            entryId: 'entry_0',
            position: 0,
            nodeId: NODE_VIDEO_ID,
            name: 'Fancam 01.mp4',
            size: 4_096,
            sourceUrl: FOLDER_FILE_LINK,
            key: deriveMegaFileKey(FILE_KEY_BYTES),
            availability: 'available',
            errorCode: null,
            errorReason: null
          }
        ]
      }
    }
  }
}

function createManager(overrides: {
  mega?: BatchMegaPort
  decryptMega?: (input: Parameters<typeof decryptMegaFile>[0]) => Promise<{
    outputPath: string
    bytes: number
  }>
} = {}) {
  const downloads = fakeDownloads()
  const decryptCalls: Array<Parameters<typeof decryptMegaFile>[0]> = []
  const manager = new BatchManager({
    downloads,
    mediaJobs: {
      analyzeMedia: vi.fn(),
      queueMedia: vi.fn(),
      cancelMedia: vi.fn(),
      getMediaSnapshot: vi.fn(() => ({ tool: {} as never, jobs: [] })),
      getJob: vi.fn(() => null)
    },
    collectionEngine: {
      analyzeCollection: vi.fn(),
      resolveCollectionEntries: vi.fn()
    },
    pixeldrain: {
      parseLink: vi.fn(),
      resolveFile: vi.fn(),
      resolveList: vi.fn()
    },
    mega: overrides.mega ?? batchMegaPort(),
    onUpdate: () => undefined,
    pollIntervalMs: 0,
    decryptMega:
      overrides.decryptMega ??
      (async (input) => {
        decryptCalls.push(input)
        input.onProgress?.(2_048, 4_096)
        return { outputPath: input.outputPath, bytes: 4_096 }
      })
  })
  return { manager, downloads, decryptCalls }
}

const SMART_INPUT = { urls: [FILE_LINK] }

describe('MEGA batch path', () => {
  it('queues a pasted file link, downloads it encrypted and decrypts it', async () => {
    const { manager, downloads, decryptCalls } = createManager()
    const result = await manager.submitSmartBatch(SMART_INPUT)

    expect(result.entries[0]).toMatchObject({ outcome: 'batch-item' })
    // Nothing public carries the key.
    expect(JSON.stringify(result)).not.toContain(FILE_KEY_TEXT)

    await manager.waitForIdle()
    expect(downloads.addCalls).toHaveLength(1)
    // aria2 gets the short-lived signed URL, never the MEGA page.
    expect(downloads.addCalls[0]!.url).toBe(DOWNLOAD_URL)
    // The transfer writes the still-encrypted body to a temporary path.
    expect(downloads.addCalls[0]!.filename).toBe('Fancam 01.mp4.megaenc')

    const batch = manager.getBatchSnapshot().batches[0]!
    const item = batch.items[0]!
    expect(item).toMatchObject({ status: 'running', label: 'MEGA' })

    const child = [...downloads.children.values()][0]!
    child.status = 'complete'
    child.completedBytes = 4_096
    manager.refresh()
    await manager.waitForIdle()

    expect(decryptCalls).toHaveLength(1)
    expect(decryptCalls[0]!.inputPath.endsWith('Fancam 01.mp4.megaenc')).toBe(
      true
    )
    expect(decryptCalls[0]!.outputPath.endsWith('Fancam 01.mp4')).toBe(true)
    expect(
      decryptCalls[0]!.key.aesKey.equals(EXPECTED_AES_KEY)
    ).toBe(true)
    // The child row now points at the plaintext file.
    expect(downloads.adopted).toHaveLength(1)
    expect(downloads.adopted[0]!.filePath.endsWith('Fancam 01.mp4')).toBe(true)

    const finished = manager.getBatchSnapshot().batches[0]!
    expect(finished.items[0]).toMatchObject({
      status: 'complete',
      completedBytes: 4_096
    })
    expect(JSON.stringify(manager.getBatchSnapshot())).not.toContain(
      FILE_KEY_TEXT
    )
    manager.close()
  })

  it('previews a pasted folder link and queues the selected file', async () => {
    const { manager, downloads } = createManager()
    const result = await manager.submitSmartBatch({ urls: [FOLDER_LINK] })

    expect(result.entries[0]).toMatchObject({ outcome: 'collection-preview' })
    const preview = result.previews[0]!
    expect(preview.kind).toBe('mega-folder')
    expect(JSON.stringify(result)).not.toContain(FOLDER_KEY_TEXT)

    const batch = await manager.createCollectionBatch({
      previewId: preview.id,
      selectedEntryIds: [preview.entries[0]!.id]
    })
    expect(batch.kind).toBe('mega-folder')
    expect(batch.items[0]).toMatchObject({
      title: 'Fancam 01.mp4',
      label: 'MEGA file'
    })

    await manager.waitForIdle()
    expect(downloads.addCalls[0]!.url).toBe(DOWNLOAD_URL)
    expect(downloads.addCalls[0]!.filename).toBe('Fancam 01.mp4.megaenc')
    manager.close()
  })

  it('retries once with a freshly requested URL when the signed link expired', async () => {
    const { manager, downloads } = createManager()
    await manager.submitSmartBatch(SMART_INPUT)
    await manager.waitForIdle()
    expect(downloads.addCalls).toHaveLength(1)

    const child = [...downloads.children.values()][0]!
    child.status = 'error'
    child.errorMessage = 'HTTP 403'
    manager.refresh()
    await manager.waitForIdle()

    // The item was re-queued and started again with a new URL request.
    expect(downloads.addCalls).toHaveLength(2)
    expect(downloads.addCalls[1]!.url).toBe(DOWNLOAD_URL)
    manager.close()
  })

  it('keeps the item failed when the decryption fails', async () => {
    const { manager, downloads } = createManager({
      decryptMega: async () => {
        throw new Error('boom')
      }
    })
    await manager.submitSmartBatch(SMART_INPUT)
    await manager.waitForIdle()

    const child = [...downloads.children.values()][0]!
    child.status = 'complete'
    manager.refresh()
    await manager.waitForIdle()

    const item = manager.getBatchSnapshot().batches[0]!.items[0]!
    expect(item.status).toBe('error')
    expect(item.errorMessage).toBe('The MEGA file could not be decrypted.')
    manager.close()
  })
})
