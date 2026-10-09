#!/usr/bin/env node
/**
 * PET SUV、DWI b 值從描述推定、Gamma Knife shot 表 —— 用 `data/demo/` 的真實病例。
 * headless Chrome ＋ CDP（骨架同 `verify-demo-open.mjs`、零相依）。
 *
 *   CCTH-A06 PET2（FDG 3D SUV OSEM）：開啟 → 指標移到軸向格中間，讀數是「x.xx SUV」；影像列設定的 W/L 是 2.5／5 SUV；
 *        沒有「沒有換算 SUV」的警告
 *   CCTH-A06 MR2（SAG DWI B100/600/1000，b 值標籤被去識別化刪掉）：資料頁徽章「b 值（推定）×4」→ 開啟 →
 *        時間軸「b 0?（1／4）」、警告「依描述推定 b 值 0/100/600/1000（b0 描述沒寫…）」（訊號 b 越大越暗 → 推定留著）
 *   VS-SEG-131（Gamma Knife）：計畫面板的 shot 表 11 列，每列有照射時間、權重（%）、處方點 Gy；最長的 shot 權重 100%
 *
 *   scripts/perf/stack.sh start   # 量測堆疊載入 data/demo/（下載見 scripts/demo/README.md）
 *   node scripts/verify-suv-bvalue-shots.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR] [--token <rtgaia_session>]
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

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-suv-bvalue-'));
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
  await shot('suv-bvalue-failed.png').catch(() => undefined);
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

// ── CCTH PET：SUV ────────────────────────────────────────────────────────────────
await openStudy('CCTH-A06', 'PET2');
await waitFor(`!!${rowWith('image', 'FDG 3D SUV OSEM')}`, 'PET 列');
await evaluate(`${rowWith('image', 'FDG 3D SUV OSEM')}.querySelector('input[type=checkbox]').click(); true`);
await openCase();
const axial = await centerOf(`${cellSel('軸向')}.querySelector('canvas')`);
let reading = '';
for (let i = 0; i < 20 && !/ SUV$/.test(reading); i += 1) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: axial.x + i, y: axial.y + i });
  await sleep(150);
  reading = await evaluate(`[...document.querySelectorAll('.probe-value')].map((e) => e.textContent.trim()).find((t) => t !== '—') ?? ''`);
}
if (!/^≈? ?-?\d+\.\d{2} SUV$/.test(reading)) throw new Error(`PET 讀數應該是「x.xx SUV」：${reading}`);
await evaluate(`(() => { const row = [...document.querySelectorAll('.image-row')].find((r) => r.querySelector('.row-more')); if (row && row.dataset.expanded !== 'true') row.querySelector('.row-more').click(); return true; })()`);
await waitFor(`!!document.querySelector('.image-row[data-expanded="true"] .wl input[type=number]')`, '影像列設定展開');
const wl = await evaluate(`(() => { const r = document.querySelector('.image-row[data-expanded="true"] .wl'); const [c, w] = r.querySelectorAll('input[type=number]'); return { c: c.value, w: w.value, unit: r.querySelector('.muted.small')?.textContent.trim() ?? '' }; })()`);
if (wl.c !== '2.5' || wl.w !== '5' || wl.unit !== 'SUV') throw new Error(`PET W/L 應該是 2.5／5 SUV：${JSON.stringify(wl)}`);
if ((await pageText()).includes('沒有換算 SUV')) throw new Error('PET 有「沒有換算 SUV」的警告');
await shot('suv-bvalue-pet-suv.png');
step(`CCTH PET：讀數「${reading}」、W/L ${wl.c}／${wl.w} ${wl.unit}`);

// ── CCTH DWI：b 值從描述推定 ─────────────────────────────────────────────────────
await openStudy('CCTH-A06', 'MR2');
await waitFor(`!!${rowWith('image', 'SAG DWI')}`, 'DWI 列');
const dwiBadge = await evaluate(`${rowWith('image', 'SAG DWI')}.querySelector('.badge.dynamic')?.textContent.trim() ?? null`);
if (dwiBadge !== 'b 值（推定）×4') throw new Error(`DWI 徽章：${dwiBadge}`);
await evaluate(`${rowWith('image', 'SAG DWI')}.querySelector('input[type=checkbox]').click(); true`);
await openCase(true);
const dwiText = await evaluate(`document.querySelector('.time-group .time-text').textContent.trim()`);
if (!dwiText.startsWith('b 0?')) throw new Error(`DWI 幀文字應該是推定的 b 值：${dwiText}`);
await waitFor(`document.body.innerText.includes('依描述推定 b 值 0/100/600/1000')`, 'DWI 推定 b 值的警告', 20000);
await shot('suv-bvalue-dwi.png');
step(`CCTH DWI：資料頁「${dwiBadge}」→ 時間軸「${dwiText}」、警告說明 b 值是從描述推定的`);

// ── VS：Gamma Knife shot 表 ──────────────────────────────────────────────────────
await openStudy('VS-SEG-131', 'Avanto');
await waitFor(`!!${rowWith('image', 't1_fl3d_tra_gk')}`, 'VS T1 列');
await evaluate(`${rowWith('image', 't1_fl3d_tra_gk')}.querySelector('input[type=checkbox]').click(); true`);
await waitFor(`document.querySelector('.selection-summary').textContent.includes('個計畫')`, 'VS 帶進計畫', 20000);
await openCase();
await waitFor(`!!document.querySelector('.plan-toggle button')`, '工具列「計畫」');
if (!(await evaluate(`!!document.querySelector('.plan-panel')`))) await evaluate(`document.querySelector('.plan-toggle button').click(); true`);
await waitFor(`document.querySelectorAll('.plan-panel .plan-shots tbody tr').length > 0`, 'shot 表');
const shots = await evaluate(`[...document.querySelectorAll('.plan-panel .plan-shots tbody tr')].map((r) => [...r.cells].map((c) => c.textContent.trim()))`);
if (shots.length !== 11) throw new Error(`shot 表應該 11 列：${shots.length}`);
const weights = shots.map((r) => r[3]);
if (!weights.every((w) => /^\d+%$/.test(w)) || !weights.includes('100%')) throw new Error(`shot 權重：${weights.join(',')}`);
if (!shots.every((r) => /^\d+\.\d{2}$/.test(r[2]) && /^\d+\.\d{2}$/.test(r[4]))) throw new Error(`shot 時間／處方點 Gy：${JSON.stringify(shots[0])}`);
if (await evaluate(`!!document.querySelector('.plan-panel .plan-bev')`)) throw new Error('Gamma Knife 不該有 BEV');
await shot('suv-bvalue-vs-shots.png');
step(`VS：shot 表 ${shots.length} 列（例：${shots[0].join(' ')}）、權重 ${weights.join('／')}`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
