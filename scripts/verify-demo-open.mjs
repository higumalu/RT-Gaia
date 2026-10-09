#!/usr/bin/env node
/**
 * 用公開的真實 demo 病例（`data/demo/`，TCIA／IDC 的 CC BY 資料，2026-10-04 下載）重跑「資料頁勾選 → 開啟」——
 * 那天測出來的問題都要修好。headless Chrome ＋ CDP（骨架同 `verify-temporal-4d.mjs`、零相依）。
 *
 *   Pancreas-CT-CB_014：勾有 RS／劑量的 CT（**沒先展開**那一列）→ 選取摘要馬上有結構集與劑量 → 開啟後結構都在
 *   113_HM10395（4D-Lung，Pinnacle 描述 `P4^P113^S302^I00011, Gated, 60.0%A`）：資料頁合成「4D · 10 個相位」→ 勾整組 →
 *        時間軸「相位 0%（1／10）」、每相位的 RS 標「只在 x%」、軸向格有腫瘤輪廓；
 *        在同一個 app 裡回資料頁、同一個病例再開一次 → 輪廓還在、10 個相位都預抓（以前：輪廓消失、只有相位 0）
 *   CCTH-A06：MR 那個 study 全勾（AX T2／Ax T1／COR T2 以前因方向不一致打不開）→ 開啟；DWI 徽章「b 值未知 ×4」、
 *        兩條時間軸的標題帶影像名稱、DWI 那條「擴散 b 值」「b 0?（1／4）」（b 值從描述推定）；PET（以前因切片間距不均勻打不開）→ 開啟、警告「不完全均勻」
 *   VS-SEG-131：勾 T1 → 選取有 1 個計畫 → 開啟 → 計畫面板是 Gamma Knife（沒有射束表、沒有 BEV）
 *   順序是刻意的：先開別的病例再開 4D（以前換病例時新 host 還沒好就抓體素 → 4D 一直黑、停在「載入中…」）
 *
 * 下載資料：見 scripts/demo/README.md（`idc download-from-selection --patient-id …`）。
 *   scripts/perf/stack.sh start
 *   node scripts/verify-demo-open.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR] [--token <rtgaia_session>]
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

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-demo-open-'));
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
  await shot('demo-open-failed.png').catch(() => undefined);
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

// ── Pancreas：勾沒展開的 CT → RS 與劑量一起進來 ──────────────────────────────────
await openStudy('Pancreas-CT-CB_014', 'UPPER GI');
const withDose = `${rowsWith('image', 'Aligned CT')}.find((r) => r.querySelector('.badge.dose'))`;
await waitFor(`!!${withDose}`, '有劑量的 CT 列');
await evaluate(`${withDose}.querySelector('input[type=checkbox]').click(); true`);
await waitFor(`document.querySelector('.selection-summary').textContent.includes('個劑量')`, '選取摘要有劑量（以前沒展開的列 RS／劑量都沒跟進來）', 20000);
const pSummary = await summary();
if (!pSummary.includes('套結構集')) throw new Error(`選取摘要應有結構集：${pSummary}`);
await openCase();
await expandStructures();
await waitFor(`document.querySelectorAll('.structure-list li').length > 0`, 'Pancreas 的結構', 30000);
const pStructures = await structureCount();
await shot('demo-open-pancreas.png');
step(`Pancreas：沒展開就勾 → 「${pSummary}」→ 開啟，${pStructures} 個結構`);

// ── 4D-Lung：Pinnacle 描述的 4D 組 ──────────────────────────────────────────────
await openStudy('113_HM10395', 'p4');
await waitFor(`!!${rowWith('temporal', '4D · 10 個相位')}`, '4D-Lung 合成 4D 組（以前 10 個相位各自一列）');
const lungRow = await evaluate(`${rowWith('temporal', '4D · 10 個相位')}.textContent`);
await evaluate(`${rowWith('temporal', '4D · 10 個相位')}.querySelector('input[type=checkbox]').click(); true`);
await waitFor(`document.querySelector('.selection-summary').textContent.includes('套結構集')`, '4D 組帶進每相位的 RS', 20000);
const lSummary = await summary();
await openCase(true);
const l0 = await evaluate(`document.querySelector('.time-group .time-text').textContent.trim()`);
if (!l0.startsWith('相位 0%（1／10）')) throw new Error(`4D-Lung 時間軸：${l0}`);
await expandStructures();
await waitFor(`document.querySelectorAll('.structure-list .frame-note').length > 0`, '4D-Lung 每相位的結構', 30000);
const lNotes = await evaluate(`[...document.querySelectorAll('.structure-list .frame-note')].map((e) => e.textContent.trim())`);
if (!lNotes.some((n) => n.startsWith('只在'))) throw new Error(`每相位的 RS 應標「只在 x%」：${lNotes.slice(0, 5).join(',')}`);
await waitFor(`!document.querySelector('.time-group .time-text').textContent.includes('載入中')`, '4D-Lung 相位 0% 載入完', 240000);
await sleep(1500);
const lit = await evaluate(`(() => { const c = ${cellSel('軸向')}.querySelector('canvas'); const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data; if (!d) return -1; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n += 1; return n; })()`);
if (lit < 5000) throw new Error(`4D-Lung 軸向格幾乎全黑（亮像素 ${lit}）`);
/** 軸向格的紅色像素（Tumor 輪廓）。 */
const RED = `(() => { let n = 0; for (const c of ${cellSel('軸向')}.querySelectorAll('.viewport-canvas-host canvas')) { const x = c.getContext('2d'); if (!x) continue; const d = x.getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] < 70 && d[i + 2] < 70) n += 1; } return n; })()`;
const LOADED_FRAMES = `document.querySelectorAll('.time-group .time-resident i.is-loaded').length`;
await waitFor(`${RED} > 30`, '4D-Lung 軸向格有腫瘤輪廓（紅）', 60000);
await shot('demo-open-4dlung.png');
step(`4D-Lung：資料頁「${lungRow.trim().slice(0, 30)}…」、${lSummary} → 「${l0}」，結構標示 ${lNotes.slice(0, 2).join('、')}…`);
// 回資料頁、同一個病例再開一次：以前「載入中」那段時間舊 host 把 mask 與其他相位吃掉 → 輪廓消失、相位不再預抓
await openStudy('113_HM10395', 'p4', { reload: false }); // 不重載頁面：同一個 app 裡換病例
await waitFor(`!!${rowWith('temporal', '4D · 10 個相位')}`, '再開一次：4D 組');
await evaluate(`${rowWith('temporal', '4D · 10 個相位')}.querySelector('input[type=checkbox]').click(); true`);
await waitFor(`document.querySelector('.selection-summary').textContent.includes('10 套結構集')`, '再開一次：帶進 RS', 20000);
await openCase(true);
await waitFor(`!document.querySelector('.time-group .time-text').textContent.includes('載入中')`, '再開一次：相位 0% 載入完', 240000);
await waitFor(`${RED} > 30`, '再開一次：輪廓還在（以前不見）', 60000);
await waitFor(`${LOADED_FRAMES} === 10`, '再開一次：10 個相位都預抓（以前只有相位 0）', 240000);
step(`4D-Lung 再開一次：輪廓還在（紅色像素 ${await evaluate(RED)}）、10 個相位都預抓`);

// ── CCTH：MR（方向不一致）、DWI 沒有 b 值、兩條時間軸；PET（切片間距）───────────────────────
await openStudy('CCTH-A06', 'MR2');
await waitFor(`!!${rowWith('image', 'SAG DWI')}`, 'DWI 列');
const dwiBadge = await evaluate(`${rowWith('image', 'SAG DWI')}.querySelector('.badge.dynamic')?.textContent.trim() ?? null`);
// 描述 `B100/600/1000` ＋ b0 ＝ 4 組 → 推定（verify-suv-bvalue-shots.mjs 細看）
if (dwiBadge !== 'b 值（推定）×4') throw new Error(`DWI 徽章：${dwiBadge}`);
for (const name of ['AX T2', 'Ax T1', 'COR T2', 'SAG DWI', 'SAG DCE']) {
  await evaluate(`${rowWith('image', name)}.querySelector('input[type=checkbox]').click(); true`);
  await sleep(300);
}
await openCase(true);
await waitFor(`document.querySelectorAll('.time-group').length === 2`, '兩條時間軸（DCE、DWI）');
const titles = await evaluate(`[...document.querySelectorAll('.time-group .time-title')].map((e) => e.textContent.trim())`);
const dwiTitle = titles.find((x) => x.startsWith('擴散'));
if (!dwiTitle || !titles.every((x) => x.includes(' · '))) throw new Error(`時間軸標題要分得出來：${titles.join(' | ')}`);
const dwiText = await evaluate(`[...document.querySelectorAll('.time-group')].find((g) => g.querySelector('.time-title').textContent.startsWith('擴散')).querySelector('.time-text').textContent.trim()`);
if (!dwiText.startsWith('b 0?')) throw new Error(`DWI 幀文字：${dwiText}`);
const mrText = await pageText();
if (/DL6|ImageOrientationPatient 不一致/.test(mrText)) throw new Error('MR 還是有 DL6');
await shot('demo-open-ccth-mr.png');
step(`CCTH MR：資料頁「${dwiBadge}」；AX T2／Ax T1／COR T2 開起來；時間軸「${titles.join('」「')}」，DWI「${dwiText}」`);
await openStudy('CCTH-A06', 'PET2');
await waitFor(`!!${rowWith('image', 'FDG 3D SUV OSEM')}`, 'PET 列');
await evaluate(`${rowWith('image', 'FDG 3D SUV OSEM')}.querySelector('input[type=checkbox]').click(); true`);
await openCase();
await waitFor(`document.body.innerText.includes('不完全均勻')`, 'PET 間距警告', 20000);
await shot('demo-open-ccth-pet.png');
step('CCTH PET：開起來（以前打不開），顯示「切片間距不完全均勻…在容許值內」警告');

// ── VS：Gamma Knife ────────────────────────────────────────────────────────────
await openStudy('VS-SEG-131', 'Avanto');
await waitFor(`!!${rowWith('image', 't1_fl3d_tra_gk')}`, 'VS T1 列');
await evaluate(`${rowWith('image', 't1_fl3d_tra_gk')}.querySelector('input[type=checkbox]').click(); true`);
await waitFor(`document.querySelector('.selection-summary').textContent.includes('個計畫')`, 'VS 帶進計畫', 20000);
await openCase();
await waitFor(`!!document.querySelector('.plan-toggle button')`, '工具列「計畫」');
if (!(await evaluate(`!!document.querySelector('.plan-panel')`))) await evaluate(`document.querySelector('.plan-toggle button').click(); true`);
await waitFor(`!!document.querySelector('.plan-panel .plan-summary')`, '計畫面板');
const gk = await evaluate(`({ text: document.querySelector('.plan-panel').innerText, bev: !!document.querySelector('.plan-panel .plan-bev'), shots: document.querySelectorAll('.plan-panel .plan-shots tbody tr').length, beamTable: !!document.querySelector('.plan-panel .plan-beams:not(.plan-shots)') })`);
if (!gk.text.includes('Gamma Knife') || gk.beamTable || gk.bev || gk.shots < 2) throw new Error(`Gamma Knife 計畫面板：${JSON.stringify({ ...gk, text: gk.text.slice(0, 200) })}`);
await shot('demo-open-vs-gk.png');
step(`VS：計畫面板認出 Gamma Knife（${gk.shots} 個 shot），沒有射束表與 BEV`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
