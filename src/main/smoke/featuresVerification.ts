import type { MenuItemConstructorOptions } from 'electron'
import type { DownloadFolderChoice } from '@shared/downloadDestination'
import type { DesktopSettings } from '@shared/desktopSettings'
import { mkdirSync, copyFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CoreHost } from '../host'
import { AppError } from '../errors'
import {
  buildTrayMenuTemplate,
  clipboardUrlForMenu,
  canPauseAll,
  canResumeAll,
  trayStatusLine,
  type TrayDownloadLike,
  type TrayMediaJobLike,
  type TrayMenuActions,
  type TrayMenuState
} from '../trayMenu'
import type { DownloadDestinationStore } from '../downloads/destination'

/**
 * Isolated, opt-in hooks for `scripts/electron-features-verification.mjs`.
 *
 * The harness drives the real packaged renderer through CDP, but a few things
 * cannot be reached from a page: the native "Save to" dialog, the tray menu
 * (never created in smoke mode) and a Windows toast activation. This module
 * exposes those paths to the main-process inspector instead.
 *
 * Everything here is inert unless BOTH the existing smoke mode and the
 * explicit `DONDOWNLOAD_FEATURES_VERIFY=1` opt-in are present. A normal desktop
 * run therefore never defines the global, never records host calls and never
 * stubs a shell action. `tests/features-verification.test.ts` proves that.
 */

export const FEATURES_VERIFY_ENV = 'DONDOWNLOAD_FEATURES_VERIFY'
/**
 * User-data folder the harness seeds a v23 history database in before a
 * restart check; main copies it over the live database on the next launch.
 */
export const FEATURES_VERIFY_SEED_ENV = 'DONDOWNLOAD_FEATURES_VERIFY_SEED'
/** Name of the main-process global the harness evaluates against. */
export const FEATURES_VERIFY_GLOBAL = '__dondownloadFeaturesVerify'

export interface FeaturesVerificationGateInput {
  /** True only when the existing smoke configuration was accepted. */
  smokeEnabled: boolean
  env: NodeJS.ProcessEnv
}

/** The single gate: smoke mode plus the explicit features-verification opt-in. */
export function featuresVerificationEnabled(
  input: FeaturesVerificationGateInput
): boolean {
  return input.smokeEnabled && input.env[FEATURES_VERIFY_ENV] === '1'
}

/* ------------------------------------------------------------------------- *
 * Host call recorder
 * ------------------------------------------------------------------------- */

export interface HostCallRecord {
  method: 'openPath' | 'showItemInFolder'
  target: string
  at: number
}

export interface RecordingHost {
  host: CoreHost
  calls: readonly HostCallRecord[]
  clear: () => void
}

/**
 * Wrap the Electron host so "Open" and "Show in folder" are recorded instead
 * of reaching the shell. The renderer still goes through the real IPC →
 * DownloadManager → host path, so the recorded target is the exact path the
 * production code would have opened; only the final OS call is suppressed.
 */
export function createRecordingHost(
  inner: CoreHost,
  now: () => number = Date.now
): RecordingHost {
  const calls: HostCallRecord[] = []
  const host: CoreHost = {
    ...inner,
    // An empty string is Electron's "opened successfully" result.
    openPath: async (target: string) => {
      calls.push({ method: 'openPath', target, at: now() })
      return ''
    },
    showItemInFolder: (target: string) => {
      calls.push({ method: 'showItemInFolder', target, at: now() })
    }
  }
  return {
    host,
    calls,
    clear: () => {
      calls.length = 0
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Tray menu probe
 * ------------------------------------------------------------------------- */

export interface TrayMenuProbeItem {
  label: string
  type: string
  enabled: boolean
  checked: boolean | null
  /** True when the item has a click handler the probe can invoke. */
  clickable: boolean
  submenu: TrayMenuProbeItem[] | null
}

export interface TrayMenuProbeState {
  statusLine: string
  windowVisible: boolean
  canPauseAll: boolean
  canResumeAll: boolean
  speedLimitBps: number
  downloadCount: number
}

export interface TrayMenuProbeBuild {
  state: TrayMenuProbeState
  items: TrayMenuProbeItem[]
}

function submenuItems(
  submenu: MenuItemConstructorOptions['submenu']
): MenuItemConstructorOptions[] | null {
  if (submenu === undefined) return null
  if (Array.isArray(submenu)) return submenu
  return null
}

/** JSON-safe view of a native menu template, without any click closures. */
export function serializeMenuTemplate(
  template: readonly MenuItemConstructorOptions[]
): TrayMenuProbeItem[] {
  return template.map((item) => ({
    label: typeof item.label === 'string' ? item.label : '',
    type: item.type ?? (item.label === undefined ? 'separator' : 'normal'),
    enabled: item.enabled !== false,
    checked: typeof item.checked === 'boolean' ? item.checked : null,
    clickable: typeof item.click === 'function',
    submenu: (() => {
      const children = submenuItems(item.submenu)
      return children === null ? null : serializeMenuTemplate(children)
    })()
  }))
}

export interface TrayMenuProbePorts {
  windowVisible: () => boolean
  downloads: () => readonly TrayDownloadLike[]
  mediaJobs: () => readonly TrayMediaJobLike[]
  speedLimitBps: () => number
  /** Raw clipboard text; only read when the probe does not override it. */
  readClipboardText: () => string | Promise<string>
  actions: TrayMenuActions
}

/**
 * Builds the production tray template with live app state and keeps the last
 * template so one item's real click handler can be invoked by path.
 *
 * The template itself is built by `buildTrayMenuTemplate`, the same function
 * `src/main/tray.ts` calls when the menu is about to open; this class only
 * adds serialization and a way to press an item without popping up a native
 * menu on the user's desktop.
 */
export class TrayMenuProbe {
  private template: readonly MenuItemConstructorOptions[] = []

  constructor(private readonly ports: TrayMenuProbePorts) {}

  build(clipboardText?: string | null): TrayMenuProbeBuild {
    const rawClipboard =
      clipboardText === undefined
        ? this.ports.readClipboardText()
        : clipboardText
    // A promise-returning clipboard read disables "Add from clipboard" in the
    // real tray too; the probe mirrors that instead of awaiting.
    const clipboardUrl =
      typeof rawClipboard === 'string' ? clipboardUrlForMenu(rawClipboard) : null
    const state: TrayMenuState = {
      windowVisible: this.ports.windowVisible(),
      downloads: this.ports.downloads(),
      mediaJobs: this.ports.mediaJobs(),
      speedLimitBps: this.ports.speedLimitBps(),
      clipboardUrl
    }
    this.template = buildTrayMenuTemplate(state, this.ports.actions)
    return {
      state: {
        statusLine: trayStatusLine(state.downloads),
        windowVisible: state.windowVisible,
        canPauseAll: canPauseAll(state),
        canResumeAll: canResumeAll(state),
        speedLimitBps: state.speedLimitBps,
        downloadCount: state.downloads.length
      },
      items: serializeMenuTemplate(this.template)
    }
  }

  /** Press the item at `[top, child, grandchild…]` from the last build. */
  invoke(path: readonly number[]): {
    invoked: boolean
    label: string
    reason: string | null
  } {
    let items: readonly MenuItemConstructorOptions[] = this.template
    let item: MenuItemConstructorOptions | undefined
    for (const index of path) {
      item = items[index]
      if (item === undefined) {
        return { invoked: false, label: '', reason: 'item-not-found' }
      }
      items = submenuItems(item.submenu) ?? []
    }
    if (item === undefined) {
      return { invoked: false, label: '', reason: 'empty-path' }
    }
    const label = typeof item.label === 'string' ? item.label : ''
    if (item.enabled === false) {
      return { invoked: false, label, reason: 'disabled' }
    }
    if (typeof item.click !== 'function') {
      return { invoked: false, label, reason: 'not-clickable' }
    }
    // Electron passes (menuItem, window, event); the tray handlers in this app
    // ignore all three, so the probe can press the item without a native menu.
    ;(item.click as unknown as () => void)()
    return { invoked: true, label, reason: null }
  }
}

/* ------------------------------------------------------------------------- *
 * Installed hooks
 * ------------------------------------------------------------------------- */

export interface DestinationProbeResult {
  ok: boolean
  token: string | null
  path: string | null
  code: string | null
  message: string | null
}

export interface WindowProbeState {
  visible: boolean
  focused: boolean
  destroyed: boolean
  offscreen: boolean
}

export interface DuplicateProbeResult {
  url: string
  matched: boolean
  state: string | null
  filename: string | null
}

export interface HistoryProbeState {
  schemaVersion: number
  rows: number
  /** `findDuplicate` through the production database module, in order. */
  lookups: DuplicateProbeResult[]
}

export interface DesktopSettingsProbeState {
  before: DesktopSettings
  after: DesktopSettings
}

export interface FeaturesVerificationHooks {
  appVersion: string
  /** True only when this launch replaced history with the harness' seed file. */
  seededHistory: () => boolean
  /** Write the next launch's seed history at an older schema version. */
  writeSeededHistory: (request: {
    directory: string
    upTo?: number
    rows: readonly SeededDownloadRow[]
  }) => string
  /** Code of the history open failure for this launch, or null when it opened. */
  databaseErrorCode: () => string | null
  /** Shape of the live history: row count, creation times, MEGA-keyed rows. */
  historyRows: () => HistoryRowsReport
  tray: () => TrayMenuProbe
  /** Proves the harness window never appeared or took focus. */
  windowState: () => WindowProbeState
  registerDestination: (directory: unknown) => DestinationProbeResult
  resolveDestination: (token: unknown) => string | null
  /** Invoke the completion-toast activation callback with real arguments. */
  notificationActivate: (
    kind: 'download' | 'media',
    id: string,
    action: 'activate' | 'open' | 'show'
  ) => void
  /** Write one line through the production logger so redaction can be checked. */
  probeLog: (message: string) => void
  /**
   * Schema version, row count and duplicate lookups through the app's own
   * database. The harness seeds a v23 file and restarts, so this reads exactly
   * the database that launch upgraded to v24.
   */
  historyLookups: (urls: readonly unknown[]) => HistoryProbeState
  /** Split over `historyLookups` so a mismatch comes back as a report. */
  verifyHistory: (
    urls: readonly unknown[],
    expectations?: readonly HistoryLookupExpectation[],
    expectedRows?: number
  ) => HistoryLookupCheck
  hostCalls: () => readonly HostCallRecord[]
  clearHostCalls: () => void
}

export interface InstalledFeaturesVerification extends FeaturesVerificationHooks {
  enabled: true
}

export interface InstallFeaturesVerificationInput {
  enabled: boolean
  hooks: FeaturesVerificationHooks
  globalObject?: Record<string, unknown>
}

/**
 * Publish the hooks on the main-process global for the inspector.
 *
 * Returns false and touches nothing when not explicitly enabled, which is what
 * makes the whole module inert for a normal desktop run.
 */
export function installFeaturesVerification(
  input: InstallFeaturesVerificationInput
): boolean {
  if (!input.enabled) return false
  const target = input.globalObject ?? (globalThis as Record<string, unknown>)
  target[FEATURES_VERIFY_GLOBAL] = input.hooks
  return true
}

/** Build the register/resolve probes over the production token store. */
export function createDestinationProbe(
  store: DownloadDestinationStore
): Pick<FeaturesVerificationHooks, 'registerDestination' | 'resolveDestination'> {
  return {
    registerDestination: (directory: unknown): DestinationProbeResult => {
      try {
        if (typeof directory !== 'string') {
          throw new AppError(
            'DOWNLOAD_FOLDER_INVALID',
            'That download folder cannot be used.'
          )
        }
        const choice: DownloadFolderChoice = store.register(directory)
        return {
          ok: true,
          token: choice.token,
          path: choice.path,
          code: null,
          message: null
        }
      } catch (error) {
        return {
          ok: false,
          token: null,
          path: null,
          code:
            error instanceof AppError
              ? error.code
              : ((error as { code?: string }).code ?? 'DOWNLOAD_FOLDER_INVALID'),
          message: error instanceof Error ? error.message : 'unknown error'
        }
      }
    },
    resolveDestination: (token: unknown) => store.resolve(token)
  }
}

/* ------------------------------------------------------------------------- *
 * Stability-regression probes
 * ------------------------------------------------------------------------- */

/** The slice of the production history database these probes need. */
export interface HistoryProbeSource {
  readonly schemaVersion: number
  loadAll(): readonly unknown[]
  findDuplicate(normalizedUrl: string): {
    state: string
    filename: string
  } | null
}

export interface HistoryProbeInput {
  /** Normalized URLs to look up, in order. */
  urls: readonly unknown[]
  /** The app's live database (already migrated by this launch). */
  database: HistoryProbeSource
}

/**
 * Prove the duplicate lookup on the database this launch opened. The harness
 * seeds a v23 file before restarting, so opening it already ran the v24
 * migration; the lookups here then see exactly what the app's history uses.
 */
export function probeHistoryLookups(input: HistoryProbeInput): HistoryProbeState {
  const lookups: DuplicateProbeResult[] = []
  for (const url of input.urls) {
    if (typeof url !== 'string') {
      throw new AppError('VERIFY_INVALID', 'historyLookups expects URLs')
    }
    const found = input.database.findDuplicate(url)
    lookups.push({
      url,
      matched: found !== null,
      state: found?.state ?? null,
      filename: found?.filename ?? null
    })
  }
  return {
    schemaVersion: input.database.schemaVersion,
    rows: input.database.loadAll().length,
    lookups
  }
}

/**
 * Copy a harness-written history file over the live database before it is
 * opened, then delete the seed so it is used exactly once. Returns whether the
 * replacement happened. Only the harness can point this at a database: the
 * seed path comes from the features-verification env var, which is set only
 * for a smoke + feature-check run the harness started itself.
 */
export function applySeededHistory(seed: string, databasePath: string): boolean {
  let replaced = false
  try {
    copyFileSync(seed, databasePath)
    replaced = true
  } catch {
    replaced = false
  } finally {
    rmSync(seed, { force: true })
    if (replaced) {
      // A -wal/-shm left by the harness' own connection must not be replayed on
      // top of the replaced file.
      rmSync(`${databasePath}-wal`, { force: true })
      rmSync(`${databasePath}-shm`, { force: true })
    }
  }
  return replaced
}

/**
 * Whether this launch should copy a seeded history file. Only the harness sets
 * the env var, but an empty value must never mean "copy nothing" onto itself.
 */
export function shouldApplySeed(
  seed: string | undefined,
  databasePath: string
): seed is string {
  if (typeof seed !== 'string') return false
  const trimmed = seed.trim()
  if (trimmed.length === 0) return false
  return path.resolve(trimmed) !== path.resolve(databasePath)
}

/** Link the harness will look up in the seeded history, and what it means. */
export interface HistoryLookupExpectation {
  url: string
  matched: boolean
  filename?: string
}

export interface HistoryRowsReport {
  rows: number
  /** Creation time of each history row, oldest first (ids are not exposed). */
  createdAt: number[]
  /** Filenames of rows whose `normalized_url` kept a MEGA key fragment. */
  megaKeyed: string[]
}

const MEGA_KEY_PATTERN = /^https?:\/\/mega\.nz\/.*#/

/** Identify the seeded older rows in the live history without exposing ids. */
export function summarizeHistoryRows(
  rows: readonly { createdAt: number; url: string }[]
): HistoryRowsReport {
  return {
    rows: rows.length,
    createdAt: rows.map((row) => row.createdAt).sort((a, b) => a - b),
    // The app's own rows are normalized on save; only an upgraded row can still
    // carry a MEGA key from the seeded file, so this is migration evidence.
    megaKeyed: rows
      .filter((row) => MEGA_KEY_PATTERN.test(row.url))
      .map((row) => row.url)
  }
}

export interface HistoryLookupCheck {
  passed: boolean
  schemaVersion: number
  rows: number
  lookups: DuplicateProbeResult[]
  failures: string[]
}

/**
 * Evaluate `probeHistoryLookups` against expectations. Throwing inside a
 * CDP-evaluated hook would reach the harness as a bare Error, so each mismatch
 * is collected here instead and reported with its own reason.
 */
export function checkHistoryLookups(
  input: HistoryProbeInput,
  expectations: readonly HistoryLookupExpectation[] = [],
  expectedRows?: number
): HistoryLookupCheck {
  const result = probeHistoryLookups(input)
  const failures: string[] = []
  if (result.schemaVersion < 24) {
    failures.push(`schema stayed at v${result.schemaVersion}`)
  }
  if (expectedRows !== undefined && result.rows !== expectedRows) {
    failures.push(`expected ${expectedRows} history rows, found ${result.rows}`)
  }
  expectations.forEach((expected, index) => {
    const actual = result.lookups[index]
    if (actual === undefined) {
      failures.push(`${expected.url}: no lookup result`)
      return
    }
    if (actual.matched !== expected.matched) {
      failures.push(
        `${expected.url}: matched=${actual.matched}, expected ${expected.matched}`
      )
    }
    if (expected.filename !== undefined && actual.filename !== expected.filename) {
      failures.push(
        `${expected.url}: matched ${actual.filename}, expected ${expected.filename}`
      )
    }
  })
  return { passed: failures.length === 0, ...result, failures }
}

export interface SeededDownloadRow {
  id: string
  url: string
  filename: string
  /** `normalized_url` exactly as the older schema backfilled it. */
  normalizedUrl: string
  /** Distinct creation times keep the history list deterministic. */
  createdAt: number
}

/**
 * Write the harness' v23 history file with the production migrator, then add
 * the rows through plain SQL. Returns the path the next launch copies into
 * place (`FEATURES_VERIFY_SEED_ENV`), so the upgrade runs on real startup.
 */
export function writeSeedHistory(input: {
  seedPath: string
  upTo: number
  rows: readonly SeededDownloadRow[]
  buildAtVersion: (filePath: string, upTo: number) => void
}): string {
  rmSync(input.seedPath, { force: true })
  input.buildAtVersion(input.seedPath, input.upTo)
  const db = new DatabaseSync(input.seedPath)
  try {
    const insert = db.prepare(`
      INSERT INTO downloads (
        id, gid, url, filename, dir, status, total_bytes, completed_bytes,
        created_at, updated_at, completed_at, normalized_url
      ) VALUES (?, ?, ?, ?, ?, 'complete', 10, 10, ?, ?, ?, ?)
    `)
    input.rows.forEach((row, index) => {
      insert.run(
        row.id,
        `0123456789abcde${index}`,
        row.url,
        row.filename,
        'C:\\Downloads',
        row.createdAt,
        row.createdAt,
        row.createdAt,
        row.normalizedUrl
      )
    })
    db.exec(`PRAGMA user_version = ${input.upTo}`)
  } finally {
    db.close()
  }
  return input.seedPath
}

/** Seed path for a harness run that will write a v23 history file first. */
export function historySeedPath(directory: string): string {
  mkdirSync(directory, { recursive: true })
  return path.join(directory, 'seed-history.sqlite3')
}

export interface WelcomeGuideProbePorts {
  getSettings: () => DesktopSettings
  markWelcomeGuideSeen: () => DesktopSettings
}

/**
 * Snapshot, dismiss and snapshot again through the production settings
 * manager. The harness changes another preference between the two calls; only
 * `welcomeGuideSeen` may differ from the value it set.
 */
export function probeWelcomeGuideSeen(
  ports: WelcomeGuideProbePorts
): DesktopSettingsProbeState {
  const before = ports.getSettings()
  const after = ports.markWelcomeGuideSeen()
  return { before, after }
}
