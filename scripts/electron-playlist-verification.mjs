#!/usr/bin/env node
/** Real packaged Electron playlist preview and explicit one-entry selection. */
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { mkdir, writeFile, stat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appPath = process.env.DONDOWNLOAD_PACKAGED_APP || path.join(root, 'dist', 'win-unpacked', 'DonDownload.exe')
const runDir = path.join(root, 'artifacts', 'test-runs', `electron-playlist-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const userData = path.join(runDir, 'user-data')
const screenshotDir = path.join(runDir, 'screenshots')
const mediaDir = path.join(userData, 'smoke-downloads', 'Media')
const port = 19343
const playlistUrl = 'https://www.youtube.com/playlist?list=PLav47HAVZMjnTFVZL-aImCQIC0uLZtNCz'
const checks = []
await mkdir(screenshotDir, { recursive: true })

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 1; this.pending = new Map(); this.listeners = new Map()
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data.toString())
      if (message.id) {
        const task = this.pending.get(message.id); if (!task) return
        this.pending.delete(message.id)
        message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result)
      } else for (const callback of this.listeners.get(message.method) ?? []) callback(message.params)
    })
  }
  ready() { return this.ws.readyState === WebSocket.OPEN ? Promise.resolve() : new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }) }) }
  on(event, callback) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]) }
  command(method, params = {}) {
    const id = this.id++; this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 20_000); this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } }) })
  }
  async eval(expression) {
    const result = await this.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result?.value
  }
  async shot(name) { const result = await this.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); const file = path.join(screenshotDir, name); await writeFile(file, Buffer.from(result.data, 'base64')); return file }
  close() { try { this.ws.close() } catch {} }
}

let app
let cdp
function record(name, detail) { checks.push({ name, ...detail }); console.log(`${name}: ${JSON.stringify(detail)}`) }
const sleep = ms => delay(ms)
async function waitFor(read, predicate, ms, label) {
  const end = Date.now() + ms; let last
  while (Date.now() < end) { last = await read(); if (predicate(last)) return last; await sleep(250) }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`)
}
async function clickButton(label) {
  const ok = await cdp.eval(`(() => { const e=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()===${JSON.stringify(label)}&&!x.disabled); e?.click(); return !!e })()`)
  if (!ok) throw new Error(`Button not found: ${label}`)
}
async function start() {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const key of ['DONDOWNLOAD_ARIA2_PATH','DONDOWNLOAD_YTDLP_PATH','DONDOWNLOAD_FFMPEG_PATH','DONDOWNLOAD_FFPROBE_PATH','DONDOWNLOAD_DENO_PATH']) delete env[key]
  env.DONDOWNLOAD_SMOKE_TEST='1'; env.DONDOWNLOAD_INTERACTIVE_SMOKE='1'; env.DONDOWNLOAD_SMOKE_RESULT_PATH=path.join(userData,'smoke-result.json')
  app = spawn(appPath, ['--smoke-test',`--user-data-dir=${userData}`,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1','--headless'], { cwd:path.dirname(appPath),env,windowsHide:true,stdio:['ignore','ignore','pipe'] })
  app.stderr.on('data', chunk => { const value=chunk.toString(); if (/INTERACTIVE_READY|ERROR|FAIL/i.test(value)) process.stderr.write(value) })
  const target = await waitFor(async()=>{try{const r=await fetch(`http://127.0.0.1:${port}/json/list`);return r.ok?(await r.json()).find(x=>x.type==='page'&&x.webSocketDebuggerUrl):null}catch{return null}},x=>!!x,45_000,'Electron target')
  cdp=new Cdp(target.webSocketDebuggerUrl); await cdp.ready(); await cdp.command('Page.enable'); await cdp.command('Runtime.enable')
  const ready=await waitFor(()=>cdp.eval(`({rendered:!!document.querySelector('#root')?.children.length,preload:typeof window.donDownload?.getBatchSnapshot==='function'})`),x=>x?.rendered&&x?.preload,30_000,'Packaged renderer/preload')
  record('production-electron-startup',{...ready,userData,visible:false})
}
async function stop() { cdp?.close(); if(app&&app.exitCode===null){execFileSync('taskkill',['/pid',String(app.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await new Promise(resolve=>app.once('exit',resolve))} }
async function batchSnapshot() { return cdp.eval('window.donDownload.getBatchSnapshot()') }
async function allFiles(dir) { const out=[]; for(const e of await readdir(dir,{withFileTypes:true}).catch(()=>[])){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await allFiles(p));else out.push(p)}return out }

try {
  if (!(await stat(appPath).catch(()=>null))) throw new Error(`Packaged app missing: ${appPath}`)
  await start()
  await cdp.eval(`document.querySelector('nav[aria-label="Sections"] button[aria-current="page"]')?.click()`)
  await cdp.eval(`([...document.querySelectorAll('nav[aria-label="Sections"] button')].find(x=>x.innerText.trim()==='Batches'))?.click()`)
  await waitFor(()=>cdp.eval(`document.querySelector('#batch-urls')!==null`),Boolean,15_000,'Batches section')
  await cdp.shot('01-batch-empty.png')
  const before=(await batchSnapshot()); if(!before.ok||before.value.batches.length) throw new Error('Expected clean isolated batch history.')
  const setter=`(() => { const e=document.querySelector('#batch-urls'); const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(e,${JSON.stringify(playlistUrl)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return true })()`
  await cdp.eval(setter); await clickButton('Submit batch')
  await waitFor(()=>cdp.eval(`document.querySelector('article[aria-labelledby^="batch-preview-"]')?.innerText ?? ''`),text=>text.includes('Blender Open Movies')||text.includes('Caminandes')||text.includes('18 items'),180_000,'Real yt-dlp playlist preview')
  const previewState=await cdp.eval(`(() => { const card=document.querySelector('article[aria-labelledby^="batch-preview-"]'); return {text:card?.innerText,entries:[...card?.querySelectorAll('input[type=checkbox]')??[]].map((e,i)=>({checked:e.checked,title:e.labels?.[0]?.innerText?.replace(/\\s+/g,' ').trim(),i}))} })()`)
  if(!previewState.text.includes('18 items') || !previewState.entries.some(x=>x.title?.includes('Caminandes'))) throw new Error(`Playlist preview did not match fixture: ${JSON.stringify(previewState)}`)
  const batchAfterPreview=await batchSnapshot(); if(!batchAfterPreview.ok||batchAfterPreview.value.batches.length!==0) throw new Error('Playlist preview queued work before explicit selection.')
  await cdp.shot('02-playlist-preview-unselected.png')
  record('playlist-preview',{entryCount:18,selectedInitially:previewState.entries.filter(x=>x.checked).length,fixtureEntry:previewState.entries.find(x=>x.title?.includes('Caminandes'))?.title,screenshot:path.join(screenshotDir,'02-playlist-preview-unselected.png')})

  // Explicitly choose only the pinned, lawful fixture; all other entries stay unchecked.
  const chosen=await cdp.eval(`(() => { const card=document.querySelector('article[aria-labelledby^="batch-preview-"]'); const row=[...card.querySelectorAll('li')].find(li=>li.innerText.includes('Caminandes 2: Gran Dillama')); const box=row?.querySelector('input[type=checkbox]'); box?.click(); return {checked:box?.checked,title:row?.innerText.replace(/\\s+/g,' ').trim(),selected:card?.innerText.match(/(\\d+) selected/)?.[1]} })()`)
  if(!chosen.checked||chosen.selected!=='1') throw new Error(`Explicit single selection failed: ${JSON.stringify(chosen)}`)
   await cdp.shot('03-playlist-one-selected.png')
   record('explicit-playlist-selection',{selectedCount:chosen.selected,selectedEntry:chosen.title,screenshot:path.join(screenshotDir,'03-playlist-one-selected.png')})
  const stillEmpty=await batchSnapshot()
  if(!stillEmpty.ok||stillEmpty.value.batches.length!==0) throw new Error('Preview/selection stage unexpectedly created a batch.')
   await clickButton('Check selected formats')
   const formats=await waitFor(()=>cdp.eval(`(() => ({text:document.querySelector('article[aria-labelledby^="batch-preview-"]')?.innerText??''}))()`),state=>/Verified:|No verified media formats/.test(state.text),180_000,'Selected entry format analysis')
   if(!formats.text.includes('Verified:')) throw new Error(`Selected entry has no verified quality: ${formats.text}`)
   await cdp.shot('04-playlist-quality-verified.png')
   const controls=await cdp.eval(`(() => { const card=document.querySelector('article[aria-labelledby^="batch-preview-"]'); const select=card?.querySelector('select'); const input=[...card?.querySelectorAll('input[type=number]')??[]].find(x=>x.placeholder==='No limit'); return {qualities:[...select?.options??[]].map(x=>x.text),selectValue:select?.value,hasCap:!!input} })()`)
   if(!controls.qualities.length||!controls.hasCap) throw new Error(`Playlist quality/cap controls missing: ${JSON.stringify(controls)}`)
   const lowQuality=controls.qualities.map((text,index)=>({text,index})).find(option=>/480p/.test(option.text))
   if(!lowQuality) throw new Error(`No genuinely available 480p quality: ${JSON.stringify(controls.qualities)}`)
   await cdp.eval(`(() => { const card=document.querySelector('article[aria-labelledby^="batch-preview-"]'); const select=card.querySelector('select'); select.selectedIndex=${lowQuality.index}; select.dispatchEvent(new Event('change',{bubbles:true})); const input=[...card.querySelectorAll('input[type=number]')].find(x=>x.placeholder==='No limit'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,'25'); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); return true })()`)
   await cdp.shot('05-playlist-quality-and-size-cap.png')
   const beforeQueue=await batchSnapshot(); if(!beforeQueue.ok||beforeQueue.value.batches.length) throw new Error('Format analysis unexpectedly created a batch.')
   await clickButton('Queue selected (1)')
   let activeCaptured=false
   const completed=await waitFor(async()=>{const result=await batchSnapshot();const value=result.ok?result.value:null;const batch=value?.batches?.[0];const item=batch?.items?.[0];if(!activeCaptured&&item?.status==='running'){activeCaptured=true;await cdp.shot('06-playlist-batch-active.png');record('playlist-batch-active',{batchStatus:batch.status,itemStatus:item.status,completedBytes:item.completedBytes,totalBytes:item.totalBytes,screenshot:path.join(screenshotDir,'06-playlist-batch-active.png')})}return value},value=>value?.batches?.some(batch=>batch.items?.some(item=>item.status==='complete'||item.status==='error'||item.status==='skipped')),300_000,'Capped playlist batch terminal state')
   const batch=completed.batches[0]
   const item=batch.items[0]
   if(item.status!=='complete') throw new Error(`Capped playlist item did not complete: ${JSON.stringify(item)}`)
   if(!/merged/i.test(item.label)) throw new Error(`Selected 480p quality did not resolve to a merged format: ${JSON.stringify(item)}`)
   const files=await allFiles(mediaDir)
   if(files.length!==1) throw new Error(`Expected one capped output file, found ${files.length}`)
   const outputStat=await stat(files[0])
   if(outputStat.size>25*1024*1024) throw new Error(`Playlist output exceeded cap: ${outputStat.size}`)
   const ffprobe=path.join(path.dirname(appPath),'resources','vendor','ffmpeg','ffprobe.exe')
   const probe=spawnSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',files[0]],{encoding:'utf8',windowsHide:true,timeout:30_000,maxBuffer:4*1024*1024})
   if(probe.error||probe.status!==0) throw new Error(`Bundled ffprobe failed on final merged output: ${probe.error?.message??probe.stderr}`)
   const metadata=JSON.parse(probe.stdout)
   const video=metadata.streams?.find(stream=>stream.codec_type==='video')
   const audio=metadata.streams?.find(stream=>stream.codec_type==='audio')
   if(!video||!audio||video.width!==854||video.height!==480) throw new Error(`Final file is missing verified 480p video/audio streams: ${JSON.stringify(metadata.streams?.map(stream=>({type:stream.codec_type,codec:stream.codec_name,width:stream.width,height:stream.height})))}`)
   await cdp.shot('07-playlist-batch-complete.png')
   record('playlist-quality-cap-transfer',{selectedQuality:lowQuality.text,capBytes:25*1024*1024,finalBytes:outputStat.size,itemStatus:item.status,output:files[0],container:metadata.format?.format_name,video:{codec:video.codec_name,width:video.width,height:video.height},audio:{codec:audio.codec_name,channels:audio.channels},ffprobeExitCode:probe.status,screenshot:path.join(screenshotDir,'07-playlist-batch-complete.png')})
   const report={status:'PASS — packaged playlist quality/cap transfer',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),app:appPath,renderer:'actual packaged Electron renderer + production preload/IPC + yt-dlp/FFmpeg',playlistUrl,selection:'exactly one explicit CC-BY Caminandes entry',userData,mediaDir,screenshots:screenshotDir,checks}
  await writeFile(path.join(runDir,'result.json'),JSON.stringify(report,null,2));console.log(`PLAYLIST_RESULT ${path.join(runDir,'result.json')}`)
} catch(error) {
  if(cdp)try{await cdp.shot('99-failure.png')}catch{}
  const report={status:'FAIL',error:error instanceof Error?error.stack??error.message:String(error),userData,mediaDir,screenshots:screenshotDir,checks};await writeFile(path.join(runDir,'result.json'),JSON.stringify(report,null,2)).catch(()=>{});console.error(`PLAYLIST_FAIL ${report.error}`);process.exitCode=1
} finally { await stop().catch(error=>console.error(`cleanup: ${error.message}`)) }
