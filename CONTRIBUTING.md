# Contributing to DonDownload

Thanks for helping out. Bug reports and pull requests are welcome.

## Before you start

- Check the existing issues and pull requests first.
- For a security problem, follow [SECURITY.md](SECURITY.md) instead of opening
  an issue.
- For a large change (new subsystem, new dependency, new network access, a
  change to the extension permissions), open an issue to agree on the approach
  before writing code.

## Development setup

Requirements: Windows 10/11 x64, Node.js 24+ and npm 10+. Building the native
messaging host or the installer also needs the .NET Framework 4.x C# compiler
(`csc.exe`), which ships with Windows.

```powershell
git clone https://github.com/AVNNT/dondownload.git
cd dondownload
npm ci
npm run dev
```

A development checkout does not bundle the third-party tools. Running the app
needs aria2 at runtime (for example `winget install aria2.aria2`) or
`DONDOWNLOAD_ARIA2_PATH`; yt-dlp and FFmpeg are only needed for media downloads
and can be located with `DONDOWNLOAD_YTDLP_PATH` and `DONDOWNLOAD_FFMPEG_PATH`.
Building the installer does not need any of them installed: `npm run
build:installer` downloads the pinned, SHA-256 verified aria2, yt-dlp and FFmpeg
release archives from their official upstream URLs into
`%LOCALAPPDATA%\DonDownload\vendor` (or reuses that cache).

Other useful scripts, all defined in `package.json`:

| Script | What it does |
| --- | --- |
| `npm run dev` | Electron app with the dev server |
| `npm run build` | typecheck + production build |
| `npm run build:native-host` | compile `native/dondownload-native-host.exe` |
| `npm run build:tray-stub` | compile `native/dondownload-tray.exe` |
| `npm run stage:vendor` | stage the pinned third-party executables into `build/vendor` |
| `npm run build:installer` | full Windows x64 NSIS installer in `dist/` |
| `npm start` | run an existing production build |
| `npm test` | full Vitest suite |
| `npm run bench` | performance benchmarks |

## Build your own

Any checkout builds the installer without a maintainer machine and without an
update signing key:

```powershell
npm ci
npm run build:installer
```

The installer is written to `dist/DonDownload-<version>-x64-setup.exe`. The
first build downloads about 140 MB of pinned vendor archives and verifies each
SHA-256; later builds reuse the cache. Nothing is uploaded anywhere.

A plain local build keeps the official update source compiled in
(`AVNNT/dondownload` plus its public key), so it only accepts official
DonDownload releases; for a fork that means the updater is effectively unused.
To build your own release channel:

1. Generate a key pair outside the repository:
   `node scripts/generate-update-signing-key.mjs "$env:USERPROFILE\.dondownload-release\update-signing-key.pem"`.
2. In `src/shared/release.ts` set `UPDATE_REPO` to your `{ owner, repo }` and
   `UPDATE_SIGNING_PUBLIC_KEY` to the printed public key, then rebuild.
3. Add the private key (PKCS#8 PEM text) as the `UPDATE_SIGNING_KEY` Actions
   secret. The release job also signs the Firefox xpi with Mozilla and reads
   `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` (addons.mozilla.org API key and
   secret); without them it fails instead of shipping an unsigned extension.
   Forks without AMO access can pass `--skip-amo` to the release command to
   ship the unsigned xpi on purpose. Pushing a `v<version>` tag then builds and
   drafts a release in your fork, exactly like the maintainer flow.
4. To ship a build with the updater disabled instead, set `UPDATE_REPO` to
   `null`. The updater then makes no network request and needs no key.

Never commit a private key, and do not reuse the official public key with a
different repository: the updater would reject every release anyway. See
[docs/release-readiness.md](docs/release-readiness.md) for the full maintainer
release flow.

## Checks before you open a PR

Run all four and make sure they pass:

```powershell
npm run typecheck
npm run lint
npm run test:fast
npm run test:extension
```

`npm run test:fast` is the hermetic unit/component tier; it needs no network, no
Electron launch and no aria2 binary. `npm run test:extension` covers the browser
extension. The full suite (`npm test`) and the native-host/aria2 integration
tests (`npm run test:integration`) are run in CI and by maintainers; run them
too when you touched those areas. See
[docs/testing-workflow.md](docs/testing-workflow.md) for tiers, focused filters
and the no-desktop-input rule.

CI runs lint, typecheck, the full test suite and the production build on
`windows-latest`. Pushing a `v<version>` tag starts the separate release
workflow, which builds, signs and drafts a GitHub release; see
[docs/release-readiness.md](docs/release-readiness.md).

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), as the
existing history does: `feat(extension): …`, `fix(tray): …`, `perf(main): …`,
`docs: …`, `refactor(core): …`, `test: …`, `chore: …`. Keep the subject in the
imperative mood and describe the user-visible effect.

## Pull requests

- Keep a PR focused; separate refactors from behaviour changes.
- Explain *why* in the description, and mention the checks you ran.
- Update the docs when behaviour, settings, permissions or troubleshooting
  steps change (`README.md` for users, `docs/` for implementation notes).
- Add or update tests for new behaviour.
- Do not commit `out/`, `dist/`, `build/vendor/` (all git-ignored), the compiled
  `native/*.exe` files, or any signing key.

## License

By contributing you agree that your changes are licensed under the
[MIT License](LICENSE), the same license as the rest of the project.
