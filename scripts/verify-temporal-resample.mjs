#!/usr/bin/env node
/**
 * 網格跟第一幀不同的相位重新取樣 —— headless Chrome ＋ CDP（骨架同 `verify-temporal-compose.mjs`、零相依）。
 * 相位網格不一致時重取樣補齊。
 *
 *   SYN4D-CT6（ct2 的十個相位，但 30% 少一片、70% 的 z 位移 1.5 mm）：
 *   1. 開啟 → 時間軸 8 幀、時間軸列「排除了 2 個相位（30%、70%）」
 *   2.「重新取樣補進來」→ 10 幀、「30%、70% 已重新取樣」；跳到 30%（第 4 幀）→ 軸向格有影像、跟 20% 不同；病例 id 沒變
 *   3.「改回排除」→ 8 幀
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-temporal-resample.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR] [--token <rtgaia_session>]
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
const url = args.url ?? 'http://127.0.0.1:5183/#/library';
const outDir = args['out-dir'] ?? null;
const port = Number(args.port ?? 9344);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-temporal-resample-'));
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
  await shot('temporal-resample-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(250);
};
const centerOf = (expr) => evaluate(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const cellSel = (label) => `[...document.querySelectorAll('.viewport-cell')].find((c) => c.querySelector('.viewport-label')?.textContent.trim() === ${JSON.stringify(label)})`;

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
const initScript = await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });

const rowWith = (kind, text) => `[...document.querySelectorAll('.catalog-tree tr[data-kind="${kind}"]')].find((r) => r.textContent.includes(${JSON.stringify(text)}))`;
const rowsWith = (kind, text) => `[...document.querySelectorAll('.catalog-tree tr[data-kind="${kind}"]')].filter((r) => r.textContent.includes(${JSON.stringify(text)}))`;
/** 資料頁：清空選取 → 展開病人 → 展開第一個描述含 `study` 的 study。 */
const openStudy = async (patientId, study, { reload = true } = {}) => {
  if (reload) await send('Page.navigate', { url: `${origin}/#/library` });
  else await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '資料庫…').click(); true`);
  await waitFor(`!!${rowWith('patient', patientId)}`, `資料頁有 ${patientId}`, 60000);
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '清空')?.click(); true`);
  await evaluate(`${rowWith('patient', patientId)}.click(); true`);
  await waitFor(`!!${rowWith('study', study)}`, `${patientId} 的 study「${study}」`);
  await evaluate(`${rowWith('study', study)}.click(); true`);
  await waitFor(`!!document.querySelector('.catalog-tree tr[data-kind="image"], .catalog-tree tr[data-kind="temporal"]')`, `${study} 的影像`);
  await sleep(500);
};
const summary = () => evaluate(`document.querySelector('.selection-summary')?.textContent.trim() ?? ''`);
const openCase = async (needTime = false) => {
  // 勾影像要先抓它的 RT 列才進選取（懶載入）→ 等摘要有主要影像再按開啟
  await waitFor(`document.querySelector('.selection-summary')?.textContent.includes('主要影像')`, '選取有主要影像', 20000);
  await evaluate(`[...document.querySelectorAll('button.primary')].find((b) => b.textContent.trim() === '開啟').click(); true`);
  await waitFor(`location.hash.includes('viewer') && document.querySelectorAll('.viewport-cell canvas').length >= 3${needTime ? " && !!document.querySelector('.time-group')" : ''}`, '病例開起來', 180000);
  await waitFor(`!document.querySelector('.mask-loading')`, '結構載入完', 120000);
  await sleep(1500);
};
const pageText = () => evaluate(`document.body.innerText`);
const structureCount = () => evaluate(`document.querySelectorAll('.structure-list li').length`);
/** 資料面板的「▸ 結構（…）」收合時清單不渲染 → 展開。 */
const expandStructures = () => evaluate(`(() => { const h = [...document.querySelectorAll('button, summary, span, div')].find((e) => e.children.length === 0 && /^▸ 結構（/.test(e.textContent.trim())); h?.click(); return !!h; })()`);


const rows = `[...document.querySelectorAll('.frame-group .image-row')]`;
const caseId = () => evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.caseId)`);
const studyId = () => evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.studyId)`);
/** 某一格 canvas 的指紋（取樣像素和）—— 比較兩張畫面是不是同一張。 */
const canvasSum = (label) => evaluate(`(() => { const c = ${cellSel(label)}?.querySelector('canvas'); const x = c?.getContext('2d'); if (!x) return -1; const d = x.getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 16) s += d[i]; return s; })()`);
const timeText = () => evaluate(`document.querySelector('.time-group .time-text')?.textContent.trim() ?? null`);
const clickButton = (scope, text) => evaluate(`(() => { const b = [...(${scope}).querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);


const total = () => evaluate(`(/／(\\d+)/.exec(document.querySelector('.time-group .time-text')?.textContent ?? '') ?? [])[1] ?? null`);

// 1
await openStudy('SYN4D-CT6', 'synth4d');
await waitFor(`!!document.querySelector('.catalog-tree tr[data-kind="temporal"]')`, 'CT6 的時間軸');
await evaluate(`document.querySelector('.catalog-tree tr[data-kind="temporal"] input[type=checkbox]').click(); true`);
await openCase(true);
if (await evaluate(`!!document.querySelector('.time-resample[data-resampled]')`)) {
  await clickButton(`document.querySelector('.time-resample')`, '改回排除');
  await waitFor(`!!document.querySelector('.time-resample[data-excluded]')`, '上一輪的重新取樣改回排除', 120000);
}
await waitFor(`!!document.querySelector('.time-resample[data-excluded="2"]')`, '時間軸列「排除了 2 個相位」', 30000);
const note = await evaluate(`document.querySelector('.time-resample').textContent`);
if (!note.includes('30%') || !note.includes('70%') || (await total()) !== '8') throw new Error(`排除提示：${note}，幀數 ${await total()}`);
const case0 = await caseId();
step(`開啟：8 幀、時間軸列「${note.replace('重新取樣補進來', '').trim()}」`);

// 2
await clickButton(`document.querySelector('.time-resample')`, '重新取樣補進來');
await waitFor(`!!document.querySelector('.time-resample[data-resampled="2"]')`, '重新取樣後', 120000);
await waitFor(`(/／10/.test(document.querySelector('.time-group .time-text')?.textContent ?? ''))`, '時間軸 10 幀', 60000);
if ((await caseId()) !== case0) throw new Error('重新取樣後換了病例');
await evaluate(`[...document.querySelectorAll('.time-group button')].find((b) => b.title === '跳到播放範圍的開頭').click(); true`);
await sleep(500);
for (let i = 0; i < 2; i += 1) {
  await evaluate(`[...document.querySelectorAll('.time-group button')].find((b) => b.title === '下一個').click(); true`);
  await sleep(300);
}
await waitFor(`document.querySelector('.time-group')?.dataset.cursor === '2' && !document.querySelector('.time-group .time-text')?.textContent.includes('載入中')`, '20%', 30000);
await sleep(1500);
const at20 = await canvasSum('軸向');
await evaluate(`[...document.querySelectorAll('.time-group button')].find((b) => b.title === '下一個').click(); true`);
await waitFor(`document.querySelector('.time-group')?.dataset.cursor === '3' && document.querySelector('.time-group .time-text')?.textContent.includes('30%') && !document.querySelector('.time-group .time-text')?.textContent.includes('載入中')`, '30%（補進來的那一幀）', 30000);
await sleep(1500);
const at30 = await canvasSum('軸向');
await shot('resample-30.png');
if (!(at30 > 0) || at30 === at20) throw new Error(`30% 的軸向格：${at30}（20% 是 ${at20}）`);
step(`重新取樣補進來：10 幀、「30%、70% 已重新取樣」、同一個病例；30% 那一幀有影像、跟 20% 不同`);

// 3
await clickButton(`document.querySelector('.time-resample')`, '改回排除');
await waitFor(`!!document.querySelector('.time-resample[data-excluded="2"]') && (/／8/.test(document.querySelector('.time-group .time-text')?.textContent ?? ''))`, '改回排除：8 幀', 120000);
step('改回排除：8 幀');

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
