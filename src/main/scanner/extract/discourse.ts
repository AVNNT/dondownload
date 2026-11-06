import { extractCandidates, type ExtractedCandidate } from './index'
import { normalizeScanUrl } from './url'
import { MAX_SCAN_OTHER_LINKS } from '@shared/scanner'
import { extractFollowCandidates, isForumNavigationUrl } from '../follow'

/**
 * Discourse adapter.
 *
 * A rendered topic page contains only the first ~20 posts. The public JSON API
 * exposes the complete post stream, so every post's `cooked` HTML is extracted
 * with the same pure extractor as a normal page. No credentials are invented:
 * the Cookie, when the user opted in for this exact host, comes from the
 * extension through the one-job native-bridge path.
 */

export interface DiscourseFetchResult {
  body: string
  finalUrl: string
}

export type DiscourseFetcher = (
  url: string,
  accept: 'json' | 'html',
  signal?: AbortSignal
) => Promise<DiscourseFetchResult>

export interface TaggedCandidate extends ExtractedCandidate {
  postNumber: number | null
  author: string | null
}

/** A plain page link inside a post, offered as "This is a video". */
export interface DiscoursePageLink {
  url: string
  nameHint: string | null
  postNumber: number | null
  author: string | null
}

export interface DiscourseScanResult {
  detected: boolean
  title: string | null
  candidates: TaggedCandidate[]
  pageLinks: DiscoursePageLink[]
  pagesFetched: number
  limited: boolean
}

export const MAX_DISCOURSE_POSTS = 2000
const MAX_DISCOURSE_CANDIDATES = 5000
const MAX_DISCOURSE_COOKED_BYTES = 16 * 1024 * 1024
const POSTS_PER_CHUNK = 20
const MAX_POST_CHUNKS = 100
const MAX_POSTS_RESPONSE_BYTES = 4 * 1024 * 1024

interface RawPost {
  id: number | null
  post_number: number
  username: string | null
  cooked: string
}

interface RawTopic {
  id: number | null
  title: string | null
  slug: string | null
  stream: number[]
  posts: RawPost[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function safeAuthor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the security intent
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0) return null
  return Array.from(cleaned).slice(0, 80).join('')
}

function readPost(value: unknown): RawPost | null {
  const record = asRecord(value)
  if (record === null) return null
  const cooked = record.cooked
  const postNumber = record.post_number
  if (
    typeof cooked !== 'string' ||
    typeof postNumber !== 'number' ||
    !Number.isSafeInteger(postNumber) ||
    postNumber < 1
  ) {
    return null
  }
  return {
    id:
      typeof record.id === 'number' && Number.isSafeInteger(record.id)
        ? record.id
        : null,
    post_number: postNumber,
    username: safeAuthor(record.username),
    // Bound each post before the parser sees it. A malicious forum cannot
    // consume unbounded memory through one cooked post.
    cooked: cooked.slice(0, 512 * 1024)
  }
}

function readTopic(value: unknown): RawTopic | null {
  const record = asRecord(value)
  if (record === null) return null
  const postStream = asRecord(record.post_stream)
  const rawPosts = postStream?.posts
  const posts = Array.isArray(rawPosts)
    ? rawPosts.map(readPost).filter((post): post is RawPost => post !== null)
    : []
  const stream = Array.isArray(postStream?.stream)
    ? postStream.stream.filter(
        (entry): entry is number =>
          typeof entry === 'number' &&
          Number.isSafeInteger(entry) &&
          entry > 0
      )
    : []
  return {
    id:
      typeof record.id === 'number' && Number.isSafeInteger(record.id)
        ? record.id
        : null,
    title: typeof record.title === 'string' ? record.title : null,
    slug: typeof record.slug === 'string' ? record.slug : null,
    stream,
    posts
  }
}

function topicIdFromUrl(value: string): number | null {
  try {
    const path = new URL(value).pathname
    const match = /\/t\/(?:[^/]+\/)?(\d{1,12})(?:\/|$|\?)/.exec(path)
    if (!match) return null
    const id = Number(match[1])
    return Number.isSafeInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

export function isDiscourseTopicUrl(value: string): boolean {
  return topicIdFromUrl(value) !== null
}

/**
 * Detect the standard Discourse generator meta tag without building a DOM.
 * Attribute order and quoting variations are both accepted.
 */
export function hasDiscourseGenerator(html: string): boolean {
  const sample = html.slice(0, 512 * 1024)
  const forward =
    /<meta\b[^>]*\bname\s*=\s*["']generator["'][^>]*\bcontent\s*=\s*["'][^"']*Discourse[^"']*["']/i
  const reverse =
    /<meta\b[^>]*\bcontent\s*=\s*["'][^"']*Discourse[^"']*["'][^>]*\bname\s*=\s*["']generator["']/i
  return forward.test(sample) || reverse.test(sample)
}

function parseJsonDocument(body: string): unknown {
  if (body.length > MAX_POSTS_RESPONSE_BYTES) return null
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  worker: (value: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(values.length)
  let cursor = 0
  const runners = Array.from(
    { length: Math.min(limit, Math.max(1, values.length)) },
    async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= values.length) return
        results[index] = await worker(values[index]!)
      }
    }
  )
  await Promise.all(runners)
  return results
}

function postPageUrl(
  pageUrl: string,
  slug: string | null,
  topicId: number,
  postNumber: number
): string {
  try {
    const url = new URL(pageUrl)
    const base = `https://${url.host}`
    return `${base}/t/${slug ?? 'topic'}/${topicId}/${postNumber}`
  } catch {
    return pageUrl
  }
}

/**
 * Scan a Discourse topic. `html` is the already fetched topic page. When the
 * path looks like a topic but the rendered HTML has no generator tag, the
 * adapter tries the API only if the caller explicitly asks (`allowApiProbe`).
 */
export async function scanDiscourseTopic(
  options: {
    pageUrl: string
    html: string
    fetcher: DiscourseFetcher
    signal?: AbortSignal
    allowApiProbe?: boolean
  }
): Promise<DiscourseScanResult> {
  const detectedByHtml = hasDiscourseGenerator(options.html)
  const topicId = topicIdFromUrl(options.pageUrl)
  if (
    !detectedByHtml &&
    (topicId === null || options.allowApiProbe !== true)
  ) {
    return {
      detected: false,
      title: null,
      candidates: [],
      pageLinks: [],
      pagesFetched: 0,
      limited: false
    }
  }
  if (topicId === null) {
    return {
      detected: detectedByHtml,
      title: null,
      candidates: [],
      pageLinks: [],
      pagesFetched: 0,
      limited: false
    }
  }

  let origin = ''
  try {
    const parsed = new URL(options.pageUrl)
    origin = `${parsed.protocol}//${parsed.host}`
  } catch {
    throw new Error('The topic URL is not valid.')
  }

  const topicUrl = `${origin}/t/${topicId}.json`
  const topicResponse = await options.fetcher(topicUrl, 'json', options.signal)
  const topic = readTopic(parseJsonDocument(topicResponse.body))
  if (topic === null) {
    return {
      detected: true,
      title: null,
      candidates: [],
      pageLinks: [],
      pagesFetched: 1,
      limited: false
    }
  }

  const postsByNumber = new Map<number, RawPost>()
  let cookedBytes = 0
  let storageLimited = false
  for (const post of topic.posts) {
    if (postsByNumber.size >= MAX_DISCOURSE_POSTS) break
    if (cookedBytes + post.cooked.length > MAX_DISCOURSE_COOKED_BYTES) {
      storageLimited = true
      break
    }
    cookedBytes += post.cooked.length
    postsByNumber.set(post.post_number, post)
  }

  const stream = topic.stream.slice(0, MAX_DISCOURSE_POSTS)
  const missing = stream.filter((id) => id > 0 && !topic.posts.some((post) => post.id === id))
  const chunks: number[][] = []
  for (let index = 0; index < missing.length; index += POSTS_PER_CHUNK) {
    chunks.push(missing.slice(index, index + POSTS_PER_CHUNK))
  }

  let pagesFetched = 1
  await mapWithConcurrency(
    chunks.slice(0, MAX_POST_CHUNKS),
    2,
    async (chunk) => {
      if (options.signal?.aborted === true) return
      const query = new URLSearchParams()
      for (const id of chunk) query.append('post_ids[]', String(id))
      const response = await options.fetcher(
        `${origin}/t/${topicId}/posts.json?${query.toString()}`,
        'json',
        options.signal
      )
      pagesFetched += 1
      const parsed = asRecord(parseJsonDocument(response.body))
      const postStream = asRecord(parsed?.post_stream)
      const rawPosts = postStream?.posts
      if (!Array.isArray(rawPosts)) return
      for (const raw of rawPosts) {
        const post = readPost(raw)
        if (post === null) continue
        if (postsByNumber.size >= MAX_DISCOURSE_POSTS) break
        if (cookedBytes + post.cooked.length > MAX_DISCOURSE_COOKED_BYTES) {
          storageLimited = true
          break
        }
        cookedBytes += post.cooked.length
        postsByNumber.set(post.post_number, post)
      }
    }
  )

  const ordered = [...postsByNumber.values()].sort(
    (left, right) => left.post_number - right.post_number
  )
  const candidates: TaggedCandidate[] = []
  const pageLinks: DiscoursePageLink[] = []
  const forumHost = (() => {
    try {
      return new URL(options.pageUrl).hostname
    } catch {
      return ''
    }
  })()
  let candidateLimited = false
  for (const post of ordered) {
    if (options.signal?.aborted === true) break
    if (candidates.length >= MAX_DISCOURSE_CANDIDATES) {
      candidateLimited = true
      break
    }
    const pageUrl = postPageUrl(
      options.pageUrl,
      topic.slug,
      topicId,
      post.post_number
    )
    const base = (() => {
      try {
        return normalizeScanUrl(pageUrl)
      } catch {
        return options.pageUrl
      }
    })()
    const extracted = extractCandidates(post.cooked, base, {
      maxCandidates: 500
    })
    const discovered = new Set(extracted.map((candidate) => candidate.url))
    for (const candidate of extracted) {
      if (candidates.length >= MAX_DISCOURSE_CANDIDATES) {
        candidateLimited = true
        break
      }
      candidates.push({
        ...candidate,
        postNumber: post.post_number,
        author: post.username
      })
    }
    // Plain page links are not file candidates, but the user may still know
    // one is a video page. Keep a small, post-content-only list for that.
    if (!candidateLimited && pageLinks.length < MAX_SCAN_OTHER_LINKS) {
      for (const link of extractFollowCandidates(post.cooked, base, {
        maxCandidates: 200
      })) {
        if (pageLinks.length >= MAX_SCAN_OTHER_LINKS) break
        if (link.isEmbed || discovered.has(link.url)) continue
        if (isForumNavigationUrl(link.url, forumHost)) continue
        try {
          if (new URL(link.url).pathname === '/') continue
        } catch {
          continue
        }
        pageLinks.push({
          url: link.url,
          nameHint: link.nameHint,
          postNumber: post.post_number,
          author: post.username
        })
      }
    }
    if (candidateLimited) break
  }

  return {
    detected: true,
    title: topic.title,
    candidates,
    pageLinks,
    pagesFetched,
    limited:
      candidateLimited ||
      storageLimited ||
      (topic.stream.length >= MAX_DISCOURSE_POSTS && topic.stream.length > 0) ||
      chunks.length > MAX_POST_CHUNKS
  }
}
