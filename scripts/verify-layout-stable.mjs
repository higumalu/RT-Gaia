#!/usr/bin/env node
/**
 * 十字線從軸向移到冠狀，整個視窗抖一下 —— 指標經過影像外時時間軸列的時間曲線整塊消失（列高 93 → 84 px，
 * 上面的影像格跟著被推上去再拉回來）；曲線旁的數值、狀態列的座標字數不同也讓整列左右跳。
 * headless Chrome ＋ CDP（骨架同 `verify-temporal-playback.mjs`、零相依）。
 *
 *   SYN4D-CT1（4D 組，有時間軸列）：指標在軸向 → 冠狀之間來回移動、點擊、按住拖曳 →
 *   影像區（.app-body）與底部面板高度不變、時間軸列的按鈕／滑桿／fps 位置不變、狀態列讀數的起點不變、
 *   layout-shift 合計 < 0.001
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-layout-stable.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR] [--token <rtgaia_session>]
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
const port = Number(args.port ?? 9338);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-layout-'));
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
  await shot('layout-failed.png').catch(() => undefined);
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


/** 會被推動的東西：影像區、底部面板的高度；時間軸列與狀態列各元件的位置。 */
const GEOMETRY = `(() => {
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
  const g = document.querySelector('.time-group');
  return {
    body: r(document.querySelector('.app-body')),
    bottom: r(document.querySelector('.bottom-panels')),
    timeButtons: r(g?.querySelector('.time-buttons')),
    slider: r(g?.querySelector('.time-slider')),
    fps: r(g?.querySelector('select')?.parentElement),
    range: r(g?.querySelector('.time-range')),
    curve: r(g?.querySelector('.time-curve')),
    probeWorld: r(document.querySelector('.probe-world'))?.slice(0, 2),
  };
})()`;
const INSTALL = `(() => { window.__shift = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__shift += e.value; }).observe({ type: 'layout-shift' }); return true; })()`;

await openStudy('SYN4D-CT1', 'synth4d');
await waitFor(`!!${rowWith('temporal', '4D · 10 個相位')}`, 'SYN4D-CT1 的 4D 組');
await evaluate(`${rowWith('temporal', '4D · 10 個相位')}.querySelector('input[type=checkbox]').click(); true`);
await openCase(true);
await waitFor(`!!document.querySelector('.time-group .time-curve')`, '時間軸列有時間曲線');
await sleep(2000);
const ax = await centerOf(cellSel('軸向') + ".querySelector('canvas')");
const co = await centerOf(cellSel('冠狀') + ".querySelector('canvas')");
// 先指在軸向影像上，讓讀數、曲線都出現 → 當基準
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ax.x, y: ax.y });
await sleep(500);
const base = await evaluate(GEOMETRY);
if (base.curve === null) throw new Error('指在影像上沒有時間曲線');
await evaluate(INSTALL);
const diffs = [];
const check = async (what) => {
  const now = await evaluate(GEOMETRY);
  for (const k of Object.keys(base)) if (JSON.stringify(now[k]) !== JSON.stringify(base[k])) diffs.push(`${what}：${k} ${JSON.stringify(base[k])} → ${JSON.stringify(now[k])}`);
};
const moveLine = async (a, b, buttons, what) => {
  for (let i = 0; i <= 40; i += 1) {
    const x = a.x + ((b.x - a.x) * i) / 40;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: a.y, buttons, button: buttons ? 'left' : 'none' });
    await sleep(25);
    // 只在有讀數的地方比狀態列（沒指到時是「N/A」、後面沒有東西）；高度與時間軸列每一步都比
    await check(`${what} x=${Math.round(x)}`);
  }
};
await moveLine(ax, co, 0, '指標 軸向→冠狀');
await moveLine(co, ax, 0, '指標 冠狀→軸向');
await clickAt(co.x + 10, co.y + 10);
await clickAt(ax.x, ax.y);
await check('點冠狀再點軸向');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ax.x, y: ax.y, button: 'left', buttons: 1, clickCount: 1 });
await moveLine(ax, co, 1, '拖曳 軸向→冠狀');
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: co.x, y: co.y, button: 'left', buttons: 0, clickCount: 1 });
await sleep(500);
await check('放開');
const shift = await evaluate('window.__shift');
await shot('layout-stable.png');
// probeWorld 在沒指到時變成「N/A」—— 位置（起點）仍要相同，這裡一併比
const unique = [...new Set(diffs.map((d) => d.replace(/ x=\d+/, '')))];
if (unique.length > 0) throw new Error(`版面跳動：\n  ${unique.slice(0, 12).join('\n  ')}`);
step(`指標、點擊、拖曳 軸向↔冠狀：影像區與底部面板高度、時間軸列、狀態列都沒動`);
if (shift >= 0.001) throw new Error(`layout-shift 合計 ${shift.toFixed(4)}`);
step(`layout-shift 合計 ${shift.toFixed(4)}`);
if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
