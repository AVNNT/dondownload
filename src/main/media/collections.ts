/**
 * Ephemeral playlist preview state and explicit entry resolution. Page and
 * entry URLs are retained only in memory, keyed by opaque IDs, and are never
 * persisted or returned from the public preview API.
 */
import {
  MAX_COLLECTION_ENTRIES,
  MAX_COLLECTION_TITLE_LENGTH,
  parseCollectionPreview,
  parseCreateCollectionBatchInput
} from '@shared/batches'
import type { CollectionPreview } from '@shared/batches'
import { normalizeMediaSourceUrl } from '@shared/media'
import { AppError } from '../errors'
import { buildPlaylistArgs } from './args'
import {
  MAX_ANALYSIS_OUTPUT_BYTES,
  YTDLP_HINT,
  asPlainRecord,
  buildPlaylistEntryDraft,
  cleanDisplayText,
  toolUnavailableError
} from './analysis'
import {
  ProcessAbortedError,
  ProcessOutputError,
  ProcessStartError,
  ProcessTimeoutError
} from './process'
import type { CapturedProcessResult } from './process'
import type { Toolchain } from './toolchain'

const MAX_COLLECTIONS = 8
const FALLBACK_COLLECTION_TITLE = 'Playlist'

interface StoredCollection {
  id: string
  /** Normalized playlist page URL. Never returned from the public API. */
  url: string
  expiresAt: number
  entryIds: string[]
}

interface StoredCollectionEntry {
  previewId: string
  position: number
  /** Normalized entry page URL; null when the entry is unavailable. */
  url: string | null
  title: string
  durationSeconds: number | null
}

/**
 * INTERNAL selection target. It is returned only to main-process orchestration
 * code and must never cross IPC or the native bridge. `url` is a normalized
 * public page URL, not a yt-dlp selector or raw metadata value.
 */
export interface MediaCollectionTarget {
  entryId: string
  url: string
  title: string
  durationSeconds: number | null
  position: number
}

export interface CollectionStoreOptions {
  now: () => number
  ttlMs: number
  timeoutMs: number
  isClosing: () => boolean
  newOpaqueId: (prefix: 'preview' | 'entry') => string
  resolveToolchain: () => Promise<Toolchain>
  runCaptured: (
    command: string,
    args: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number }
  ) => Promise<CapturedProcessResult>
  assertPublicTarget: (url: string) => Promise<void>
}

export interface CollectionStore {
  analyze(url: string): Promise<CollectionPreview>
  resolveEntries(
    previewId: string,
    entryIds: readonly string[]
  ): Promise<MediaCollectionTarget[]>
}

export function createCollectionStore(
  options: CollectionStoreOptions
): CollectionStore {
  const {
    now,
    ttlMs,
    timeoutMs,
    isClosing,
    newOpaqueId,
    resolveToolchain,
    runCaptured,
    assertPublicTarget
  } = options

  // Ephemeral preview state, keyed by opaque IDs.
  const collections = new Map<string, StoredCollection>()
  const collectionEntries = new Map<string, StoredCollectionEntry>()

  function deleteCollection(id: string): void {
    const collection = collections.get(id)
    if (!collection) return
    collections.delete(id)
    for (const entryId of collection.entryIds) {
      collectionEntries.delete(entryId)
    }
  }

  function removeExpiredCollections(current: number): void {
    for (const [id, collection] of collections) {
      if (collection.expiresAt <= current) deleteCollection(id)
    }
  }

  function newPreviewId(): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = newOpaqueId('preview')
      if (!collections.has(id)) return id
    }
    throw new AppError(
      'MEDIA_ENGINE_ERROR',
      'The media engine could not generate a collection identifier.'
    )
  }

  function storeCollection(collection: StoredCollection): void {
    while (collections.size >= MAX_COLLECTIONS) {
      const oldest = collections.keys().next()
      if (oldest.done) break
      deleteCollection(oldest.value)
    }
    collections.set(collection.id, collection)
  }
  async function analyzeCollection(url: string): Promise<CollectionPreview> {
    if (isClosing()) {
      throw new AppError(
        'MEDIA_COLLECTION_CANCELLED',
        'The playlist analysis was cancelled.'
      )
    }
    const normalized = normalizeMediaSourceUrl(url)
    await assertPublicTarget(normalized)

    const toolchain = await resolveToolchain()
    if (toolchain.ytdlpPath === null) {
      throw toolUnavailableError(toolchain.state)
    }

    let result: CapturedProcessResult
    try {
      result = await runCaptured(
        toolchain.ytdlpPath,
        buildPlaylistArgs(normalized, toolchain.denoPath),
        {
          timeoutMs: timeoutMs,
          maxOutputBytes: MAX_ANALYSIS_OUTPUT_BYTES
        }
      )
    } catch (error) {
      if (error instanceof ProcessAbortedError) {
        throw new AppError(
          'MEDIA_COLLECTION_CANCELLED',
          'The playlist analysis was cancelled.'
        )
      }
      if (error instanceof ProcessTimeoutError) {
        throw new AppError(
          'MEDIA_COLLECTION_TIMEOUT',
          'The playlist took too long to analyze. Try again.'
        )
      }
      if (error instanceof ProcessOutputError) {
        throw new AppError(
          'MEDIA_COLLECTION_TOO_LARGE',
          'The playlist is too large to preview safely.'
        )
      }
      if (error instanceof ProcessStartError) {
        throw new AppError(
          'MEDIA_TOOL_UNAVAILABLE',
          'yt-dlp could not be started.',
          YTDLP_HINT
        )
      }
      throw new AppError(
        'MEDIA_COLLECTION_FAILED',
        'yt-dlp could not read this playlist.'
      )
    }

    if (result.code !== 0) {
      throw new AppError(
        'MEDIA_COLLECTION_FAILED',
        'yt-dlp could not read this playlist. It may be private, unavailable, or require a sign-in.',
        'Only public playlists are supported. DonDownload does not use cookies, browser credentials, DRM or CAPTCHA bypass.'
      )
    }

    let rawInfo: unknown
    try {
      rawInfo = JSON.parse(result.stdout)
    } catch {
      throw new AppError(
        'MEDIA_COLLECTION_FAILED',
        'yt-dlp returned an unreadable playlist response.'
      )
    }

    const info = asPlainRecord(rawInfo)
    if (info === null) {
      throw new AppError(
        'MEDIA_COLLECTION_FAILED',
        'yt-dlp returned an unreadable playlist response.'
      )
    }

    const rawEntries = info.entries
    if (!Array.isArray(rawEntries) || info._type === 'video') {
      throw new AppError(
        'MEDIA_COLLECTION_NOT_PLAYLIST',
        'This page is not a playlist.',
        'Open a playlist page or analyze the video on its own.'
      )
    }
    if (
      info._type !== undefined &&
      info._type !== 'playlist' &&
      info._type !== 'multi_video'
    ) {
      throw new AppError(
        'MEDIA_COLLECTION_NOT_PLAYLIST',
        'This page is not a playlist.',
        'Open a playlist page or analyze the video on its own.'
      )
    }
    if (rawEntries.length === 0) {
      throw new AppError(
        'MEDIA_COLLECTION_EMPTY',
        'This playlist does not contain any entries.'
      )
    }
    if (rawEntries.length > MAX_COLLECTION_ENTRIES) {
      throw new AppError(
        'MEDIA_COLLECTION_TOO_LARGE',
        `This playlist has more than ${MAX_COLLECTION_ENTRIES} entries and cannot be previewed.`
      )
    }

    const usedEntryIds = new Set<string>()
    const newEntryId = (): string => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const id = newOpaqueId('entry')
        if (!usedEntryIds.has(id) && !collectionEntries.has(id)) {
          usedEntryIds.add(id)
          return id
        }
      }
      throw new AppError(
        'MEDIA_ENGINE_ERROR',
        'The media engine could not generate a collection entry identifier.'
      )
    }

    const drafts = rawEntries.map((raw, position) =>
      buildPlaylistEntryDraft(raw, position, newEntryId())
    )

    const current = Math.floor(now())
    removeExpiredCollections(current)

    const previewId = newPreviewId()
    const expiresAt = current + ttlMs
    const availableCount = drafts.filter(
      (draft) => draft.dto.availability === 'available'
    ).length
    const dto = parseCollectionPreview({
      id: previewId,
      kind: 'playlist',
      title: cleanDisplayText(
        info.title ?? info.playlist_title,
        MAX_COLLECTION_TITLE_LENGTH,
        FALLBACK_COLLECTION_TITLE
      ),
      entryCount: drafts.length,
      availableCount,
      unavailableCount: drafts.length - availableCount,
      entries: drafts.map((draft) => draft.dto)
    })

    storeCollection({
      id: previewId,
      url: normalized,
      expiresAt,
      entryIds: drafts.map((draft) => draft.dto.id)
    })
    for (const draft of drafts) {
      collectionEntries.set(draft.dto.id, {
        previewId,
        position: draft.dto.position,
        url: draft.url,
        title: draft.dto.title,
        durationSeconds: draft.durationSeconds
      })
    }

    return dto
  }

  async function resolveCollectionEntries(
    previewId: string,
    entryIds: readonly string[]
  ): Promise<MediaCollectionTarget[]> {
    if (isClosing()) {
      throw new AppError(
        'MEDIA_COLLECTION_CANCELLED',
        'The playlist selection was cancelled.'
      )
    }

    const selection = parseCreateCollectionBatchInput({
      previewId,
      selectedEntryIds: entryIds
    })

    const current = Math.floor(now())
    const collection = collections.get(selection.previewId)
    if (!collection) {
      removeExpiredCollections(current)
      throw new AppError(
        'MEDIA_COLLECTION_NOT_FOUND',
        'Preview this playlist again before selecting entries.'
      )
    }
    if (collection.expiresAt <= current) {
      deleteCollection(selection.previewId)
      removeExpiredCollections(current)
      throw new AppError(
        'MEDIA_COLLECTION_EXPIRED',
        'This playlist preview has expired. Preview the playlist again.'
      )
    }
    removeExpiredCollections(current)

    const targets: MediaCollectionTarget[] = []
    const checkedHosts = new Map<string, Promise<void>>()
    for (const entryId of selection.selectedEntryIds) {
      const entry = collectionEntries.get(entryId)
      if (!entry || entry.previewId !== selection.previewId) {
        throw new AppError(
          'MEDIA_COLLECTION_ENTRY_INVALID',
          'The selected entry does not belong to this preview.'
        )
      }
      if (entry.url === null) {
        throw new AppError(
          'MEDIA_COLLECTION_ENTRY_UNAVAILABLE',
          'The selected entry is not available for download.'
        )
      }

      const host = new URL(entry.url).hostname.toLowerCase()
      let check = checkedHosts.get(host)
      if (!check) {
        check = assertPublicTarget(entry.url)
        checkedHosts.set(host, check)
      }
      await check

      targets.push({
        entryId,
        url: entry.url,
        title: entry.title,
        durationSeconds: entry.durationSeconds,
        position: entry.position
      })
    }

    return targets
  }

  return {
    analyze: analyzeCollection,
    resolveEntries: resolveCollectionEntries
  }
}
