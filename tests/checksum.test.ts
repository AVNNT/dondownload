import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHECKSUM_ALGORITHM_LABELS,
  detectChecksumAlgorithm,
  isChecksumResult,
  parseExpectedHash
} from '../src/shared/checksum'
import {
  ChecksumService,
  type ChecksumTarget
} from '../src/main/checksum/service'

const DOWNLOAD_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

const ABC_VECTORS = {
  md5: '900150983cd24fb0d6963f7d28e17f72',
  sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
  sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  sha512:
    'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a' +
    '2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f'
} as const

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function createService(content: string | Buffer) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dondownload-checksum-'))
  tempDirs.push(dir)
  const filePath = path.join(dir, 'sample.bin')
  await writeFile(filePath, content)

  const saveResult = vi.fn()
  const onProgress = vi.fn()
  const target: ChecksumTarget = {
    downloadId: DOWNLOAD_ID,
    filePath,
    filename: 'sample.bin',
    sizeBytes: Buffer.byteLength(content)
  }
  const service = new ChecksumService({
    resolveTarget: async (downloadId) => {
      expect(downloadId).toBe(DOWNLOAD_ID)
      return target
    },
    saveResult,
    onProgress
  })
  return { service, saveResult, onProgress, target }
}

describe('checksum algorithm detection', () => {
  it('detects all four algorithms from the hex length', () => {
    expect(detectChecksumAlgorithm(ABC_VECTORS.md5)).toBe('md5')
    expect(detectChecksumAlgorithm(ABC_VECTORS.sha1)).toBe('sha1')
    expect(detectChecksumAlgorithm(ABC_VECTORS.sha256)).toBe('sha256')
    expect(detectChecksumAlgorithm(ABC_VECTORS.sha512)).toBe('sha512')
    expect(CHECKSUM_ALGORITHM_LABELS.sha256).toBe('SHA-256')
  })

  it('trims whitespace and lowercases an expected hash', () => {
    expect(parseExpectedHash(`  ${ABC_VECTORS.sha1.toUpperCase()}\t`)).toEqual({
      algorithm: 'sha1',
      hash: ABC_VECTORS.sha1
    })
  })

  it('rejects non-hex input and unsupported lengths', () => {
    expect(detectChecksumAlgorithm('z'.repeat(32))).toBeNull()
    expect(detectChecksumAlgorithm('a'.repeat(33))).toBeNull()
    expect(detectChecksumAlgorithm('')).toBeNull()
    expect(detectChecksumAlgorithm(null)).toBeNull()
    expect(parseExpectedHash('not a hash')).toBeNull()
  })

  it('validates persisted result shapes', () => {
    expect(
      isChecksumResult({
        algorithm: 'sha256',
        ok: true,
        computed: ABC_VECTORS.sha256,
        checkedAt: 1_700_000_000_000
      })
    ).toBe(true)
    expect(
      isChecksumResult({
        algorithm: 'sha256',
        ok: true,
        computed: ABC_VECTORS.sha256.slice(0, 32),
        checkedAt: 1
      })
    ).toBe(false)
  })
})

describe('checksum hashing', () => {
  it('matches every known vector and persists the result', async () => {
    for (const [algorithm, expected] of Object.entries(ABC_VECTORS)) {
      const { service, saveResult } = await createService('abc')
      const result = await service.verify({
        downloadId: DOWNLOAD_ID,
        expectedHash: ` ${expected.toUpperCase()} `
      })

      expect(result.algorithm).toBe(algorithm)
      expect(result.ok).toBe(true)
      expect(result.computed).toBe(expected)
      expect(result.checkedAt).toBeGreaterThan(0)
      expect(saveResult).toHaveBeenCalledWith(DOWNLOAD_ID, result)
    }
  })

  it('reports a mismatch with the computed value', async () => {
    const { service } = await createService('abc')
    const result = await service.verify({
      downloadId: DOWNLOAD_ID,
      expectedHash: '0'.repeat(64)
    })

    expect(result.ok).toBe(false)
    expect(result.computed).toBe(ABC_VECTORS.sha256)
    expect(result.algorithm).toBe('sha256')
  })

  it('computes SHA-256 with no expected value', async () => {
    const { service } = await createService('abc')
    const result = await service.compute({ downloadId: DOWNLOAD_ID })

    expect(result.ok).toBeNull()
    expect(result.algorithm).toBe('sha256')
    expect(result.computed).toBe(ABC_VECTORS.sha256)
  })

  it('streams progress with the file size and a final event', async () => {
    const { service, onProgress } = await createService('abc')
    await service.compute({ downloadId: DOWNLOAD_ID })

    expect(onProgress).toHaveBeenCalled()
    const last = onProgress.mock.calls.at(-1)?.[0]
    expect(last).toEqual({
      downloadId: DOWNLOAD_ID,
      hashedBytes: 3,
      totalBytes: 3
    })
  })

  it('rejects an invalid expected hash before touching the file', async () => {
    const { service, saveResult } = await createService('abc')
    await expect(
      service.verify({ downloadId: DOWNLOAD_ID, expectedHash: 'xyz' })
    ).rejects.toMatchObject({ code: 'CHECKSUM_INVALID_HASH' })
    expect(saveResult).not.toHaveBeenCalled()
  })
})
