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

A development checkout does not bundle the third-party tools. Install aria2
(for example `winget install aria2.aria2`) or set `DONDOWNLOAD_ARIA2_PATH`.
yt-dlp and FFmpeg are only needed for media downloads and can be located with
`DONDOWNLOAD_YTDLP_PATH` and `DONDOWNLOAD_FFMPEG_PATH`.

Other useful scripts, all defined in `package.json`:

| Script | What it does |
| --- | --- |
| `npm run dev` | Electron app with the dev server |
| `npm run build` | typecheck + production build |
| `npm run build:native-host` | compile `native/dondownload-native-host.exe` |
| `npm run build:tray-stub` | compile `native/dondownload-tray.exe` |
| `npm run build:installer` | full Windows x64 NSIS installer in `dist/` |
| `npm start` | run an existing production build |
| `npm test` | full Vitest suite |
| `npm run bench` | performance benchmarks |

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
`windows-latest`.

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
