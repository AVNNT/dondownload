# Performance benchmarks

`npm run bench` builds the current source, runs four benchmarks and writes a
machine-readable baseline to `bench/results/latest.json`. It also prints a
compact table:

```powershell
npm run bench
```

The command is Windows-friendly: the orchestrator is `bench/run.mjs` (Node) and
starts Vitest directly. It runs `npm run build` first so bundle sizes and the
main-process code are fresh. Set `BENCH_SKIP_BUILD=1` to reuse an existing
`out/` directory while iterating on a benchmark.

The benchmarks are intentionally **outside `tests/`**, so `npm run test:fast`
and `npm test` never run them.

## What is measured

### 1. Database — `bench/db.bench.ts`

Runs the real `DownloadDatabase` (real migrations, prepared statements, WAL and
`synchronous=NORMAL`) against a temporary SQLite file:

- inserts 10,000 history rows through `saveMany`, the same batched write path the
  app uses, in 20 transactions of 500 rows;
- simulates 60 seconds of progress ticks for 50 active downloads at the app's
  real cadence (`POLL_INTERVAL_MS = 1000` and
  `PROGRESS_PERSIST_INTERVAL_MS = 2500` in `src/main/downloads/manager.ts`), so
  progress is flushed in 24 transactions of 50 rows (1,200 SQLite row writes);
- reports per-tick p50/p95/max, total row updates, flush count and row writes;
- times the common read paths: `loadAll()` over 10k rows, `loadSettings()`,
  `loadMediaJobs()` and `loadBatches()` (median of five runs).

### 2. Progress pipeline — `bench/progress.bench.ts`

Drives the real `DownloadManager.poll()` path with 50 and 200 active downloads.
Only the aria2 RPC transport is faked: `system.multicall` returns the same
string-shaped status payload aria2 returns. Everything after that is production
code — `parseAria2Status`, `applyStatus`, revision tracking, `getSnapshot()` and
the `onUpdate` callback that `src/main/index.ts` forwards with
`webContents.send`:

- 3 warm-up ticks, then 60 measured ticks per configuration;
- **CPU ms/tick** is `poll()` only, excluding serialization;
- **IPC bytes/tick** is the `v8.serialize()` size of the emitted `AppSnapshot`
  (the structured-clone-style payload Electron sends), plus the JSON size for
  reference and the serialization time.

### 3. Renderer — `bench/renderer.bench.tsx`

Runs the real `DownloadTable` in jsdom with a 720 px viewport, wrapped in
`React.Profiler`:

- mounts the list with 1,000 and 5,000 rows;
- applies 100 progress updates to 50 rows;
- reports commit count and committed React render time from the Profiler
  (`actualDuration`), plus the wall time;
- reports how many row components actually rendered per update using
  `recordRowRender()` / `rowRenderCounter` in `DownloadTable.tsx`. That counter
  is disabled in production and only enabled by this benchmark.

The list is virtualised (`ROW_HEIGHT = 58`), so about 20 rows mount regardless of
the total. That is the behaviour being protected: a larger history must not
increase the per-update render cost. The 1k/5k cases measure the surrounding
list work (retry deadline scan, window calculations, array slicing) and row
identity/memo behaviour.

### 4. Startup bundles — `bench/startup.bench.ts`

Reads `out/` after the build and reports raw and gzip (level 9) sizes for the
main bundle, preload, renderer JS and renderer CSS, plus the largest emitted
chunks. electron-vite does not emit a Rollup stats/visualizer file by default,
so `statsFile` is `null`; if a stats file is added to `out/`, the benchmark
reports it automatically.

## Runtime memory profile

Measured on a dev build (`npm run dev`) on the same machines as the baseline
below. These are working-set figures for the whole app, not a benchmark, so
they only have to stay in the same ballpark:

| State | Working set |
| --- | --- |
| Window open | ~324 MB |
| Hidden to tray | ~235 MB (was ~355 MB) |

What keeps these numbers down:

- **GPU acceleration is off by default.** The UI is a plain list, so Chromium's
  GPU process only costs memory. Set `DONDOWNLOAD_GPU=1` to re-enable hardware
  acceleration when ruling out a rendering problem.
- **No renderer while hidden to the tray.** Hiding the app destroys the
  `BrowserWindow`; the main process, aria2, the download/media managers, the
  tray and taskbar progress keep running. Showing the app again creates a fresh
  window (and re-applies taskbar progress to it).
- **At most 2 parallel media jobs.** yt-dlp/ffmpeg pairs are the heaviest
  processes the app starts, so the media queue never runs more than two at
  once, even when the download limit is higher.
- **Helper processes run below normal priority.** aria2 and yt-dlp (and ffmpeg,
  which inherits the class on Windows) are set to below-normal CPU priority, so
  transfers yield the CPU to games and foreground apps.

## Baseline

Environment for the baseline below:

| | |
| --- | --- |
| Date | 2026-11-07 |
| Node | v24.19.0 |
| OS | Windows, win32 x64 |
| CPU | AMD Ryzen 9 7950X3D, 32 logical cores |
| RAM | 31.1 GiB |

### Database

| Metric | Baseline |
| --- | --- |
| Insert 10,000 history rows | 64.01 ms total · 0.006 ms/row · 156,227 rows/s |
| Progress tick, 50 active × 60 s | p50 4 µs · p95 0.395 ms · max 0.537 ms |
| Progress writes | 3,000 row updates · 24 flushes · 1,200 SQLite row writes |
| `loadAll()` (10k rows) | p50 30.60 ms (min 24.49 ms) |
| `loadSettings()` | p50 0.02 ms |
| `loadMediaJobs()` (empty) | p50 0.00 ms |
| `loadBatches()` (empty) | p50 0.01 ms |

Most progress ticks only update the in-memory records, which is why the p50 is a
few microseconds; the 2.5 s persistence tick dominates the p95.

### Progress pipeline

| Active downloads | CPU p50 | CPU p95 | IPC payload/tick | JSON/tick | Serialize |
| --- | --- | --- | --- | --- | --- |
| 50 | 0.06 ms | 0.12 ms | 22.9 KiB | 27.2 KiB | 0.04 ms |
| 200 | 0.15 ms | 0.25 ms | 91.5 KiB | 108.7 KiB | 0.12 ms |

The payload is a **full snapshot** every tick, so IPC bytes scale linearly with
the number of active downloads. That is the main lever for later optimisation
branches.

### Renderer

| Rows | Mount | Mount commits | Update commits | Total React render (100 updates) | Rows re-rendered/update |
| --- | --- | --- | --- | --- | --- |
| 1,000 | 8.94 ms | 2 | 100 | 99.01 ms (p50 0.98 ms) | 20 |
| 5,000 | 8.40 ms | 2 | 100 | 109.02 ms (p50 1.08 ms) | 20 |

The second mount commit is the viewport measurement in `useLayoutEffect`. Row
count barely moves the update cost because only the virtualised window renders;
the small difference is the list-level scan and array work. Desktop runs vary by
roughly ±10%, so compare medians of three runs rather than a single number.

### Startup bundles

| Bundle | Raw | Gzip |
| --- | --- | --- |
| Main | 1.05 MiB (1,097,945 B) | 270.0 KiB (276,455 B) |
| Preload | 10.7 KiB (10,947 B) | 2.0 KiB (2,016 B) |
| Renderer JS | 1.00 MiB (1,051,819 B) | 210.9 KiB (215,987 B) |
| Renderer CSS | 77.7 KiB (79,571 B) | 11.6 KiB (11,923 B) |
| Renderer total | 1.08 MiB (1,131,390 B) | 222.6 KiB (227,910 B) |

Largest emitted chunk: `out/main/index.js` (1.05 MiB raw / 270.0 KiB gzip).
No module-level stats file is emitted by the current electron-vite config.

## Comparing optimisation branches

1. Use the same machine, power plan and Node version. Absolute timings are not
   portable.
2. Run `npm run bench` at least three times. Compare medians (the JSON keeps
   p50/p95 per benchmark).
3. Compare like with like: p50 for steady-state CPU, p95 for persistence
   spikes, gzip bytes for download size, raw bytes for parse/startup work.
4. Treat renderer numbers as **jsdom-relative**. They are useful for React
   commit/render-count regressions, not as real Chromium frame times. Validate
   user-visible changes in the app or with Electron.
5. Keep `bench/results/latest.json` as the new baseline only after a deliberate
   change. Review the structured diff alongside the table.

## What this suite does not cover

- Real aria2 process I/O and network throughput (the transport is mocked).
- Electron IPC transport overhead beyond v8 serialization.
- Real Chromium layout, paint and compositing.
- Installer size and packaged app startup, which require `npm run build:installer`
  and a packaged smoke run.
