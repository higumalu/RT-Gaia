#!/usr/bin/env node
/**
 * 劑量顯示補強 —— headless Chrome ＋ CDP（骨架同 `verify-ui-polish.mjs`、零相依），真的滑鼠／鍵盤事件：
 *
 *   有處方的計畫劑量：等劑量線來源「% 處方」、2D 格右下角圖例 9 條、3D 格沒有圖例
 *   圖例改線色 → 影像上真的出現那個顏色的等劑量線；「重設顏色」恢復
 *   level 改「20,10」→「只有這個劑量」、圖例 2 條 →「存成預設」→「我的預設」（偏好存 % [100, 50]）→「清除我的預設」→ 回到 % 處方 9 條
 *   「到 Dmax」→ 十字線移到最大劑量點：三格的切片號 ＝ 後端 Dmax 座標換算到顯示網格的索引
 *   收起圖例 → 每格都收起
 *
 * 需要一個開著量測病例（`.rtgaia/perf/case.json`，要有 RTPLAN 與劑量）的堆疊：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-dose-display.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR]
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
const port = Number(args.port ?? 9343);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-dose20-'));
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
  await shot('dose20-failed.png').catch(() => undefined);
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
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); localStorage.removeItem('rtgaia.dose.isodose.v1'); localStorage.removeItem('rtgaia.dose.legend.open.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.dose-row')`, '病例載入（要有 RTDOSE）');
await waitFor(`!document.querySelector('.mask-loading')`, '載入完', 60000);
await sleep(1000);

const legendIn = (label) => `${cellSel(label)}?.querySelector('.dose-legend')`;
const legendTexts = (label) => evaluate(`[...(${legendIn(label)}?.querySelectorAll('.dose-legend-row') ?? [])].map((r) => r.textContent.trim())`);
const source = () => evaluate(`document.querySelector('.dose-row .dose-level-source')?.dataset.source ?? null`);
const doseRowButton = (label) => `[...document.querySelectorAll('.dose-row button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;

// 1. 有處方 → % 處方；圖例在 2D 格、不在 3D 格
if ((await source()) !== 'prescription') throw new Error(`有處方的劑量應是「% 處方」：${await source()}`);
const axialLegend = await legendTexts('軸向');
if (axialLegend.length !== 9 || axialLegend[0] !== '22 Gy' || axialLegend.at(-1) !== '6 Gy') throw new Error(`軸向圖例應有 9 條（22…6 Gy）：${JSON.stringify(axialLegend)}`);
const cellsWithLegend = await evaluate(`[...document.querySelectorAll('.viewport-cell')].filter((c) => c.querySelector('.dose-legend')).map((c) => c.querySelector('.viewport-label')?.textContent.trim())`);
const has3d = await evaluate(`[...document.querySelectorAll('.viewport-cell')].some((c) => c.querySelector('.render3d-view') && c.querySelector('.dose-legend'))`);
if (has3d || cellsWithLegend.length < 3) throw new Error(`圖例只在 2D 格：${JSON.stringify(cellsWithLegend)}；3D 有圖例 ${has3d}`);
await shot('dose20-legend.png');
step(`有處方：來源「% 處方」，圖例 ${axialLegend.length} 條（${axialLegend[0]}…${axialLegend.at(-1)}），出現在 ${cellsWithLegend.join('、')}，3D 格沒有`);

// 2. 改線色 → 影像上真的出現；先把劑量不透明度拉滿（線的 alpha ＝ opacity＋0.3）、關 colorwash 讓顏色乾淨
await evaluate(`(() => { const r = document.querySelector('.dose-row .opacity input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(r, '1'); r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); const cw = [...document.querySelectorAll('.dose-row label')].find((l) => l.textContent.trim() === 'colorwash')?.querySelector('input'); if (cw?.checked) cw.click(); return true; })()`);
await sleep(600);
const countColor = (rgb) => evaluate(`(() => { const host = ${cellSel('軸向')}.querySelector('.viewport-canvas-host'); let n = 0; for (const c of host.querySelectorAll('canvas')) { const ctx = c.getContext('2d'); if (!ctx) continue; const d = ctx.getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - ${rgb[0]}) < 12 && Math.abs(d[i + 1] - ${rgb[1]}) < 12 && Math.abs(d[i + 2] - ${rgb[2]}) < 12 && d[i + 3] > 200) n += 1; } return n; })()`);
const target = [0, 255, 255];
const before = await countColor(target);
await evaluate(`(() => { const inp = [...${legendIn('軸向')}.querySelectorAll('.dose-legend-row')].find((r) => r.textContent.trim() === '10 Gy').querySelector('input[type=color]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(inp, '#00ffff'); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
await sleep(800);
const after = await countColor(target);
const swatch = await evaluate(`[...${legendIn('冠狀')}.querySelectorAll('.dose-legend-row')].find((r) => r.textContent.trim() === '10 Gy').querySelector('.dose-legend-swatch').style.background`);
if (after < before + 50 || !/0, 255, 255|#00ffff/i.test(swatch)) throw new Error(`改線色後影像上應出現青色線、其他格的圖例同步：像素 ${before} → ${after}、冠狀色塊 ${swatch}`);
await shot('dose20-color.png');
await evaluate(`[...${legendIn('軸向')}.querySelectorAll('button')].find((b) => b.textContent.trim() === '重設顏色').click(); true`);
await sleep(800);
const reset = await countColor(target);
if (reset > before + 20 || (await evaluate(`!!${legendIn('軸向')}.querySelector('.dose-legend-reset')`))) throw new Error(`重設顏色後青色應消失：${reset}`);
step(`線色：10 Gy 改青色 → 軸向格青色像素 ${before} → ${after}、冠狀圖例同步；重設 → ${reset}`);

// 3. level 自訂 → 存成預設 → 清除
const levelInput = `document.querySelector('.dose-row input.levels')`;
// 真的點進欄位、全選、打字、Tab 離開（onBlur 才是「套用到這個劑量」）
// 劑量在左側「劑量」面板（資料面板下面），先捲到看得到
await evaluate(`(${levelInput}).scrollIntoView({ block: 'center' }); true`);
await sleep(200);
const lv = await centerOf(levelInput);
await clickAt(lv.x, lv.y);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
await send('Input.insertText', { text: '20,10' });
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
await sleep(500);
if ((await source()) !== 'custom' || (await legendTexts('軸向')).join() !== '20 Gy,10 Gy') throw new Error(`自訂後應只有這個劑量、2 條：${await source()} ${await legendTexts('軸向')}`);
await evaluate(`${doseRowButton('存成預設')}.click(); true`);
await sleep(400);
const saved = await evaluate(`localStorage.getItem('rtgaia.dose.isodose.v1')`);
if ((await source()) !== 'user-default' || JSON.stringify(JSON.parse(saved ?? '{}')) !== JSON.stringify({ percents: [100, 50] }) || (await legendTexts('軸向')).join() !== '20 Gy,10 Gy') throw new Error(`存成預設：${await source()} ${saved} ${await legendTexts('軸向')}`);
if (!(await evaluate(`!!${doseRowButton('清除我的預設')}`))) throw new Error('存了預設後應出現「清除我的預設」');
await shot('dose20-default.png');
await evaluate(`${doseRowButton('清除我的預設')}.click(); true`);
await sleep(400);
if ((await source()) !== 'prescription' || (await legendTexts('軸向')).length !== 9 || (await evaluate(`localStorage.getItem('rtgaia.dose.isodose.v1')`)) !== null) throw new Error(`清除預設後應回到 % 處方 9 條：${await source()} ${await legendTexts('軸向')}`);
step('level「20,10」→ 只有這個劑量；存成預設 → 我的預設（偏好 {percents:[100,50]}）；清除 → % 處方 9 條');

// 4. 到 Dmax：十字線交點的劑量讀數 ≈ 後端 Dmax
const doseId = await evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => (s.layers ?? s.state?.layers ?? []).find((l) => l.kind === 'dose').contentRef)`);
const dmax = await evaluate(`fetch('/api/v1/dose/' + encodeURIComponent(${JSON.stringify(doseId)}) + '/max').then((r) => r.json())`);
const slicesBefore = await evaluate(`Object.fromEntries([...document.querySelectorAll('.viewport-cell')].map((c) => [c.querySelector('.viewport-label')?.textContent.trim(), c.querySelector('.viewport-slice')?.textContent.trim()]))`);
await evaluate(`${doseRowButton('到 Dmax')}.click(); true`);
await sleep(1200);
const slicesAfter = await evaluate(`Object.fromEntries([...document.querySelectorAll('.viewport-cell')].map((c) => [c.querySelector('.viewport-label')?.textContent.trim(), c.querySelector('.viewport-slice')?.textContent.trim()]))`);
// 期望的切片：Dmax 的 primary 座標 → 顯示網格索引（軸對齊的 CT；label 是 1 起算）
const g = await evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.gridSet.display_grid.grid)`);
const idx = [0, 1, 2].map((a) => Math.round((dmax.world_primary_mm[a] - g.origin[a]) / g.spacing[a]));
const want = { 軸向: `${idx[2] + 1} / ${g.size[2]}`, 矢狀: `${idx[0] + 1} / ${g.size[0]}`, 冠狀: `${idx[1] + 1} / ${g.size[1]}` };
const off = Object.entries(want).filter(([k, v]) => {
  const got = Number(String(slicesAfter[k]).split('/')[0]);
  return Math.abs(got - Number(v.split('/')[0])) > 1; // 剛好落在兩張中間時四捨五入可能差一張
});
if (off.length) throw new Error(`到 Dmax 後的切片應是 ${JSON.stringify(want)}：實際 ${JSON.stringify(slicesAfter)}（之前 ${JSON.stringify(slicesBefore)}）`);
await shot('dose20-dmax.png');
step(`到 Dmax（${dmax.max_gy.toFixed(2)} Gy）：切片 ${JSON.stringify(slicesBefore)} → ${JSON.stringify(slicesAfter)}，與 Dmax 座標換算的 ${JSON.stringify(want)} 一致`);

// 5. 收起圖例 → 每格都收起
await evaluate(`${legendIn('軸向')}.querySelector('.dose-legend-toggle').click(); true`);
await sleep(300);
const rowsLeft = await evaluate(`document.querySelectorAll('.dose-legend-row').length`);
const allClosed = await evaluate(`[...document.querySelectorAll('.dose-legend')].every((l) => l.dataset.open === 'false')`);
if (rowsLeft !== 0 && !allClosed) throw new Error(`收起後各格都收起：還有 ${rowsLeft} 列`);
step('收起圖例：狀態記在這台瀏覽器');

// 英文模式：劑量列的新按鈕、來源標示、圖例沒有中文（先把圖例打開）
await evaluate(`localStorage.setItem('rtgaia.dose.legend.open.v1', '1'); true`);
await send('Page.navigate', { url: url.replace('/#/', '/?lang=en#/') });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.dose-row .dose-level-source') && !!document.querySelector('.dose-legend-row')`, '英文模式載入');
const enText = await evaluate(`[...document.querySelectorAll('.dose-row button, .dose-row .dose-level-source, .dose-legend')].map((el) => el.textContent + ' ' + (el.title ?? '')).join(' | ')`);
const cjk = enText.match(/[\u3000-\u9fff\uff00-\uffef]+/g);
if (cjk) throw new Error(`英文模式還有中文：${cjk.join(' ')} —— ${enText.slice(0, 300)}`);
step('英文模式：劑量列按鈕、來源標示、圖例沒有中文');

if (errors.length) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
