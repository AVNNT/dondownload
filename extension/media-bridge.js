// Service-worker authorization for media messages from the optional overlay.
//
// The content script never supplies a page URL. This module derives it from the
// trusted sender.tab.url, proves the sender is our own top-frame content script
// on the exact registered/opted-in origin, re-checks the grant immediately
// before every native call, and only then forwards opaque analysis/option IDs.

import { sendAnalyzeMedia, sendQueueMedia } from './bridge.js'
import { isMediaOutputFormat, isOpaqueMediaId } from './media-contract.js'
import { isOverlayTabTracked } from './overlay-controller.js'
import {
  originToMatchPattern,
  overlayOriginFromRegistration,
  overlayRegistrationForOrigin,
  parseSupportedPageUrl
} from './site-policy.js'

export const MEDIA_MESSAGE_TYPES = Object.freeze({
  ANALYZE: 'dondownload:media-analyze',
  QUEUE: 'dondownload:media-queue'
})

function failure(code, message) {
  return { ok: false, error: { code, message } }
}

function hasExactKeys(record, required, optional = []) {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return false
  }
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) return false
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return false
  }
  return true
}

function invalidSender() {
  return failure(
    'INVALID_SENDER',
    'The request did not come from this extension on an opted-in page.'
  )
}

/**
 * Authorize one content-script media message. The final grant check is the last
 * asynchronous step, so it is the immediate predecessor of the native call.
 */
export async function authorizeMediaSender(chromeApi, sender) {
  if (!sender || !chromeApi || !chromeApi.runtime) return invalidSender()
  if (
    typeof chromeApi.runtime.id !== 'string' ||
    sender.id !== chromeApi.runtime.id
  ) {
    return invalidSender()
  }

  const tab = sender.tab
  if (!tab || !Number.isInteger(tab.id) || tab.id < 0) return invalidSender()
  if (sender.frameId !== 0) return invalidSender()

  const senderPage = parseSupportedPageUrl(sender.url)
  const tabPage = parseSupportedPageUrl(tab.url)
  if (!senderPage || !tabPage) return invalidSender()
  if (senderPage.origin !== tabPage.origin) {
    return failure('ORIGIN_MISMATCH', 'The page origin did not match the sender.')
  }

  const origin = tabPage.origin
  const pattern = originToMatchPattern(origin)
  const registration = overlayRegistrationForOrigin(origin)
  if (pattern === null || registration === null) {
    return failure('INVALID_ORIGIN', 'The page origin is not supported.')
  }

  let registered = false
  try {
    const stored = await chromeApi.scripting.getRegisteredContentScripts({
      ids: [registration.id]
    })
    registered =
      Array.isArray(stored) &&
      stored.length === 1 &&
      overlayOriginFromRegistration(stored[0]) === origin
  } catch {
    registered = false
  }
  if (!registered) {
    return failure(
      'OVERLAY_NOT_REGISTERED',
      'The overlay is not registered for this site. Reload the page and try again.'
    )
  }

  let tracked = false
  try {
    tracked = await isOverlayTabTracked(chromeApi, origin, tab.id)
  } catch {
    tracked = false
  }
  if (!tracked) {
    return failure(
      'TAB_NOT_ASSOCIATED',
      'This tab is not associated with an active overlay. Reload the page and try again.'
    )
  }

  let granted = false
  try {
    granted =
      (await chromeApi.permissions.contains({ origins: [pattern] })) === true
  } catch {
    granted = false
  }
  if (!granted) {
    return failure(
      'PERMISSION_REQUIRED',
      'Site access is not granted for this page. Enable the overlay again.'
    )
  }

  return { ok: true, origin, tabId: tab.id, url: tabPage.url }
}

/** Analyze the trusted sender tab URL. The content message carries no URL. */
export async function analyzeMediaForSender(chromeApi, message, sender) {
  if (
    !message ||
    message.type !== MEDIA_MESSAGE_TYPES.ANALYZE ||
    !hasExactKeys(message, ['type'])
  ) {
    return failure('INVALID_MESSAGE', 'The media analyze request is not valid.')
  }

  const authorization = await authorizeMediaSender(chromeApi, sender)
  if (authorization.ok !== true) return authorization

  const result = await sendAnalyzeMedia(authorization.url)
  if (result.ok !== true) return result
  return { ok: true, analysis: result.analysis }
}

/** Queue one opaque analysis/option pair for the trusted sender tab. */
export async function queueMediaForSender(chromeApi, message, sender) {
  if (
    !message ||
    message.type !== MEDIA_MESSAGE_TYPES.QUEUE ||
    !hasExactKeys(message, ['type', 'analysisId', 'optionId'], ['outputFormat'])
  ) {
    return failure('INVALID_MESSAGE', 'The media queue request is not valid.')
  }
  if (
    !isOpaqueMediaId(message.analysisId) ||
    !isOpaqueMediaId(message.optionId)
  ) {
    return failure(
      'INVALID_MEDIA_OPTION',
      'The selected media option is not valid. Analyze the page again.'
    )
  }
  if (
    message.outputFormat !== undefined &&
    !isMediaOutputFormat(message.outputFormat)
  ) {
    return failure(
      'INVALID_MEDIA_OPTION',
      'The selected output format is not valid.'
    )
  }

  const authorization = await authorizeMediaSender(chromeApi, sender)
  if (authorization.ok !== true) return authorization

  const result = await sendQueueMedia({
    analysisId: message.analysisId,
    optionId: message.optionId,
    ...(message.outputFormat === undefined
      ? {}
      : { outputFormat: message.outputFormat })
  })
  if (result.ok !== true) return result
  return { ok: true, job: result.job }
}
