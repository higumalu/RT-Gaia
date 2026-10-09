#!/usr/bin/env node
/**
 * 射束劑量（BEAM）合成計畫劑量 —— 合成測資 `data/test_beams`（`rtgaia_testbe.fixtures.synth_beams`）。
 * headless Chrome ＋ CDP（骨架同 `verify-demo-open.mjs`、零相依）。
 *
 *   SYNBEAM-1：資料頁勾 CT → 選取帶進 4 個劑量與計畫 → 開啟 → 劑量面板「射束劑量 → 計畫劑量」一列
 *        「計畫 BEAMS3：3 個射束劑量（射束 1, 2, 3）」→ 點一個射束劑量：說要先合成（不能直接運算）→
 *        按「合成計畫劑量」→ 新的暫存劑量「Σ beams 1,2,3 (BEAMS3)」、Dmax 33.63 Gy（＝ 測資的計畫劑量）→
 *        選它、對計畫劑量做「−」→ 差值 Dmax 0.00
 *
 *   uv run python -m rtgaia_testbe.fixtures.synth_beams --out data/test_beams
 *   scripts/perf/stack.sh start
 *   node scripts/verify-beam-sum.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR] [--token <rtgaia_session>]
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

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-beam-sum-'));
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
  await shot('beam-sum-failed.png').catch(() => undefined);
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

await openStudy('SYNBEAM-1', 'beams1');
await waitFor(`!!${rowWith('image', 'synth beams CT')}`, 'CT 列');
await evaluate(`${rowWith('image', 'synth beams CT')}.querySelector('input[type=checkbox]').click(); true`);
await waitFor(`document.querySelector('.selection-summary')?.textContent.includes('4 個劑量')`, '選取帶進 4 個劑量', 20000);
const sel = await summary();
await openCase();
const GROUP = `document.querySelector('.dose-beam-groups .dose-beam-group')`;
await waitFor(`!!${GROUP}`, '劑量面板的「射束劑量 → 計畫劑量」', 30000);
const groupText = await evaluate(`${GROUP}.querySelector('.small').textContent.trim()`);
if (groupText !== '計畫 BEAMS3：3 個射束劑量（射束 1, 2, 3）') throw new Error(`射束分組：${groupText}`);
if ((await evaluate(`${GROUP}.dataset.eligible`)) !== 'true') throw new Error(`射束分組應該可以合成：${await evaluate(`${GROUP}.textContent`)}`);
// 射束劑量本身不能直接運算
const B1 = `[...document.querySelectorAll('.dose-object')].find((li) => li.querySelector('.dose-object-name').textContent.includes('BEAMS3 beam 1 '))`;
await waitFor(`!!${B1}`, `劑量物件「Beam B1」（現有：${await evaluate(`[...document.querySelectorAll('.dose-object-name')].map((e) => e.textContent.trim()).join('｜')`)}）`, 20000);
await evaluate(`${B1}.querySelector('.dose-object-name').click(); true`);
await waitFor(`document.querySelector('.dose-object.selected .dose-actions .warning')?.textContent.includes('射束劑量要先合成')`, '射束劑量說要先合成', 20000);
await evaluate(`document.querySelector('.dose-object.selected .dose-object-name').click(); true`);
// 合成
await evaluate(`${GROUP}.querySelector('[data-action="beam-sum"]').click(); true`);
const SUMMED = `[...document.querySelectorAll('.dose-object[data-derived="true"]')].find((li) => li.querySelector('.dose-object-name').textContent.trim() === 'Σ beams 1,2,3 (BEAMS3)')`;
await waitFor(`!!${SUMMED}`, '合成的暫存劑量', 60000);
await waitFor(`${SUMMED}.querySelector('.dose-object-where').textContent.includes('Dmax 33.63 Gy')`, '合成的 Dmax ＝ 計畫劑量的 33.63 Gy', 20000);
const where = await evaluate(`${SUMMED}.querySelector('.dose-object-where').textContent.trim()`);
await shot('beam-sum-beam-sum.png');
step(`SYNBEAM-1：「${sel}」→「${groupText}」→ 合成「Σ beams 1,2,3 (BEAMS3)」（${where}）`);
// 合成 − 計畫劑量 ＝ 0
if (!(await evaluate(`${SUMMED}.classList.contains('selected')`))) await evaluate(`${SUMMED}.querySelector('.dose-object-name').click(); true`);
await waitFor(`!!document.querySelector('.dose-object.selected .dose-op-ops [data-op="sub"]')`, '運算列');
await evaluate(`document.querySelector('.dose-object.selected .dose-op-ops [data-op="sub"]').click(); true`);
await waitFor(`!!document.querySelector('.dose-object.selected select[data-field="b"]')`, 'B 選單');
await evaluate(`(() => { const s = document.querySelector('.dose-object.selected select[data-field="b"]'); const o = [...s.options].find((x) => /^BEAMS3 \\d\\d-\\d\\d/.test(x.textContent)); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
await sleep(300);
await evaluate(`document.querySelector('.dose-object.selected [data-action="compute"]').click(); true`);
const DIFF = `[...document.querySelectorAll('.dose-object[data-derived="true"]')].find((li) => li.querySelector('.dose-object-name').textContent.includes('Σ beams') && li.querySelector('.dose-object-name').textContent.includes('−'))`;
await waitFor(`!!${DIFF}`, '差值劑量', 60000);
const diffWhere = await evaluate(`${DIFF}.querySelector('.dose-object-where').textContent.trim()`);
if (!/-?0\.00 … -?0\.00 Gy|Dmax -?0\.00 Gy/.test(diffWhere)) throw new Error(`合成 − 計畫劑量應該 ≈ 0：${diffWhere}`);
step(`合成 − 計畫劑量：${await evaluate(`${DIFF}.querySelector('.dose-object-name').textContent.trim()`)}（${diffWhere}）`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
