#!/usr/bin/env node
/**
 * 劑量運算（「劑量物件」模型）—— headless Chrome ＋ CDP（骨架同 `verify-plan-panel.mjs`、零相依），
 * 真的滑鼠／鍵盤事件，走一次最常見的流程：
 *
 *   左側「劑量」面板依空間分組（CT 主要、CBCT 06-17、CBCT 06-18），每組各一個劑量
 *   選 fx1 → 套用 REG（→ CT）→ 新劑量出現在 CT 空間；fx2 同樣
 *   選搬過來的 fx2 → ＋：B 只列同一個空間的劑量（沒有原本的 CBCT 劑量）→ 選 fx1 → 已照
 *   選計畫 → × 0.2 → 計畫的兩個分次；選已照 → − 計畫 × 0.2 → 差異（有負值）
 *   只顯示差異 → 軸向格有藍也有紅；差值統計；「在 DVH 看」已照與計畫 → DVH 勾了這兩個
 *   選原本的 fx1 → ＋：提示「同一個空間沒有其他劑量」（不同空間不能直接運算）
 *   差異「存檔…」→ 右側存檔表單 → 下載 RTDOSE（ERROR）；「丟棄」→ 少一個
 *   英文模式沒有中文
 *
 * 需要一個開著量測病例（`.rtgaia/perf/case.json`，含兩個分次劑量；`PERF_ALL_DOSES=1 stack.sh load`）的堆疊：
 *   scripts/perf/stack.sh start && PERF_ALL_DOSES=1 scripts/perf/stack.sh load
 *   node scripts/verify-dose-ops.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR]
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
const port = Number(args.port ?? 9345);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-doseops21-'));
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
  await shot('doseops21-failed.png').catch(() => undefined);
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

const setValue = (selector, value, kind = 'input') =>
  evaluate(`(() => { const el = ${selector}; const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))}); el.dispatchEvent(new Event(${JSON.stringify(kind)}, { bubbles: true })); return true; })()`);
const clickEl = async (expr) => {
  await evaluate(`(${expr}).scrollIntoView({ block: 'center' }); true`);
  const c = await centerOf(expr);
  await clickAt(c.x, c.y);
};
const panel = `document.querySelector('.dose-panel')`;
const spaces = () => evaluate(`[...${panel}.querySelectorAll('.dose-space')].map((sp) => ({ title: sp.querySelector('.dose-space-head').textContent, doses: [...sp.querySelectorAll('.dose-object')].map((li) => ({ id: li.dataset.series, name: li.querySelector('.dose-object-name').textContent, derived: li.dataset.derived === 'true' })) }))`);
const objectBy = (pred) => `[...${panel}.querySelectorAll('.dose-object')].find((li) => (${pred})(li))`;
const byName = (re) => objectBy(`(li) => ${re}.test(li.querySelector('.dose-object-name').textContent)`);
const actions = `${panel}.querySelector('.dose-actions')`;
const select = async (rowExpr) => {
  // 剛產生的結果會自動選取；已選的再點一次是取消選取 —— 沒選才點
  if (!(await evaluate(`(${rowExpr}).classList.contains('selected')`))) await clickEl(`(${rowExpr}).querySelector('.dose-object-name')`);
  await waitFor(`!!(${rowExpr})?.querySelector('.dose-actions')`, '選取後出現動作', 10000);
  await sleep(300);
};
const countObjects = () => evaluate(`${panel}.querySelectorAll('.dose-object').length`);
const countColors = async () => {
  const r = await evaluate(`(() => { const b = ${cellSel('軸向')}.querySelector('.viewport-canvas-host').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  return evaluate(`new Promise((resolve) => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let blue = 0, red = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 2] > d[i] + 60 && d[i + 2] > d[i + 1] + 20) blue += 1; if (d[i] > d[i + 2] + 60 && d[i] > d[i + 1] + 40) red += 1; } resolve({ blue, red }); }; img.src = 'data:image/png;base64,${data}'; })`);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!${panel}`, '病例載入（左側「劑量」面板）');
await waitFor(`!document.querySelector('.mask-loading')`, '載入完', 60000);
const sid = await evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.studyId)`);
await evaluate(`fetch('/api/v1/studies/' + encodeURIComponent(${JSON.stringify(sid)}) + '/dose-ops').then((r) => r.json()).then((j) => Promise.all(j.results.map((x) => fetch('/api/v1/studies/' + encodeURIComponent(${JSON.stringify(sid)}) + '/dose-ops/' + x.series_id, { method: 'DELETE' }))))`);
await waitFor(`${panel}.querySelectorAll('.dose-space').length === 3 && ${panel}.querySelectorAll('.dose-object').length === 3`, '三個空間各一個劑量', 20000);

// 1. 依空間分組
const sp0 = await spaces();
if (!/主要/.test(sp0[0].title) || !sp0.slice(1).every((s) => /CBCT/.test(s.title))) throw new Error(`空間分組：${JSON.stringify(sp0)}`);
step(`依空間分組：${sp0.map((s) => `${s.title}〔${s.doses.map((d) => d.name).join('、')}〕`).join('；')}`);
const ctSpace = `${panel}.querySelectorAll('.dose-space')[0]`;
const ctDoses = () => evaluate(`[...${ctSpace}.querySelectorAll('.dose-object')].map((li) => li.querySelector('.dose-object-name').textContent)`);

// 2. fx1、fx2 套用 REG → CT
for (const [i, tag] of [[1, '06-17'], [2, '06-18']]) {
  await select(`${panel}.querySelectorAll('.dose-space')[${i}].querySelector('.dose-object')`);
  const opts = await evaluate(`[...${actions}.querySelectorAll('select[data-field="transform"] option')].map((o) => o.textContent)`);
  if (!opts.some((o) => /^REG .*→ CT/.test(o))) throw new Error(`fx ${tag} 的 REG 選項：${JSON.stringify(opts)}`);
  const before = (await ctDoses()).length;
  await clickEl(`[...${actions}.querySelectorAll('.dose-action-reg button')].find((b) => /套用/.test(b.textContent))`);
  await waitFor(`${ctSpace}.querySelectorAll('.dose-object').length === ${before + 1}`, `fx ${tag} 搬到 CT 空間`, 20000);
  step(`fx ${tag}：選項 ${JSON.stringify(opts)} → 套用 → CT 空間多「${(await ctDoses()).at(-1)}」`);
}

// 3. 已照 ＝ fx2→CT ＋ fx1→CT（B 只列同一個空間的）
await select(byName('/06-18 →/'));
await clickEl(`${actions}.querySelector('.dose-op-ops button[data-op="add"]')`);
const bOpts = await evaluate(`[...${actions}.querySelectorAll('select[data-field="b"] option')].map((o) => o.textContent)`);
if (bOpts.length !== 2 || bOpts.some((o) => !/→|C\.C\+PALN/.test(o))) throw new Error(`B 應只列 CT 空間的劑量：${JSON.stringify(bOpts)}`);
const fx1ct = await evaluate(`[...${actions}.querySelectorAll('select[data-field="b"] option')].find((o) => /06-17 →/.test(o.textContent)).value`);
await setValue(`${actions}.querySelector('select[data-field="b"]')`, fx1ct, 'change');
let n = await countObjects();
await clickEl(`${actions}.querySelector('button[data-action="compute"]')`);
await waitFor(`${panel}.querySelectorAll('.dose-object').length === ${n + 1}`, '已照', 20000);
step(`已照：B 選項 ${JSON.stringify(bOpts)} → 「${(await ctDoses()).at(-1)}」`);

// 4. 計畫 × 0.2
await select(byName('/^C\\.C\\+PALN/'));
await clickEl(`${actions}.querySelector('.dose-op-ops button[data-op="mul"]')`);
await clickEl(`${actions}.querySelector('input[data-field="k"]')`);
await send('Input.insertText', { text: '0.2' });
n = await countObjects();
await clickEl(`${actions}.querySelector('button[data-action="compute"]')`);
await waitFor(`${panel}.querySelectorAll('.dose-object').length === ${n + 1}`, '計畫 × 0.2', 20000);
step(`計畫兩個分次：「${(await ctDoses()).at(-1)}」`);

// 5. 差異 ＝ 已照 − 計畫 × 0.2
await select(byName('/\\) \\+ \\(/'));
await clickEl(`${actions}.querySelector('.dose-op-ops button[data-op="sub"]')`);
const planned = await evaluate(`[...${actions}.querySelectorAll('select[data-field="b"] option')].find((o) => /× 0\\.2/.test(o.textContent)).value`);
await setValue(`${actions}.querySelector('select[data-field="b"]')`, planned, 'change');
n = await countObjects();
await clickEl(`${actions}.querySelector('button[data-action="compute"]')`);
await waitFor(`${panel}.querySelectorAll('.dose-object').length === ${n + 1}`, '差異', 20000);
await sleep(500);
const diffRow = byName('/\\) − \\(/');
const diffSummary = await evaluate(`(${diffRow}).querySelector('.dose-actions .muted.small')?.textContent ?? ''`);
if (!/-\d/.test(diffSummary)) throw new Error(`差異應有負值：${diffSummary}`);
step(`差異：${diffSummary}`);

// 6. 只顯示差異 → 藍與紅；差值統計
await clickEl(`(${diffRow}).querySelector('.dose-jump-max')`);
await sleep(800);
const showOnly = (expr) => evaluate(`[...document.querySelectorAll('.dose-object')].forEach((li) => { const box = li.querySelector('.visibility input'); const want = li === (${expr}); if (box.checked !== want) box.click(); }); true`);
await showOnly('null');
await sleep(1200);
const base = await countColors();
await showOnly(diffRow);
let on = await countColors();
for (let i = 0; i < 30 && (on.blue - base.blue < 20 || on.red - base.red < 20); i += 1) {
  await sleep(500);
  on = await countColors();
}
if (on.blue - base.blue < 20 || on.red - base.red < 20) throw new Error(`差異應有藍有紅：關 ${JSON.stringify(base)}、開 ${JSON.stringify(on)}`);
await shot('doseops21-diff.png');
await clickEl(`[...(${diffRow}).querySelectorAll('.dose-actions .buttons button')].find((b) => /差值統計/.test(b.textContent))`);
await waitFor(`!!(${diffRow}).querySelector('.signed-stats tbody tr')`, '差值統計', 20000);
step(`差異的色階：藍 +${on.blue - base.blue}、紅 +${on.red - base.red}；差值統計 ${await evaluate(`(${diffRow}).querySelectorAll('.signed-stats tbody tr').length`)} 列`);

// 6b. 色階範圍（差值要能調 color bar 的上下界）：±2.1 → ±0.1 Gy，細微的差異變得看得見
const colored = async () => {
  const c = await countColors();
  return c.blue + c.red;
};
const wide = await colored();
const rangeInput = (f) => `(${diffRow}).querySelector('.dose-range input[data-field="${f}"]')`;
for (const [f, v] of [['range-lo', '-0.1'], ['range-hi', '0.1']]) {
  await clickEl(rangeInput(f));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await send('Input.insertText', { text: v });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(300);
}
let narrow = await colored();
for (let i = 0; i < 20 && narrow < wide * 1.3; i += 1) {
  await sleep(300);
  narrow = await colored();
}
const barLabels = await evaluate(`[...(${cellSel('軸向')}).querySelectorAll('.dose-colorbar-labels span')].map((x) => x.textContent)`);
if (narrow < wide * 1.3 || barLabels.join() !== '-0.1,0,0.1 Gy') throw new Error(`色階範圍 ±0.1：有顏色的像素 ${wide} → ${narrow}、色階條 ${JSON.stringify(barLabels)}`);
await shot('doseops21-range.png');
await clickEl(`[...(${diffRow}).querySelectorAll('.dose-range button')].find((b) => /自動/.test(b.textContent))`);
await sleep(600);
const back = await evaluate(`[...(${cellSel('軸向')}).querySelectorAll('.dose-colorbar-labels span')].map((x) => x.textContent)`);
if (back[0] === '-0.1') throw new Error(`「自動」應回到 ±max|值|：${JSON.stringify(back)}`);
step(`色階範圍 ±0.1 Gy：有顏色的像素 ${wide} → ${narrow}、色階條 ${barLabels.join(' / ')}；「自動」→ ${back.join(' / ')}`);

// 7. 在 DVH 看：已照、計畫
await evaluate(`localStorage.removeItem('x'); true`);
for (const re of ['/\\) \\+ \\(/', '/× 0\\.2/']) {
  await select(byName(re));
  await clickEl(`[...${actions}.querySelectorAll('.buttons button')].find((b) => /DVH/.test(b.textContent))`);
  await sleep(400);
}
await waitFor(`!!document.querySelector('.dvh-doses')`, 'DVH 設定', 10000);
const checked = await evaluate(`[...document.querySelectorAll('.dvh-doses label')].filter((l) => l.querySelector('input')?.checked).map((l) => l.textContent.trim())`);
if (!checked.some((c) => /\) \+ \(/.test(c)) || !checked.some((c) => /× 0\.2/.test(c))) throw new Error(`DVH 應勾已照與計畫：${JSON.stringify(checked)}`);
step(`在 DVH 看：${checked.length} 個劑量（含已照、計畫）`);

// 8. 不同空間不能直接運算：原本的 fx1（自己一個空間）
await select(`${panel}.querySelectorAll('.dose-space')[1].querySelector('.dose-object')`);
await clickEl(`${actions}.querySelector('.dose-op-ops button[data-op="add"]')`);
const hint = await evaluate(`${actions}.querySelector('.dose-action-op').innerText`);
if (!/同一個空間沒有其他劑量/.test(hint)) throw new Error(`fx1 在自己的空間應提示沒有可運算的劑量：${hint}`);
step('原本的 fx1：＋ → 「同一個空間沒有其他劑量：先對別的劑量套用 REG」');

// 9. 存檔（下載）、丟棄
await select(diffRow);
await clickEl(`[...${actions}.querySelectorAll('.buttons button')].find((b) => /存檔/.test(b.textContent))`);
await waitFor(`!!document.querySelector('.dose-ops-panel .dose-save-form button.primary')`, '右側存檔表單', 10000);
await clickEl(`document.querySelector('.dose-ops-panel .dose-save-form button.primary')`);
await waitFor(`!!document.querySelector('.dose-ops-panel .dose-save-form .job.done a.download')`, 'RTDOSE 完成', 60000);
const jobText = await evaluate(`document.querySelector('.dose-ops-panel .dose-save-form .job').innerText`);
if (!/ERROR/.test(jobText)) throw new Error(`差異存成 RTDOSE 應是 ERROR：${jobText}`);
step(`存檔：${jobText.replace(/\s+/g, ' ').slice(0, 50)}`);
n = await countObjects();
await select(diffRow);
await clickEl(`[...${actions}.querySelectorAll('.buttons button')].find((b) => /丟棄/.test(b.textContent))`);
await waitFor(`${panel}.querySelectorAll('.dose-object').length === ${n - 1}`, '丟棄後少一個', 10000);
step('丟棄 → 少一個');

// 10. 英文模式
await send('Page.navigate', { url: url.replace('/#/', '/?lang=en#/') });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!${panel}`, '英文模式載入');
await waitFor(`${panel}.querySelectorAll('.dose-object').length >= 3`, '英文模式的劑量面板', 20000);
await select(`${panel}.querySelectorAll('.dose-space')[1].querySelector('.dose-object')`);
await waitFor(`!!${actions}.querySelector('select[data-field="transform"]')`, '英文模式的 REG 選項', 10000);
const enText = await evaluate(`[${panel}.querySelector('.dose-panel-hint').innerText, ...[...${panel}.querySelectorAll('.dose-space-head')].map((e) => e.innerText), ${actions}.innerText, ...[...${actions}.querySelectorAll('[title]')].map((e) => e.title)].join(' | ')`);
const cjk = enText.match(/[　-鿿＀-￯]+/g);
if (cjk) throw new Error(`英文模式還有中文：${cjk.join(' ')}`);
step('英文模式：劑量面板、套用 REG 與運算沒有中文');

if (errors.length) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
