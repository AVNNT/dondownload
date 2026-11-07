# Smart Link Scanner: Gofile share links through the user's own tab

Status: implementation note. No live-site test was run against a real share.
Nothing is pushed.

A `https://gofile.io/d/<id>` page is a JavaScript application. Its file list only
exists after the user's signed-in browser rendered it, and its download URLs
(`https://store<N>.gofile.io/download/...`) need the `accountToken` cookie that
browser already holds. DonDownload therefore never scrapes Gofile, never calls
`api.gofile.io`, never reads `localStorage` tokens and never creates a guest
account. The share is a browser-only card; the extension reads the rendered rows
from the user's own tab.

## 1. A share link is a browser-only card

- `parseGofileShareUrl` (`src/shared/gofile.ts`) accepts only
  `https://gofile.io/d/<id>` (or `www`), with no credentials, query or fragment.
  `src/main/scanner/gofile.ts` normalizes it to the canonical link.
- `addCandidate` stores such an item as `kind: 'page-link'`, `category: 'other'`,
  `status: 'browser-only'` with the fixed reason `GOFILE_BROWSER_ONLY_REASON`. It
  is not queueable and cannot be marked as a video, exactly like the existing
  browser-only video cards (`smart-link-scanner-browser-only.md`).
- The card's action is **Open in browser to list files**
  (`GOFILE_OPEN_IN_BROWSER_ACTION`) and reuses the existing `scan:open-in-browser`
  channel: opaque IDs only, main resolves the stored URL, re-validates it as the
  canonical public share link and calls `shell.openExternal`. The renderer never
  receives a URL.
- The status chip reads "Needs your browser".

## 2. The extension reads the rendered list

- Entry point is the normal extension scan (`extension/popup.js` →
  `scanGofilePage()` → background `dondownload:gofile-scan` →
  `extension/gofile-scan.js`). `welcome.js` resumes a pending Gofile scan after
  the welcome page closes.
- `extension/gofile-collector.js` is injected as a classic isolated-world script
  (no main-world injection). It waits up to `GOFILE_LIST_WAIT_MS` (15 s) for the
  rendered rows using a `MutationObserver` plus a bounded poll, then reads name,
  size text and the `href` of each row's download link.
- Only `https` hrefs on `gofile.io` / `*.gofile.io` whose path starts with
  `/download/` are accepted. Rendered subfolder links inside the same share are
  followed at most `MAX_GOFILE_DEPTH` (2) deep, with at most
  `MAX_GOFILE_FILES` (500) files per share.
- The share state is reported as `ok`, `empty`, `not-found`, `password`,
  `premium` or `timeout`. Password-protected, premium-only, removed and
  non-rendering shares produce a visible card with a fixed reason and no bypass
  attempt.
- The result is posted through the existing scan bridge as a `scan-gofile`
  message carrying the share id, the status, the rows and — only when the user
  granted the per-site prompt — the one-shot `gofile.io` cookie.

## 3. App side: real file cards, normal pairing

- `ScanSession.startGofile` (main) converts the rows into ordinary file items, so
  they classify by name: videos pair with `.funscript` files from the rest of the
  session through the existing script-set logic.
- If a session already holds a card for that share (typically the forum-topic
  scan the link came from), the rows merge into that session and the share card
  becomes the listed share. Otherwise a new session with mode `gofile` is
  created. An `ok` result with no rows, or any error status, leaves a single
  unavailable card with the reason.
- `src/main/scanner/queue.ts` queues Gofile rows like the Pixeldrain/MEGA
  provider targets: no queue-time probe, the validated download URL is passed as
  the resolved URL.

## 4. Cookie scoping

- The `accountToken` cookie is read for `gofile.io` only, through the existing
  per-site opt-in + one-time Chrome permission prompt
  (`readOptInCookieHeader`). No install-time all-sites access, no per-site
  toggle, nothing stored.
- Because downloads are served by `store<N>.gofile.io`, the session keeps the
  cookie in its own `gofileCookie` slot. `cookieFor()` returns it only for a
  Gofile-family host (`gofileCookieApplies`), so it can never be sent to another
  site or a lookalike domain. `DownloadManager`'s exact-host check is unchanged:
  the queue passes the same URL as `resolvedUrl`, so no preflight redirect can
  move the request to a host the cookie was not scoped for.
- The cookie lives in memory only, is never written to a download record and is
  never logged.

## 5. Tests

`tests/extension-gofile-collector.test.ts` drives the collector against fixture
HTML in a fake DOM (`vm`): slow render, empty share, password prompt, timeout,
foreign href rejection, depth-2 recursion and the 500-file cap.
`tests/gofile-scan.test.ts` covers the shared policy, the bridge contract
(foreign download hosts, oversize payloads, unknown keys), app-side conversion,
merging and pairing, queue-time cookie attachment, and `runGofileScan` with a
fake `chrome` API. No live network is used.

## Limits

- A share can only be listed while the user's tab renders it; a share behind a
  password, a premium account or a removed share stays a card with a reason.
- The extractor reads what the page shows. A share the site itself paginates or
  virtualizes may report fewer rows than it contains.
- Downloads still depend on the `accountToken` cookie being valid; an expired
  session fails the download visibly instead of being retried with a new token.
