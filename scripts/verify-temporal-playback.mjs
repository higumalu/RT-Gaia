#!/usr/bin/env node
/**
 * 時間序列像影片一樣播放 —— 預算放得下就每一幀都留全解析度、播放時用全品質畫（以前每換一幀先模糊、等一下才清楚）。
 * headless Chrome ＋ CDP（骨架同 `verify-demo-open.mjs`、零相依）。
 *
 *   SYN4D-CT1（合成 4DCT 10 相位，`data/test_4d`）與 113_HM10395（4D-Lung，512×512×132 × 10 相位，`data/demo`）：
 *   資料頁勾 4D 組 → 開啟 → 等載入條全部變成全解析度（「高清 n／N」消失）→ 停在相位 0 量軸向格的清晰度（相鄰像素差的平均）→
 *   播放 3 秒、每 120 ms 量一次 → 每一次都 ≥ 停住時的 90%（以前播放中是低解析度，明顯糊掉）→ 暫停
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-temporal-playback.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR] [--token <rtgaia_session>] [--only ct1|lung]
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
const port = Number(args.port ?? 9337);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-play-'));
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
  await shot('play-failed.png').catch(() => undefined);
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
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
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


/** 軸向格的清晰度：灰階相鄰像素差的平均（低解析度放大後會變小）。 */
const SHARP = `(() => { const c = ${cellSel('軸向')}?.querySelector('canvas'); const x = c?.getContext('2d'); if (!x) return -1; const d = x.getImageData(0, 0, c.width, c.height).data; let s = 0, n = 0; for (let y = 0; y < c.height; y += 2) for (let i = 0; i < c.width - 1; i += 1) { const p = (y * c.width + i) * 4; s += Math.abs(d[p] - d[p + 4]); n += 1; } return s / n; })()`;
const FULL = `document.querySelectorAll('.time-group .time-resident i.is-full').length`;
const play = async (pid, study, rowText, minutes) => {
  await openStudy(pid, study);
  await waitFor(`!!${rowWith('temporal', rowText)}`, `${pid} 的 4D 組`);
  await evaluate(`${rowWith('temporal', rowText)}.querySelector('input[type=checkbox]').click(); true`);
  await openCase(true);
  const t0 = Date.now();
  await waitFor(`${FULL} === 10`, `${pid}：10 個相位都到全解析度`, minutes * 60000);
  const loadS = ((Date.now() - t0) / 1000).toFixed(1);
  const hint = await evaluate(`document.querySelector('.time-group .time-text').textContent.trim()`);
  if (hint.includes('高清')) throw new Error(`全部到了還顯示：${hint}`);
  await sleep(1500);
  const still = await evaluate(SHARP);
  await evaluate(`document.querySelector('.time-group .time-play').click(); true`);
  await sleep(300);
  const samples = [];
  const seen = new Set();
  for (let i = 0; i < 25; i += 1) {
    await sleep(120);
    const r = await evaluate(`({ s: ${SHARP}, c: document.querySelector('.time-group').dataset.cursor, p: document.querySelector('.time-group').dataset.playing })`);
    samples.push(r.s);
    seen.add(r.c);
  }
  await evaluate(`document.querySelector('.time-group .time-play').click(); true`);
  await shot(`play-${pid}.png`);
  const worst = Math.min(...samples);
  if (seen.size < 3) throw new Error(`${pid}：播放 3 秒只看到相位 ${[...seen].join(',')}`);
  if (worst < still * 0.9) throw new Error(`${pid}：播放中變模糊（清晰度 ${worst.toFixed(2)}，停住 ${still.toFixed(2)}）`);
  step(`${pid}：${loadS} s 全部相位都是全解析度；播放 3 秒看到 ${seen.size} 個相位，清晰度最低 ${worst.toFixed(2)}（停住 ${still.toFixed(2)}）`);
};

const only = args.only ?? null;
if (only === null || only === 'ct1') await play('SYN4D-CT1', 'synth4d', '4D · 10 個相位', 2);
if (only === null || only === 'lung') await play('113_HM10395', 'p4', '4D · 10 個相位', 6);
if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
