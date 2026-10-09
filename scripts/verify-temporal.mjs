#!/usr/bin/env node
/**
 * 時間軸 —— headless Chrome ＋ CDP（骨架同 `verify-mask-fill.mjs`、零相依）：
 *
 *   1. 開檢視器（帶時間軸的病例，例：假體 four_d_ct）→ 底部出現時間軸列「相位 1／10」
 *   2. 背景預抓：10 個相位的低解析度都到（滑桿下的載入條全亮）
 *   3. 下一格 → 相位 2；跳到相位 4 → 軸向格畫面真的變了（GTV 隨呼吸移動）；停在相位 4 → 它是全解析度（通常背景已預抓）
 *   4. 播放 → 游標自己往前走；暫停 → 停住
 *   5. 播放範圍 3–5 ＋ 循環 → 只在 3–5 之間跑
 *   6. 時間曲線有 10 個點；點曲線上的點跳到那個相位
 *
 * 需要一個帶時間軸的病例，例如：
 *   RTGAIA_AUTH=off .venv/bin/rtgaia-testbe --port 8093 --load phantom:four_d_ct
 *   (cd apps/viewer && RTGAIA_API=http://127.0.0.1:8093 npx vite --port 5185)
 *   node scripts/verify-temporal.mjs --url http://127.0.0.1:5185/#/viewer [--out-dir DIR]
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
const LAYOUT_KEYS = ['rtgaia.layout.trees.v1', 'rtgaia.layout.overrides.v1'];
const remotePrefs = async () =>
  (await (await fetch(`${origin}/api/v1/auth/me/preferences`, { headers: { authorization: `Bearer ${token}` } })).json()).preferences;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-temporal-'));
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
const requests = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method === 'Network.requestWillBeSent') {
    requests.push(msg.params.request.url);
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
  await shot('temporal-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);
const axialPixels = () =>
  evaluate(`(() => {
    const cell = [...document.querySelectorAll('.viewport-cell')].find((c) => c.querySelector('.viewport-label')?.textContent.trim() === '軸向');
    const out = [];
    for (const c of cell.querySelectorAll('canvas')) {
      const g = c.getContext('2d');
      if (!g || c.width === 0) continue;
      const d = g.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4 * 5) out.push(d[i], d[i + 1], d[i + 2]);
    }
    return out;
  })()`);
const diffCount = (a, b) => {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 3) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) n += 1;
  return n;
};
const group = () =>
  evaluate(`(() => { const g = document.querySelector('.time-group'); return g ? { cursor: Number(g.dataset.cursor), playing: g.dataset.playing === 'true', text: g.querySelector('.time-text').textContent.trim(), loaded: g.querySelectorAll('.time-resident i.is-loaded').length, ticks: g.querySelectorAll('.time-resident i').length, dots: g.querySelectorAll('.time-curve circle').length } : null; })()`);
const clickTitle = (title) => evaluate(`(() => { const b = [...document.querySelectorAll('.time-group button')].find((x) => x.title === ${JSON.stringify(title)}); b.click(); return true; })()`);
const setSlider = (v) => evaluate(`(() => { const s = document.querySelector('.time-slider input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(s, ${JSON.stringify(String(v))}); s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const setNumber = (label, v) => evaluate(`(() => { const s = document.querySelector('.time-range input[aria-label=${JSON.stringify(label)}]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(s, ${JSON.stringify(String(v))}); s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.time-group')`, '病例載入、時間軸列出現（要先開一個帶時間軸的病例）');
await sleep(800);

// 1
let g = await group();
if (g.cursor !== 0 || !/相位 1／10/.test(g.text) || g.ticks !== 10) throw new Error(`一開始應是相位 1／10：${JSON.stringify(g)}`);
step(`時間軸列：${g.text}`);

// 2
await waitFor(`document.querySelectorAll('.time-resident i.is-loaded').length === 10`, '10 個相位的低解析度都到', 60000);
step('10 個相位的低解析度都預抓到了');

// 3
await sleep(1500);
const px0 = await axialPixels();
await clickTitle('下一個');
await sleep(400);
g = await group();
if (g.cursor !== 1) throw new Error(`下一格應到相位 2：${JSON.stringify(g)}`);
requests.length = 0;
await setSlider(3);
await waitFor(`Number(document.querySelector('.time-group').dataset.cursor) === 3`, '滑桿跳到相位 4', 5000);
await sleep(2500);
const px3 = await axialPixels();
const changed = diffCount(px0, px3);
if (changed < 20) throw new Error(`換相位後軸向格應該不同：只有 ${changed} 個取樣像素變了`);
// 預算放得下時每一幀的全解析度在背景就預抓好了（像影片一樣播放）—— 相位 4 的全解析度可能早就到了；
// 檢查的是「停在相位 4 時它是全解析度」（載入條那一格 is-full），不是「停下來才發請求」
await waitFor(`document.querySelectorAll('.time-resident i')[3]?.classList.contains('is-full')`, '停在相位 4 時它是全解析度', 20000);
const fullRes = requests.filter((u) => /\/image\?/.test(u) && /lod=0/.test(u) && /frame=3/.test(u));
step(`下一格 → 相位 2；滑桿 → 相位 4：軸向格 ${changed} 個取樣像素變了；相位 4 是全解析度（${fullRes.length > 0 ? '停下來才補抓' : '背景已預抓'}）`);
await shot('temporal-phase4.png');

// 4
await clickTitle('播放');
await sleep(1600);
const a = await group();
await sleep(800);
const b = await group();
if (!a.playing || a.cursor === 3 || b.cursor === a.cursor) throw new Error(`播放時游標應自己走：${JSON.stringify([a, b])}`);
await clickTitle('暫停');
await sleep(300);
const c1 = await group();
await sleep(800);
const c2 = await group();
if (c1.playing || c1.cursor !== c2.cursor) throw new Error(`暫停後應停住：${JSON.stringify([c1, c2])}`);
step(`播放：游標 ${a.cursor} → ${b.cursor}；暫停後停在 ${c2.cursor + 1}`);

// 5
await setNumber('播放範圍開頭', 3);
await setNumber('播放範圍結尾', 5);
await clickTitle('播放');
const seen = new Set();
for (let i = 0; i < 12; i += 1) {
  await sleep(250);
  seen.add((await group()).cursor);
}
await clickTitle('暫停');
const outside = [...seen].filter((f) => f < 2 || f > 4);
if (outside.length > 0 || seen.size < 2) throw new Error(`範圍 3–5 播放應只在相位 3–5：${[...seen].map((f) => f + 1)}`);
step(`播放範圍 3–5：看到相位 ${[...seen].sort().map((f) => f + 1).join('、')}`);

// 6
g = await group();
if (g.dots !== 10) throw new Error(`時間曲線應有 10 個點：${g.dots}`);
await evaluate(`document.querySelectorAll('.time-curve circle')[7].dispatchEvent(new MouseEvent('click', { bubbles: true })); true`);
await sleep(300);
if ((await group()).cursor !== 7) throw new Error('點曲線上的點應跳到那個相位');
step('時間曲線 10 個點；點第 8 個 → 相位 8');

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
