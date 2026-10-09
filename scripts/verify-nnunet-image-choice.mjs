#!/usr/bin/env node
/**
 * nnU-Net plugin 可以選要推論哪一組影像（有兩組以上 CT 時）
 * —— headless Chrome ＋ CDP，真的跑一次推論（GPU；TotalSegmentator 約一兩分鐘）：
 *
 *   1. 打開 nnU-Net 面板 → 「要推論的影像」列出病例裡每一組影像（模態 日期 描述）
 *   2. 選一組**不是 primary** 的影像、只勾一個 ROI、執行
 *   3. 工作完成後，新的結構集掛在**選的那組影像**的 FoR 上（以前面板送錯參數名，永遠推論 primary）
 *
 * 需要一個開著病例（兩組以上影像）、登錄了 nnU-Net plugin 的堆疊（auth off 的量測堆疊最方便），例如：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   curl -X POST -H 'content-type: application/json' -d '{"endpoint":"http://127.0.0.1:8702","token":""}' http://127.0.0.1:8091/api/v1/plugins
 *   node scripts/verify-nnunet-image-choice.mjs --url http://127.0.0.1:5183/#/viewer [--roi liver] [--out-dir DIR]
 * 退出碼：任一步失敗 → 1。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);
const url = args.url ?? 'http://127.0.0.1:5183/#/viewer';
const outDir = args['out-dir'] ?? null;
const port = Number(args.port ?? 9337);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;
const roi = args.roi ?? 'liver';

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-nnunet-'));
const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--password-store=basic', '--disable-gpu', '--hide-scrollbars', '--window-size=1600,1000', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], {
  stdio: 'ignore',
});
process.on('exit', () => {
  try {
    proc.kill('SIGKILL');
  } catch {
    /* already gone */
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 100 && targets === null; i += 1) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    await sleep(100);
  }
}
if (targets === null) throw new Error('Chrome 沒有起來');
const ws = new WebSocket((targets.find((t) => t.type === 'page') ?? targets[0]).webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result.value;
};
const shot = async (name) => {
  if (!outDir) return;
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, name), Buffer.from(data, 'base64'));
};
const waitFor = async (expression, what, ms = 60000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return;
    } catch {
      /* 頁面還在換 */
    }
    await sleep(250);
  }
  await shot('nnunet-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);
const api = async (path, init) => {
  const r = await fetch(`${origin}/api/v1${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.plugins-menu .task-toggle')`, '檢視器載入');
await sleep(1500);

const scene = await api('/sessions/current');
const images = scene.layers.filter((l) => l.kind === 'image');
if (images.length < 2) throw new Error(`這個病例只有 ${images.length} 組影像，測不到「選哪一組」`);
const primaryFor = scene.gridSet.frame_groups.find((f) => f.role === 'primary').frame_of_reference_uid;

// 1
await evaluate(`document.querySelector('.plugins-menu .task-toggle').click(); true`);
await waitFor(`!!document.querySelector('.plugins-dropdown [role=menuitemcheckbox]')`, 'Plugins 選單', 10000);
await evaluate(`[...document.querySelectorAll('.plugins-dropdown [role=menuitemcheckbox]')].find((b) => b.textContent.includes('nnU-Net')).click(); true`);
await waitFor(`!!document.querySelector('.nnunet-image select') && document.querySelectorAll('.nnunet-rois input').length > 10`, 'nnU-Net 面板（影像選單與 ROI 清單）', 20000);
const options = await evaluate(`[...document.querySelectorAll('.nnunet-image select option')].map((o) => ({ value: o.value, text: o.textContent.trim() }))`);
if (options.length !== images.length) throw new Error(`影像選單應列出 ${images.length} 組：${JSON.stringify(options)}`);
step(`影像選單：${options.map((o) => o.text).join('／')}`);

// 2
const target = images.find((l) => l.frameOfReferenceUid !== primaryFor);
if (!target) throw new Error('找不到不是 primary FoR 的影像');
await evaluate(`(() => { const s = document.querySelector('.nnunet-image select'); s.value = ${JSON.stringify(target.contentRef)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
await sleep(300);
if ((await evaluate(`document.querySelector('.nnunet-image select').value`)) !== target.contentRef) throw new Error('選不到那組影像');
const picked = await evaluate(`(() => { const li = [...document.querySelectorAll('.nnunet-rois li')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(roi)})); if (!li) return false; li.querySelector('input').click(); return true; })()`);
if (!picked) throw new Error(`ROI 清單裡沒有 ${roi}`);
const setsBefore = (await api(`/cases/${scene.caseId}/structure-sets`)).map((s) => s.structure_set_id ?? s.structureSetId);
await evaluate(`document.querySelector('.nnunet-run').click(); true`);
step(`選 ${options.find((o) => o.value === target.contentRef)?.text}（FoR …${target.frameOfReferenceUid.slice(-8)}）、ROI ${roi}，執行`);

// 3
await waitFor(`/完成|失敗|done|failed/.test(document.querySelector('.nnunet-job')?.textContent ?? '')`, '推論結束', 900000);
const jobLine = await evaluate(`document.querySelector('.nnunet-job').textContent.trim()`);
await shot('nnunet-choice.png');
if (/失敗|failed/.test(jobLine)) throw new Error(`推論失敗：${jobLine}`);
await sleep(1500);
const sets = await api(`/cases/${scene.caseId}/structure-sets`);
const created = sets.filter((s) => !setsBefore.includes(s.structure_set_id ?? s.structureSetId));
if (created.length === 0) throw new Error(`沒有新的結構集：${jobLine}`);
const fors = created.map((s) => s.frame_of_reference_uid ?? s.frameOfReferenceUid);
if (!fors.every((f) => f === target.frameOfReferenceUid)) throw new Error(`結果掛錯 FoR：${JSON.stringify(fors)}（選的是 ${target.frameOfReferenceUid}，primary ${primaryFor}）`);
step(`完成（${jobLine}）；新結構集「${created.map((s) => s.label).join('、')}」掛在選的那組影像的 FoR 上（不是 primary）`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
