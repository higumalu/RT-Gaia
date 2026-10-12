#!/usr/bin/env node
/**
 * γ 比較 —— headless Chrome ＋ CDP（骨架同 `verify-dose-ops.mjs`、零相依），真的滑鼠／鍵盤事件：
 *
 *   選計畫劑量 → 「γ 比較」：同一個空間沒有其他劑量時說明要先套用 REG
 *   計畫 × 1.02、計畫 × 1.05（劑量運算）→ 選計畫 → γ 比較的「被評估」只列同一個空間的劑量
 *   計畫 vs × 1.02 → γ 圖列在同一個空間底下、通過率 ≥ 99%、徽章是「容許」
 *   計畫 vs × 1.05 → 通過率較低；選取 → 說明（失敗點分高梯度／平坦區）、直方圖 40 格、各結構通過率表
 *   只顯示 γ 圖 → 軸向格有顏色；「只看失敗」→ 有顏色的像素變少
 *   右側「劑量運算」面板：γ 圖沒有「存成 RTDOSE」
 *   丟棄 γ 圖 → 少一個；英文模式的 γ 表單與說明沒有中文
 *
 * 需要量測堆疊（`.rtgaia/perf/case.json`）：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-gamma.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR]
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
const port = Number(args.port ?? 9347);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-gamma-'));
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
  await shot('gamma-failed.png').catch(() => undefined);
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
await waitFor(`${panel}.querySelectorAll('.dose-object').length >= 1 && !${panel}.querySelector('.gamma-object')`, '只剩原始劑量', 20000);
const ctSpace = `${panel}.querySelectorAll('.dose-space')[0]`;
const planRow = `[...${ctSpace}.querySelectorAll('.dose-object:not(.gamma-object)')].find((li) => li.dataset.derived === 'false')`;
const gammaForm = `${actions}.querySelector('.dose-action-gamma')`;
const gammaRows = () => evaluate(`[...${ctSpace}.querySelectorAll('.gamma-object')].map((li) => ({ id: li.dataset.series, name: li.querySelector('.dose-object-name').textContent, rate: li.querySelector('.gamma-rate')?.dataset.passRate ?? '', verdict: li.dataset.verdict }))`);

// 1. 同一個空間只有一個劑量 → 說明要先套用 REG
await select(planRow);
const lonely = await evaluate(`${gammaForm}.innerText`);
if (await evaluate(`${ctSpace}.querySelectorAll('.dose-object').length`) === 1) {
  if (!/同一個空間沒有可以比較的劑量/.test(lonely)) throw new Error(`只有一個劑量時應說明：${lonely}`);
  step('只有計畫劑量：γ 比較說明「同一個空間沒有可以比較的劑量」');
}

// 2. 計畫 × 1.02、× 1.05
for (const k of ['1.02', '1.05']) {
  await select(planRow);
  await clickEl(`${actions}.querySelector('.dose-op-ops button[data-op="mul"]')`);
  await clickEl(`${actions}.querySelector('input[data-field="k"]')`);
  await send('Input.insertText', { text: k });
  const n = await countObjects();
  await clickEl(`${actions}.querySelector('button[data-action="compute"]')`);
  await waitFor(`${panel}.querySelectorAll('.dose-object').length === ${n + 1}`, `計畫 × ${k}`, 30000);
}
step('計畫 × 1.02、× 1.05');

// 3. γ：計畫 vs × 1.02、× 1.05
const runGamma = async (re) => {
  await select(planRow);
  const opts = await evaluate(`[...${gammaForm}.querySelectorAll('select[data-field="gamma-evaluated"] option')].map((o) => ({ v: o.value, t: o.textContent }))`);
  const pick = opts.find((o) => re.test(o.t));
  if (!pick || opts.length !== 2) throw new Error(`被評估應只列同一個空間的兩個劑量：${JSON.stringify(opts)}`);
  await setValue(`${gammaForm}.querySelector('select[data-field="gamma-evaluated"]')`, pick.v, 'change');
  const before = (await gammaRows()).length;
  const t0 = Date.now();
  await clickEl(`${gammaForm}.querySelector('button[data-action="gamma"]')`);
  await waitFor(`${ctSpace}.querySelectorAll('.gamma-object').length === ${before + 1} && !!${ctSpace}.querySelectorAll('.gamma-object')[${before}].querySelector('.gamma-rate')`, `γ vs ${pick.t}`, 180000);
  const row = (await gammaRows())[before];
  return { ...row, ms: Date.now() - t0, opts: opts.map((o) => o.t) };
};
const g2 = await runGamma(/× 1\.02/);
if (!(Number(g2.rate) >= 0.99) || g2.verdict !== 'pass') throw new Error(`× 1.02 應幾乎全過、判容許：${JSON.stringify(g2)}`);
step(`γ 計畫 vs × 1.02：「${g2.name}」通過率 ${(Number(g2.rate) * 100).toFixed(2)}%（${g2.verdict}，${(g2.ms / 1000).toFixed(1)} 秒）；被評估選項 ${JSON.stringify(g2.opts)}`);
const g5 = await runGamma(/× 1\.05/);
if (!(Number(g5.rate) < Number(g2.rate))) throw new Error(`× 1.05 的通過率應較低：${JSON.stringify(g5)}`);
step(`γ 計畫 vs × 1.05：通過率 ${(Number(g5.rate) * 100).toFixed(2)}%（${g5.verdict}，${(g5.ms / 1000).toFixed(1)} 秒）`);

// 4. 選取 → 說明、直方圖、各結構通過率
const g5Row = `[...${ctSpace}.querySelectorAll('.gamma-object')].find((li) => li.dataset.series === ${JSON.stringify(g5.id)})`;
// 剛算好的 γ 圖會自動選取（再點一次是取消）—— 沒選才點
if (!(await evaluate(`(${g5Row}).classList.contains('selected')`))) await clickEl(`(${g5Row}).querySelector('.dose-object-name')`);
await waitFor(`!!(${g5Row}).querySelector('.gamma-details')`, 'γ 說明', 10000);
const expl = await evaluate(`[...(${g5Row}).querySelectorAll('.gamma-explanation li')].map((x) => x.textContent)`);
if (!expl.some((l) => /評估 .* 點/.test(l)) || !expl.some((l) => /高梯度區|沒有失敗/.test(l))) throw new Error(`說明：${JSON.stringify(expl)}`);
const bars = await evaluate(`(${g5Row}).querySelectorAll('.gamma-histogram > span:not(.gamma-histogram-axis)').length`);
if (bars !== 40) throw new Error(`直方圖應 40 格：${bars}`);
await clickEl(`(${g5Row}).querySelector('button[data-action="gamma-regions"]')`);
await waitFor(`(${g5Row}).querySelectorAll('.gamma-regions tbody tr').length > 0`, '各結構通過率', 60000);
const regions = await evaluate(`[...(${g5Row}).querySelectorAll('.gamma-regions tbody tr')].slice(0, 4).map((tr) => tr.innerText.replace(/\\s+/g, ' '))`);
step(`說明 ${expl.length} 句（${expl.slice(0, 3).join(' ／ ')}）；直方圖 ${bars} 格；各結構：${regions.join('；')}`);

// 5. 只顯示 γ 圖 → 有顏色；只看失敗 → 變少
await clickEl(`(${planRow}).querySelector('.dose-jump-max')`);
await sleep(800);
const showOnly = (expr) => evaluate(`[...document.querySelectorAll('.dose-object')].forEach((li) => { const box = li.querySelector('.visibility input'); const want = li === (${expr}); if (box.checked !== want) box.click(); }); true`);
const colorful = async () => {
  const r = await evaluate(`(() => { const b = ${cellSel('軸向')}.querySelector('.viewport-canvas-host').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  return evaluate(`new Promise((resolve) => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) { const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]); if (mx - mn > 50) n += 1; } resolve(n); }; img.src = 'data:image/png;base64,${data}'; })`);
};
await showOnly('null');
await sleep(1200);
const none = await colorful();
await showOnly(g5Row);
let all = await colorful();
for (let i = 0; i < 40 && all - none < 200; i += 1) {
  await sleep(500);
  all = await colorful();
}
if (all - none < 200) throw new Error(`γ 圖應有顏色：關 ${none}、開 ${all}`);
await shot('gamma-all.png');
await clickEl(`(${g5Row}).querySelector('input[data-field="gamma-fail-only"]')`);
let fails = await colorful();
for (let i = 0; i < 20 && fails >= all; i += 1) {
  await sleep(300);
  fails = await colorful();
}
if (!(fails < all)) throw new Error(`只看失敗應變少：${all} → ${fails}`);
await shot('gamma-fail-only.png');
step(`只顯示 γ 圖：有顏色的像素 ${none} → ${all}；只看失敗 → ${fails}`);

// 6. 右側面板：γ 圖沒有「存成 RTDOSE」
await clickEl(`document.querySelector('.dose-ops-toggle button')`);
await waitFor(`!!document.querySelector('.dose-ops-panel li[data-series=${JSON.stringify(g5.id)}]')`, '右側劑量運算面板', 10000);
const rightButtons = await evaluate(`[...document.querySelectorAll('.dose-ops-panel li[data-series=${JSON.stringify(g5.id)}] button')].map((b) => b.textContent)`);
if (rightButtons.some((b) => /RTDOSE/.test(b))) throw new Error(`γ 圖不能存成 RTDOSE：${JSON.stringify(rightButtons)}`);
step(`右側面板的 γ 圖按鈕：${JSON.stringify(rightButtons)}`);

// 7. 丟棄
const before = (await gammaRows()).length;
await clickEl(`[...(${g5Row}).querySelectorAll('.gamma-details button')].find((b) => /丟棄/.test(b.textContent))`);
await waitFor(`${ctSpace}.querySelectorAll('.gamma-object').length === ${before - 1}`, '丟棄後少一個', 10000);
step('丟棄 γ 圖 → 少一個');

// 8. 英文模式
await send('Page.navigate', { url: url.replace('/#/', '/?lang=en#/') });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!${panel}`, '英文模式載入');
await waitFor(`!!${ctSpace}?.querySelector('.gamma-object')`, '英文模式的 γ 圖', 20000);
await select(planRow);
// 一次只選一個：先讀參考劑量底下的 γ 表單，再選 γ 圖讀說明
const formText = await evaluate(`[(${gammaForm}).innerText, ...[...(${gammaForm}).querySelectorAll('[title],[aria-label]')].map((e) => (e.title || '') + ' ' + (e.getAttribute('aria-label') || ''))].join(' | ')`);
const g2Row = `${ctSpace}.querySelector('.gamma-object')`;
if (!(await evaluate(`(${g2Row}).classList.contains('selected')`))) await clickEl(`(${g2Row}).querySelector('.dose-object-name')`);
await waitFor(`!!(${g2Row}).querySelector('.gamma-details')`, '英文模式的 γ 說明', 10000);
const enText = formText + ' | ' + (await evaluate(`[(${g2Row}).innerText, ...[...(${g2Row}).querySelectorAll('[title],[aria-label]')].map((e) => (e.title || '') + ' ' + (e.getAttribute('aria-label') || ''))].join(' | ')`));
const cjk = enText.match(/[　-鿿＀-￯]+/g);
if (cjk) throw new Error(`英文模式還有中文：${cjk.join(' ')}`);
step('英文模式：γ 表單與說明沒有中文');

if (errors.length) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
