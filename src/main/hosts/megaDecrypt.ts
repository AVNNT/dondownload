import { createDecipheriv } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { MegaFileKey } from './mega'

/**
 * Streamed AES-128-CTR decryption of a downloaded MEGA file.
 *
 * MEGA serves the file body encrypted with the AES key derived from the public
 * link. The existing aria2 engine downloads that body unchanged into a
 * temporary `.megaenc` path — so multi-connection, pause and resume keep
 * working exactly as for any other HTTPS download — and this module turns it
 * into the final plaintext file as a post-processing step.
 *
 * The whole file is streamed once: memory use stays constant and the byte
 * counter gives the caller real progress for a phase that would otherwise look
 * frozen. The encrypted temporary file is deleted only after the plaintext file
 * was written successfully.
 *
 * MEGA's chunked meta-MAC is deliberately not verified: it needs a second full
 * pass over the ciphertext plus MEGA's 128 KiB chunk MAC chaining, and a wrong
 * key already produces a file that no player accepts. Skipping it never throws.
 */

/** One progress sample per quarter second is enough for a long copy. */
export const MEGA_DECRYPT_PROGRESS_INTERVAL_MS = 250

export interface MegaDecryptRequest {
  /** Downloaded, still-encrypted file. */
  inputPath: string
  /** Final plaintext path. Chosen by the caller and never overwritten silently. */
  outputPath: string
  key: MegaFileKey
  /** Encrypted byte length, used as the progress total. */
  totalBytes: number
  signal?: AbortSignal
  /** Called with the number of plaintext bytes written so far. */
  onProgress?: (completedBytes: number, totalBytes: number) => void
}

export interface MegaDecryptResult {
  outputPath: string
  bytes: number
}

export class MegaDecryptError extends Error {
  readonly code: 'MEGA_DECRYPT_FAILED' | 'MEGA_DECRYPT_ABORTED'

  constructor(code: 'MEGA_DECRYPT_FAILED' | 'MEGA_DECRYPT_ABORTED') {
    super(
      code === 'MEGA_DECRYPT_ABORTED'
        ? 'The MEGA decryption was cancelled.'
        : 'The MEGA file could not be decrypted.'
    )
    this.name = 'MegaDecryptError'
    this.code = code
  }
}

/**
 * Decrypt one downloaded file and remove the encrypted temporary copy.
 * Throws `MegaDecryptError` on failure; the caller decides what to keep.
 */
export async function decryptMegaFile(
  request: MegaDecryptRequest
): Promise<MegaDecryptResult> {
  const total = Number.isSafeInteger(request.totalBytes) && request.totalBytes > 0
    ? request.totalBytes
    : 0

  let completed = 0
  let lastReportedAt = 0
  const report = (force: boolean): void => {
    if (request.onProgress === undefined) return
    const now = Date.now()
    if (!force && now - lastReportedAt < MEGA_DECRYPT_PROGRESS_INTERVAL_MS) return
    lastReportedAt = now
    request.onProgress(total > 0 ? Math.min(completed, total) : completed, total)
  }

  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (request.signal?.aborted === true) {
        callback(new MegaDecryptError('MEGA_DECRYPT_ABORTED'))
        return
      }
      completed += chunk.length
      report(false)
      callback(null, chunk)
    }
  })

  let written = false
  try {
    const decipher = createDecipheriv(
      'aes-128-ctr',
      request.key.aesKey,
      request.key.iv
    )
    await pipeline(
      createReadStream(request.inputPath),
      decipher,
      counter,
      createWriteStream(request.outputPath)
    )
    written = true
  } catch (error) {
    if (error instanceof MegaDecryptError) throw error
    if (request.signal?.aborted === true) {
      throw new MegaDecryptError('MEGA_DECRYPT_ABORTED')
    }
    throw new MegaDecryptError('MEGA_DECRYPT_FAILED')
  } finally {
    // A partial plaintext file is never left behind: it would look complete to
    // every later check while being truncated.
    if (!written) {
      await fs.rm(request.outputPath, { force: true }).catch(() => undefined)
    }
  }

  report(true)
  await fs.rm(request.inputPath, { force: true }).catch(() => undefined)
  return { outputPath: request.outputPath, bytes: completed }
}
