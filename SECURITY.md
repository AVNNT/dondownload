# Security policy

## Supported versions

Security fixes are made for the current **1.3.x** release line. Older or forked
builds are not supported.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Report it privately through GitHub:

1. Open <https://github.com/AVNNT/dondownload/security>.
2. Choose the **Security** tab, then **Report a vulnerability**.
3. Describe the problem: affected version, Windows version, the browser and
   extension version if relevant, the steps to reproduce, and what an attacker
   could achieve.

Private vulnerability reporting is the only supported channel; please do not
publish details until a fix is available.

## What to expect

- An acknowledgement that the report was received.
- An assessment of severity and, if it is accepted, a fix in a following 1.3.x
  release with credit to the reporter unless you ask otherwise.
- A coordinated disclosure timeline agreed with you.

## Scope notes

Useful context when judging a report:

- Release builds are not code-signed yet, so Windows SmartScreen warns about an
  unknown publisher. That warning is expected; a *signed* installer claiming to
  be signed is not.
- The desktop app only talks to the browser extension over a loopback
  (`127.0.0.1`) HTTP bridge with a random port and a per-launch bearer token.
- The installer registers a native messaging host for the current Windows user
  only.
- Reports about third-party programs bundled with the installer (aria2, yt-dlp,
  FFmpeg) should go upstream; see [third-party/NOTICE.md](third-party/NOTICE.md).
