#!/usr/bin/env node
/** Bounded reproduction of the previous 480p merge with sanitized tool logs. */
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runDir = path.join(root, 'artifacts', 'test-runs', `playlist-merge-diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const outputDir = path.join(runDir, 'output')
const appRoot = path.join(root, 'artifacts', 'packaged-verification', 'win-unpacked', 'resources', 'vendor')
const ytdlp = path.join(appRoot, 'yt-dlp', 'yt-dlp.exe')
const ffmpeg = path.join(appRoot, 'ffmpeg', 'ffmpeg.exe')
const ffprobe = path.join(appRoot, 'ffmpeg', 'ffprobe.exe')
const deno = path.join(appRoot, 'deno', 'deno.exe')
const sourceUrl = 'https://www.youtube.com/watch?v=Z4C82eyhwgU'
const formatSelector = '231+251-drc'
const maxBytes = 25 * 1024 * 1024

await mkdir(outputDir, { recursive: true })
const result = {
  startedAt: new Date().toISOString(),
  sourceUrl,
  formatSelector,
  mergeOutputFormat: 'mkv',
  maxTransferBytes: maxBytes,
  ytdlp: null,
  ffmpeg: null,
  exitCode: null,
  capped: false,
  progressBytesByStream: {},
  files: [],
  ffprobe: [],
  stdout: '',
  stderr: ''
}

const sanitize = (text) => text
  // yt-dlp's Python repr doubles Windows separators in its verbose argv line.
  .replace(/\\\\/g, '\\')
  .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL REDACTED]')
  .replace(/[A-Za-z]:\\Users\\[^\s,'"]+/gi, '[LOCAL PATH REDACTED]')
  .replace(/(?:token|sig|signature|key|authorization)=([^&\s]+)/gi, '$1=[REDACTED]')

async function executableVersion(executable, args) {
  return await new Promise((resolve) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data.toString() })
    child.stderr.on('data', data => { output += data.toString() })
    child.on('error', error => resolve({ error: error.message }))
    child.on('close', code => resolve({ exitCode: code, firstLine: output.split(/\r?\n/, 1)[0] }))
  })
}

async function listFiles(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await listFiles(file))
    else found.push({ path: path.relative(runDir, file), bytes: (await stat(file)).size })
  }
  return found
}

try {
  result.ytdlp = await executableVersion(ytdlp, ['--ignore-config', '--version'])
  result.ffmpeg = await executableVersion(ffmpeg, ['-version'])
  const args = [
    '--ignore-config', '--no-plugin-dirs', '--no-playlist', '--no-warnings',
    '--no-simulate', '--windows-filenames', '--newline', '--progress', '--verbose',
    '--no-mtime', '--no-cache-dir', '--progress-template',
    'download:DONDOWNLOAD_PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(info.format_id)s',
    '--format', formatSelector, '--output', path.join(outputDir, '%(title)s.%(ext)s'),
    '--merge-output-format', 'mkv', '--ffmpeg-location', ffmpeg,
    '--js-runtimes', `deno:${deno}`, '--', sourceUrl
  ]
  if (process.env.DONDOWNLOAD_DIAGNOSTIC_HLS_FFMPEG === '1') {
    args.splice(args.indexOf('--'), 0, '--hls-prefer-ffmpeg')
  }
  const started = Date.now()
  await new Promise((resolve, reject) => {
    const child = spawn(ytdlp, args, { cwd: outputDir, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let remainder = ''
    const append = (target, data) => {
      const chunk = data.toString()
      if (target === 'stdout') stdout += chunk
      else stderr += chunk
      if (stdout.length + stderr.length > 4 * 1024 * 1024) {
        reject(new Error('Tool logs exceeded 4 MiB safety limit.'))
        try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
      }
    }
    child.stdout.on('data', data => {
      append('stdout', data)
      remainder += data.toString()
      const lines = remainder.split(/\r?\n/)
      remainder = lines.pop() ?? ''
      for (const line of lines) {
        const match = /^DONDOWNLOAD_PROGRESS\|([^|]+)\|[^|]*\|[^|]*\|[^|]*\|(.+)$/.exec(line.trim())
        if (match) result.progressBytesByStream[match[2]] = Number(match[1]) || 0
      }
    })
    child.stderr.on('data', data => append('stderr', data))
    child.on('error', reject)
    child.on('close', code => {
      result.exitCode = code
      result.durationMs = Date.now() - started
      result.stdout = sanitize(stdout)
      result.stderr = sanitize(stderr)
      resolve()
    })
    const monitor = setInterval(() => {
      const bytes = Object.values(result.progressBytesByStream).reduce((sum, value) => sum + value, 0)
      if (bytes > maxBytes && !result.capped) {
        result.capped = true
        try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
      }
    }, 200)
    child.once('close', () => clearInterval(monitor))
    const timeout = setTimeout(() => {
      result.timedOut = true
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
    }, 5 * 60_000)
    child.once('close', () => clearTimeout(timeout))
  })
  result.files = await listFiles(outputDir)
  for (const file of result.files.filter(item => /\.(mkv|mp4|webm)$/i.test(item.path))) {
    const fullPath = path.join(runDir, file.path)
    const probe = spawn(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', fullPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let errors = ''
    probe.stdout.on('data', data => { output += data.toString() })
    probe.stderr.on('data', data => { errors += data.toString() })
    const exitCode = await new Promise(resolve => probe.on('close', resolve))
    let metadata = null
    try { metadata = JSON.parse(output) } catch {}
    result.ffprobe.push({ file: file.path, exitCode, streams: metadata?.streams?.map(stream => ({ type: stream.codec_type, codec: stream.codec_name, width: stream.width, height: stream.height, channels: stream.channels })), format: metadata?.format?.format_name, error: sanitize(errors) })
  }
} catch (error) {
  result.scriptError = error instanceof Error ? error.stack ?? error.message : String(error)
}

result.finishedAt = new Date().toISOString()
await writeFile(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2))
await writeFile(path.join(runDir, 'yt-dlp.stdout.log'), result.stdout)
await writeFile(path.join(runDir, 'yt-dlp.stderr.log'), result.stderr)
const summary = { status: result.exitCode === 0 && !result.capped ? 'PASS' : 'FAIL', runDir, ytdlp: result.ytdlp, ffmpeg: result.ffmpeg, exitCode: result.exitCode, capped: result.capped, progressBytesByStream: result.progressBytesByStream, files: result.files, ffprobe: result.ffprobe, scriptError: result.scriptError }
console.log(JSON.stringify(summary, null, 2))
if (summary.status !== 'PASS') process.exitCode = 1
