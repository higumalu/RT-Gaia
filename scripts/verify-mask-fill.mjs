#!/usr/bin/env node
/**
 * 結構填色 —— headless Chrome ＋ CDP（骨架同 `verify-measure-angles.mjs`、零相依）：
 *
 *   1. 開檢視器（要有病例）→ 顯示五個非 BODY 的結構
 *   2. 第一個結構改「填色」→ 軸向格的像素真的變了（結構內多了一層顏色）、列上出現填色標記
 *   3. 再改三個（共 4 個）→ 第五個的選單裡「填色」不能選（上限 4）
 *   4. BODY 的選單裡「填色」不能選（EXTERNAL 只給輪廓）
 *   5. 全部改回輪廓 → 像素回到原樣
 *
 * 需要一個開著病例的堆疊，例如：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-mask-fill.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR] [--token <rtgaia_session>]
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

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-fill-'));
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
  await shot('fill-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);
/**
 * 軸向格**影像 canvas**的像素（取樣）指紋：回一個數字陣列，用來比「變了沒」。
 * 🔴 只看 `.rt-image-canvas`（填色畫在這一層）：以前連向量層一起比，改「填色」時輪廓線消失也算「變了」，
 * 填色其實沒上畫面也照樣通過（2026-09-29 劑量 colorwash／填色不見的回歸）。
 */
const axialPixels = () =>
  evaluate(`(() => {
    const cell = [...document.querySelectorAll('.viewport-cell')].find((c) => c.querySelector('.viewport-label')?.textContent.trim() === '軸向');
    const out = [];
    for (const c of cell.querySelectorAll('canvas.rt-image-canvas')) {
      const g = c.getContext('2d');
      if (!g || c.width === 0) continue;
      const d = g.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4 * 7) out.push(d[i], d[i + 1], d[i + 2]);
    }
    return out;
  })()`);
const diffCount = (a, b) => {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 3) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) n += 1;
  return n;
};
const rowNames = () => evaluate(`[...document.querySelectorAll('.structure-list li[data-status]')].map((li) => li.querySelector('.name')?.textContent.trim())`);
const rowSel = (name) => `[...document.querySelectorAll('.structure-list li[data-status]')].find((li) => li.querySelector('.name')?.textContent.trim() === ${JSON.stringify(name)})`;
const activate = async (name) => {
  await evaluate(`${rowSel(name)}.querySelector('.name').click(); true`);
  await waitFor(`!!${rowSel(name)}?.querySelector('select.render-style')`, `${name} 的樣式選單`, 5000);
};
const setStyle = async (name, style) => {
  await activate(name);
  await evaluate(`(() => { const s = ${rowSel(name)}.querySelector('select.render-style'); s.value = ${JSON.stringify(style)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(900);
};
const fillOptionDisabled = async (name) => {
  await activate(name);
  return evaluate(`${rowSel(name)}.querySelector('select.render-style option[value="fill"]').disabled`);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && document.querySelectorAll('.structure-list li[data-status]').length >= 6`, '病例載入（要先開一個病例）');
await sleep(1500);

// 1
const names = (await rowNames()).filter(Boolean);
const body = names.find((n) => /^(body|external)$/i.test(n));
// 挑軸向中心附近比較可能有的結構：優先已知的大器官／靶區
const prefer = ['Bladder', 'Bowel_Small', 'Bowel_Large', 'CTV_5000(ART)', 'CTV_4500(ART)', 'Rectum', 'SpinalCord', 'Liver'];
const picks = [...prefer.filter((n) => names.includes(n)), ...names.filter((n) => n !== body && !prefer.includes(n))].slice(0, 5);
for (const n of picks) {
  await evaluate(`(() => { const cb = ${rowSel(n)}.querySelector('input[type=checkbox]'); if (!cb.checked) cb.click(); return true; })()`);
}
await waitFor(`!document.querySelector('.mask-loading')`, '結構 mask 載入完', 60000);
await sleep(1500);
const base = await axialPixels();
step(`顯示 ${picks.join('、')}（BODY：${body ?? '無'}）`);

// 2：找一個填了會改到軸向像素的（有些結構不在目前這一層）
let first = null;
let after = null;
for (const n of picks) {
  await setStyle(n, 'fill');
  after = await axialPixels();
  if (diffCount(base, after) > 30) {
    first = n;
    break;
  }
  await setStyle(n, 'outline');
}
if (first === null) throw new Error('五個結構改填色都沒改到軸向格的像素（目前這一層都沒有？）');
if (!(await evaluate(`!!${rowSel(first)}.querySelector('.fill-badge')`))) throw new Error('填色的列要有標記');
step(`${first} 改填色：軸向格 ${diffCount(base, after)} 個取樣像素變了；列上有填色標記`);
await shot('fill-one.png');

// 3
const others = picks.filter((n) => n !== first);
for (const n of others.slice(0, 3)) await setStyle(n, 'fill+outline');
const badges = await evaluate(`document.querySelectorAll('.structure-list .fill-badge').length`);
if (badges !== 4) throw new Error(`應有 4 個填色：${badges}`);
if (!(await fillOptionDisabled(others[3]))) throw new Error('第五個結構的「填色」應不能選');
step(`4 個填色後，${others[3]} 的「填色」不能選（上限 4）`);
await shot('fill-four.png');

// 4
if (body) {
  for (const n of [first, ...others.slice(0, 3)]) await setStyle(n, 'outline');
  if (!(await fillOptionDisabled(body))) throw new Error('BODY 的「填色」應不能選');
  step(`${body} 的「填色」不能選（EXTERNAL 只給輪廓）`);
} else {
  for (const n of [first, ...others.slice(0, 3)]) await setStyle(n, 'outline');
}

// 5
await sleep(800);
const back = await axialPixels();
if (diffCount(base, back) > 10) throw new Error(`全部改回輪廓後像素應回到原樣：${diffCount(base, back)} 個不同`);
if ((await evaluate(`document.querySelectorAll('.structure-list .fill-badge').length`)) !== 0) throw new Error('改回輪廓後不該有填色標記');
step('全部改回輪廓：像素回到原樣');
for (const n of picks) await evaluate(`(() => { const cb = ${rowSel(n)}.querySelector('input[type=checkbox]'); if (cb.checked) cb.click(); return true; })()`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
