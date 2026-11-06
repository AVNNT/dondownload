/**
 * Small, bounded robots.txt parser and per-session cache.
 *
 * Only pages the scanner follows on its own are checked; the user's pasted URL
 * is always fetched. A missing, unreachable or oversized robots.txt is treated
 * as "allow", which is the conventional fail-open behaviour for a scanner that
 * already enforces its own public-target and page limits.
 */

export const MAX_ROBOTS_BYTES = 64 * 1024
export const SCANNER_ROBOTS_USER_AGENT = 'DonDownload'

export interface RobotsRule {
  allow: boolean
  pattern: string
}

export interface RobotsGroup {
  agents: string[]
  rules: RobotsRule[]
}

export interface RobotsRules {
  groups: RobotsGroup[]
}

function parsePattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  const suffix = pattern.endsWith('$') ? '$' : ''
  return new RegExp(`^${escaped.replace(/\\\$$/, '')}${suffix}`)
}

export function parseRobots(text: string): RobotsRules {
  const groups: RobotsGroup[] = []
  let current: RobotsGroup | null = null
  let lastWasAgent = false

  const bounded = text.slice(0, MAX_ROBOTS_BYTES)
  for (const rawLine of bounded.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (line.length === 0) {
      lastWasAgent = false
      continue
    }
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const field = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()

    if (field === 'user-agent') {
      if (current === null || !lastWasAgent) {
        current = { agents: [], rules: [] }
        groups.push(current)
      }
      const agent = value.toLowerCase()
      if (agent.length > 0 && current.agents.length < 64) {
        current.agents.push(agent)
      }
      lastWasAgent = true
      continue
    }

    lastWasAgent = false
    if (current === null) continue
    if (field !== 'allow' && field !== 'disallow') continue
    if (value.length === 0) {
      // `Disallow:` (empty) allows everything and carries no rule.
      continue
    }
    if (current.rules.length >= 512) continue
    current.rules.push({ allow: field === 'allow', pattern: value })
  }

  return { groups }
}

function appliesToGroup(group: RobotsGroup, userAgent: string): boolean {
  const agent = userAgent.toLowerCase()
  for (const candidate of group.agents) {
    if (candidate === '*') return true
    if (candidate.length > 0 && agent.includes(candidate)) return true
  }
  return false
}

/** Longest matching rule wins; an equal-length Allow wins. */
export function isRobotsAllowed(
  rules: RobotsRules,
  path: string,
  userAgent = SCANNER_ROBOTS_USER_AGENT
): boolean {
  let matching: RobotsGroup[] = rules.groups.filter(
    (group) =>
      appliesToGroup(group, userAgent) &&
      group.agents.some((agent) => agent !== '*')
  )
  if (matching.length === 0) {
    matching = rules.groups.filter((group) => group.agents.includes('*'))
  }
  if (matching.length === 0) return true

  const target = path.startsWith('/') ? path : `/${path}`
  let best: { length: number; allow: boolean } | null = null
  for (const group of matching) {
    for (const rule of group.rules) {
      let expression: RegExp
      try {
        expression = parsePattern(rule.pattern)
      } catch {
        continue
      }
      if (!expression.test(target)) continue
      const length = rule.pattern.length
      if (
        best === null ||
        length > best.length ||
        (length === best.length && rule.allow && !best.allow)
      ) {
        best = { length, allow: rule.allow }
      }
    }
  }
  return best === null ? true : best.allow
}

export interface ScanRobotsCacheOptions {
  /** Fetch one robots.txt URL. Errors are treated as "allow". */
  fetchRobots: (url: string, signal?: AbortSignal) => Promise<string | null>
  userAgent?: string
}

/**
 * Cache robots rules per origin for one scan session. Concurrent checks for the
 * same host share one fetch; duplicate rules never grow without bound.
 */
export class ScanRobotsCache {
  private readonly fetchRobots: ScanRobotsCacheOptions['fetchRobots']
  private readonly userAgent: string
  private readonly cache = new Map<string, Promise<RobotsRules | null>>()

  constructor(options: ScanRobotsCacheOptions) {
    this.fetchRobots = options.fetchRobots
    this.userAgent = options.userAgent ?? SCANNER_ROBOTS_USER_AGENT
  }

  allows(url: string, signal?: AbortSignal): Promise<boolean> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return Promise.resolve(false)
    }
    const origin = `${parsed.protocol}//${parsed.host}`
    let pending = this.cache.get(origin)
    if (pending === undefined) {
      pending = this.fetchRobots(`${origin}/robots.txt`, signal)
        .then((text) => (typeof text === 'string' ? parseRobots(text) : null))
        .catch(() => null)
      this.cache.set(origin, pending)
    }
    return pending.then((rules) => {
      if (rules === null) return true
      return isRobotsAllowed(
        rules,
        `${parsed.pathname}${parsed.search}`,
        this.userAgent
      )
    })
  }

  get size(): number {
    return this.cache.size
  }
}
