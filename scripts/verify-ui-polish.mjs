#!/usr/bin/env node
/**
 * 介面細節（左欄設定、匯出目標名稱、作用中的格子、點擊目標、資料庫目錄）—— headless Chrome ＋ CDP（骨架同 `verify-mask-fill.mjs`、零相依），真的滑鼠事件：
 *
 *   左欄：影像列的設定預設收起（作用中的也是）；「設定 ▸」手動展開、切顯示不收；劑量取消顯示就收起、再勾回展開
 *   匯出：目標選單以「模態 日期 描述」呈現（不是「次要影像 …FoR 尾碼」），摘要用同一個名字
 *   作用中的格子：點哪一格就標哪一格；點側欄的東西不改變它
 *   小圖示的可點範圍 ≥ 24×24（dock 摺疊／位置、資料庫列的送出／下載／刪除）
 *   資料庫目錄不再宣告 role="tree"，有 aria-label
 *
 * 需要一個開著病例（有 secondary 影像組與 RTDOSE）的堆疊，例如：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-ui-polish.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR] [--token <rtgaia_session>]
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

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-uib3-'));
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
  await shot('uib3-failed.png').catch(() => undefined);
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
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && document.querySelectorAll('.frame-group').length >= 2 && !!document.querySelector('.dose-row')`, '病例載入（要有 secondary 影像組與 RTDOSE）');
await waitFor(`!document.querySelector('.mask-loading')`, '載入完', 60000);
await sleep(1000);

// 左欄影像列的設定
const rows = await evaluate(`[...document.querySelectorAll('.image-row')].map((r) => ({ vis: r.dataset.visible, exp: r.dataset.expanded, active: r.querySelector('.active-pick input').checked, wl: !!r.querySelector('.wl') }))`);
// 影像列的設定一律預設收起（作用中的也是）；按「設定」才展開，展開後切顯示也不收
if (rows.length === 0 || rows.some((r) => r.exp !== 'false' || r.wl)) throw new Error(`影像列的設定應預設收起：${JSON.stringify(rows)}`);
const hidden = rows.filter((r) => r.vis === 'false');
await evaluate(`document.querySelector('.image-row').querySelector('.row-more').click(); true`);
await sleep(200);
if (!(await evaluate(`document.querySelector('.image-row').dataset.expanded === 'true' && !!document.querySelector('.image-row .wl')`))) throw new Error('「設定 ▸」應能手動展開');
await evaluate(`document.querySelector('.image-row .visibility input').click(); true`);
await sleep(300);
await evaluate(`document.querySelector('.image-row .visibility input').click(); true`);
await sleep(300);
if ((await evaluate(`document.querySelector('.image-row').dataset.expanded`)) !== 'true') throw new Error('手動展開後切顯示不該收起');
// 劑量：取消顯示 → 收起；勾回 → 展開
const doseExp = () => evaluate(`document.querySelector('.dose-row').dataset.expanded`);
if ((await doseExp()) !== 'true') throw new Error('可見的劑量應展開');
await evaluate(`document.querySelector('.dose-row .visibility input').click(); true`);
await sleep(400);
const collapsed = await doseExp();
const noThreshold = await evaluate(`!document.querySelector('.dose-row .levels')`);
await evaluate(`document.querySelector('.dose-row .visibility input').click(); true`);
await sleep(400);
if (collapsed !== 'false' || !noThreshold || (await doseExp()) !== 'true') throw new Error(`劑量顯示／隱藏應跟著展開／收起：隱藏時 ${collapsed}`);
await shot('uib3-left.png');
step(`左欄：影像列設定預設收起（${rows.length} 張，${hidden.length} 張隱藏）、手動展開可用且切顯示不收、劑量隱藏時收起`);

// 作用中的格子
const ax = await centerOf(`${cellSel('軸向')}.querySelector('.viewport-canvas-host')`);
await clickAt(ax.x, ax.y);
if (!(await evaluate(`${cellSel('軸向')}.classList.contains('is-active')`))) throw new Error('點軸向後軸向應是作用中');
const co = await centerOf(`${cellSel('冠狀')}.querySelector('.viewport-canvas-host')`);
await clickAt(co.x, co.y);
const activeNow = await evaluate(`[...document.querySelectorAll('.viewport-cell.is-active')].map((c) => c.querySelector('.viewport-label')?.textContent.trim())`);
if (activeNow.join() !== '冠狀') throw new Error(`點冠狀後只有冠狀是作用中：${activeNow}`);
const side = await centerOf(`document.querySelector('.image-row .row-more')`);
await clickAt(side.x, side.y);
const afterSide = await evaluate(`[...document.querySelectorAll('.viewport-cell.is-active')].map((c) => c.querySelector('.viewport-label')?.textContent.trim())`);
if (afterSide.join() !== '冠狀') throw new Error(`點側欄不該改變作用中的格子：${afterSide}`);
step('作用中的格子：點哪一格標哪一格（軸向 → 冠狀），點側欄不變');

// 小圖示的可點範圍（檢視器的 dock）
const dockSizes = await evaluate(`[...document.querySelectorAll('.dock-fold, .dock-menu')].map((el) => { const r = el.getBoundingClientRect(); return [el.className, Math.round(r.width), Math.round(r.height)]; })`);
const smallDock = dockSizes.filter(([, w, h]) => w < 24 || h < 24);
if (dockSizes.length === 0 || smallDock.length > 0) throw new Error(`dock 按鈕應 ≥ 24×24：${JSON.stringify(smallDock.length ? smallDock : dockSizes)}`);

// 匯出目標的名稱
await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '匯出' || b.textContent.trim().endsWith(' 匯出'))?.click(); true`);
await waitFor(`!!document.querySelector('.export-panel .target select')`, '匯出面板的目標選單', 10000);
const opts = await evaluate(`[...document.querySelectorAll('.export-panel .target select option')].map((o) => o.textContent.trim())`);
const summary = await evaluate(`document.querySelector('.export-panel .export-summary').textContent`);
if (opts.some((o) => /次要影像|主要影像/.test(o)) || !opts.every((o) => /^(CT|CBCT|MR|PT)\s\d{4}-\d{2}-\d{2}/.test(o))) throw new Error(`目標應以模態＋日期＋描述呈現：${JSON.stringify(opts)}`);
if (!summary.includes(opts.find((o) => o.includes('（主要）')) ?? '???')) throw new Error(`摘要應用同一個名字：${summary}`);
await shot('uib3-export.png');
step(`匯出：目標 ${opts.length} 個（${opts.map((o) => o.slice(0, 22)).join('／')}）；摘要同名`);

// 小圖示的可點範圍（資料庫列）＋ 資料庫目錄的 role
await send('Page.navigate', { url: `${origin}/#/library` });
await waitFor(`document.querySelectorAll('.catalog-tree tr.patient-row').length > 0`, '資料庫頁', 30000);
const lib = await evaluate(`(() => {
  const t = document.querySelector('.catalog-tree');
  const sizes = [...document.querySelectorAll('.catalog-tree .send-btn, .catalog-tree .delete-btn, .catalog-tree .download')].slice(0, 12).map((el) => { const r = el.getBoundingClientRect(); return [el.className, Math.round(r.width), Math.round(r.height), el.getAttribute('aria-label')]; });
  return { role: t.getAttribute('role'), label: t.getAttribute('aria-label'), sizes };
})()`);
if (lib.role !== null || !lib.label) throw new Error(`資料庫目錄不該宣告 role=tree、要有 aria-label：${JSON.stringify({ role: lib.role, label: lib.label })}`);
const smallLib = lib.sizes.filter(([, w, h, name]) => w < 24 || h < 24 || !name);
if (lib.sizes.length === 0 || smallLib.length > 0) throw new Error(`資料庫列的圖示按鈕應 ≥ 24×24 且有名稱：${JSON.stringify(smallLib.length ? smallLib : lib.sizes)}`);
step(`可點範圍：dock ${dockSizes.length} 個、資料庫列 ${lib.sizes.length} 個圖示都 ≥ 24×24 且有名稱；資料庫目錄：role=${lib.role}、aria-label「${lib.label}」`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
