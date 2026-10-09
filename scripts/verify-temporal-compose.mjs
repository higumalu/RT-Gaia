#!/usr/bin/env node
/**
 * 4D ↔ 多個 3D —— headless Chrome ＋ CDP（骨架同 `verify-temporal-playback.mjs`、零相依）。
 * 需求：把左欄多個相位的影像組成 4D 觀看，在檢視器裡像影片一樣播放，並在上面標記 ROI。
 *
 *   SYN4D-MR3（DCE 12 個時間點各一個序列、描述相同 → 資料頁預設不合併）：
 *   1. 資料頁勾這組（不勾「合併成時間軸」）→ 開啟 → 左欄 12 張影像、沒有時間軸列
 *   2. 左欄「組成 4D」→ 對話框 12 列（預設全勾、照序列號排）、種類「時間」→ 組成 → 同一個病例重載：時間軸列 12 個時間點、左欄 1 張
 *   3. 播放 → 游標往前走；軸向格畫面跟著變
 *   4. 有只屬某一幀的結構（API 在第 4 幀建一個）→「拆回多張影像」被擋、錯誤列說明 → 刪掉它
 *   5.「攤開成 3D」→ 左欄 12 張（名稱帶幀名、只有第一張顯示）、時間軸列變成「已攤開成 12 張影像」；第 6 張設作用中 → 「結構跟著作用中的那一張」跟著變；
 *      只顯示第 6 張 → 軸向格跟第 1 張不同 →「收回成 4D」→ 左欄 1 張
 *   6.「並排比較」→ 並排版面、兩格的相位選單各鎖一幀、兩格畫面不同；播放時鎖住的格子不動 → 重新整理頁面 → 鎖定還在
 *   7.「拆回多張影像」→ 左欄 12 張、沒有時間軸列；病例 id 從頭到尾沒變
 *   8. CCTH-A06（公開資料，有下載才跑）：一個序列內分幀的 DCE 62 幀 → 攤開 62 張、畫面不黑、重新整理仍在 → 收回
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-temporal-compose.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR] [--token <rtgaia_session>]
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
const port = Number(args.port ?? 9340);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-compose-'));
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
  await shot('compose-failed.png').catch(() => undefined);
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
const initScript = await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
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


const rows = `[...document.querySelectorAll('.frame-group .image-row')]`;
const caseId = () => evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.caseId)`);
const studyId = () => evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.studyId)`);
/** 某一格 canvas 的指紋（取樣像素和）—— 比較兩張畫面是不是同一張。 */
const canvasSum = (label) => evaluate(`(() => { const c = ${cellSel(label)}?.querySelector('canvas'); const x = c?.getContext('2d'); if (!x) return -1; const d = x.getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 16) s += d[i]; return s; })()`);
const timeText = () => evaluate(`document.querySelector('.time-group .time-text')?.textContent.trim() ?? null`);
const clickButton = (scope, text) => evaluate(`(() => { const b = [...(${scope}).querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);

// 1
await openStudy('SYN4D-MR3', 'synth4d');
await waitFor(`!!document.querySelector('.catalog-tree tr[data-kind="temporal"]')`, 'MR3 的時間軸候選');
const merged = await evaluate(`document.querySelector('.catalog-tree tr[data-kind="temporal"] .merge-toggle input').checked`);
if (merged) throw new Error('MR3 的候選預設應該不合併');
await evaluate(`document.querySelector('.catalog-tree tr[data-kind="temporal"] input[type=checkbox]').click(); true`);
await openCase(false);
// 同一組選取回同一個病例：上一輪留下的組成（或攤開）先拆回去，從頭開始
await sleep(1500);
if (await evaluate(`!!document.querySelector('.time-group.is-expanded')`)) {
  await clickButton(`document.querySelector('.time-group')`, '收回成 4D');
  await waitFor(`!document.querySelector('.time-group.is-expanded')`, '收回上一輪的攤開', 30000);
}
if (await evaluate(`!!document.querySelector('.time-group')`)) {
  // 上一輪中途失敗留下的測試結構（只屬某一幀 → 會擋住拆回）先刪掉
  const sid0 = await studyId();
  await evaluate(`fetch('/api/v1/studies/${sid0}/structures').then((r) => r.json()).then((l) => Promise.all((Array.isArray(l) ? l : l.structures ?? []).filter((x) => /^Lesion_(t4|locked)$/.test(x.name)).map((x) => fetch('/api/v1/structures/' + x.structure_id, { method: 'DELETE' }))))`);
  await clickButton(`document.querySelector('.time-group')`, '拆回多張影像');
  await waitFor(`!document.querySelector('.time-group')`, '拆回上一輪的組成', 120000);
}
await waitFor(`${rows}.length === 12`, '左欄 12 張影像', 60000);
if (await evaluate(`!!document.querySelector('.time-group')`)) throw new Error('沒合併不該有時間軸列');
const case0 = await caseId();
step(`開啟（不合併）：左欄 ${await evaluate(`${rows}.length`)} 張影像、沒有時間軸列`);

// 2
if (!(await clickButton(`document.querySelector('.frame-group-header')`, '組成 4D'))) throw new Error('左欄沒有「組成 4D」');
await waitFor(`document.querySelectorAll('.compose-4d-list li').length === 12`, '對話框 12 列');
const dialog = await evaluate(`({ checked: document.querySelectorAll('.compose-4d-list input[type=checkbox]:checked').length, axis: document.querySelector('.compose-4d-axis select').value, labels: [...document.querySelectorAll('.compose-4d-label')].map((x) => x.value) })`);
if (dialog.checked !== 12 || dialog.axis !== 'time') throw new Error(`對話框預設：${JSON.stringify(dialog)}`);
await shot('compose-dialog.png');
await clickButton(`document.querySelector('.compose-4d-dialog')`, '組成（12 幀）');
await waitFor(`!!document.querySelector('.time-group') && ${rows}.length === 1`, '組成後：時間軸列、左欄 1 張', 120000);
await waitFor(`!document.querySelector('.compose-4d-dialog')`, '對話框關掉');
const t0 = await timeText();
if (!t0.startsWith('第 1／12 個時間點')) throw new Error(`時間軸文字：${t0}`);
if ((await caseId()) !== case0) throw new Error('組成後換了病例');
step(`組成 4D（對話框 12 列全勾、種類「時間」、名稱 ${dialog.labels.slice(0, 3).join('、')}…）→「${t0}」、左欄 1 張、同一個病例`);

// 3
await sleep(1500);
const before = await canvasSum('軸向');
await evaluate(`document.querySelector('.time-group .time-play').click(); true`);
const seen = new Set();
for (let i = 0; i < 15; i += 1) {
  await sleep(150);
  seen.add(await evaluate(`document.querySelector('.time-group').dataset.cursor`));
}
await evaluate(`document.querySelector('.time-group .time-play').click(); true`);
await sleep(800);
if (seen.size < 3) throw new Error(`播放只看到 ${[...seen]}`);
const after = await canvasSum('軸向');
step(`播放：看到 ${seen.size} 個時間點；軸向格畫面${before === after ? '沒變（⚠）' : '跟著變'}`);
if (before === after) throw new Error('播放後軸向格畫面沒變');

// 4
await evaluate(`document.querySelector('.time-group .time-buttons button').click(); true`); // 回第一幀
const sid = await studyId();
const made = await evaluate(`fetch('/api/v1/studies/${sid}/structures', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Lesion_t4', frame_index: 4 }) }).then((r) => r.json())`);
if (made.frame_index !== 4) throw new Error(`第 4 幀的結構：${JSON.stringify(made)}`);
await clickButton(`document.querySelector('.time-group')`, '拆回多張影像');
await waitFor(`document.querySelector('p.error')?.textContent.includes('只屬某一幀')`, '拆不開的說明', 15000);
const blocked = await evaluate(`document.querySelector('p.error').textContent.trim()`);
if (await evaluate(`${rows}.length !== 1`)) throw new Error('被擋下來卻拆開了');
await evaluate(`fetch('/api/v1/structures/${made.structure_id}?frame_index=4', { method: 'DELETE' }).then((r) => r.status)`);
step(`有只屬第 4 幀的結構 →「拆回多張影像」被擋：${blocked.slice(0, 40)}…`);

// 5
await clickButton(`document.querySelector('.time-group')`, '攤開成 3D');
await waitFor(`${rows}.length === 12 && !!document.querySelector('.time-group.is-expanded')`, '攤開：左欄 12 張、時間軸列變成攤開中', 30000);
const ex = await evaluate(`({ names: ${rows}.map((r) => r.querySelector('.image-row-name')?.textContent.trim()), visible: ${rows}.map((r) => r.dataset.visible) })`);
if (ex.visible.filter((v) => v === 'true').length !== 1 || ex.visible[0] !== 'true') throw new Error(`攤開後只有第一張顯示：${ex.visible}`);
if (new Set(ex.names).size !== 12) throw new Error(`攤開後每一張名稱不同：${ex.names}`);
await sleep(1200);
const f0 = await canvasSum('軸向');
await evaluate(`${rows}[5].querySelector('.visibility input').click(); true`);
await evaluate(`${rows}[0].querySelector('.visibility input').click(); true`);
await evaluate(`${rows}[5].querySelector('.active-pick input').click(); true`);
await waitFor(`document.querySelector('.time-group.is-expanded').textContent.includes(${JSON.stringify(ex.names[5].split(' · ').pop())})`, '結構跟著第 6 張');
await sleep(2000);
const f5 = await canvasSum('軸向');
if (f5 === f0) throw new Error('只顯示第 6 張時軸向格跟第 1 張一樣');
await shot('compose-expanded.png');
await clickButton(`document.querySelector('.time-group')`, '收回成 4D');
await waitFor(`${rows}.length === 1 && !document.querySelector('.time-group.is-expanded')`, '收回：左欄 1 張', 30000);
step(`攤開成 3D：左欄 12 張（${ex.names[0]}…）只有第一張顯示；第 6 張作用中 → 結構跟著它、畫面跟第 1 張不同 → 收回成 4D`);

// 6
await clickButton(`document.querySelector('.time-group')`, '並排比較');
await waitFor(`!!${cellSel('左 · 軸向')} && !!${cellSel('右 · 軸向')}`, '並排版面', 15000);
await waitFor(`document.querySelectorAll('.phase-lock label.is-locked').length === 2`, '兩格都鎖了相位', 15000);
const locks = await evaluate(`[...document.querySelectorAll('.phase-lock select')].map((s) => s.value)`);
await sleep(2500);
const left = await canvasSum('左 · 軸向');
const right = await canvasSum('右 · 軸向');
if (left === right) throw new Error('並排兩格鎖不同幀，畫面卻一樣');
await evaluate(`document.querySelector('.time-group .time-play').click(); true`);
await sleep(1200);
const leftPlaying = await canvasSum('左 · 軸向');
await evaluate(`document.querySelector('.time-group .time-play').click(); true`);
if (leftPlaying !== left) throw new Error('播放時鎖住的格子變了');
await shot('compose-compare.png');
// 在鎖住的格子上標記 ROI —— 按過左格 → 面板「新建」的結構屬於左格鎖定的那一幀；筆刷畫在那一幀
await clickButton('document', 'ROI 編輯');
await waitFor(`!!document.querySelector('.roi-panel')`, 'ROI 編輯面板');
const lc = await centerOf(`${cellSel('左 · 軸向')}.querySelector('canvas')`);
await clickAt(lc.x + 30, lc.y + 20);
await clickButton(`document.querySelector('.roi-panel')`, '新建');
await waitFor(`!!document.querySelector('.roi-create .roi-name')`, '新建欄位');
await evaluate(`(() => { const el = document.querySelector('.roi-create .roi-name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'Lesion_locked'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await clickButton(`document.querySelector('.roi-create')`, '建立');
const structure = async () => evaluate(`fetch('/api/v1/studies/${sid}/structures').then((r) => r.json()).then((l) => (Array.isArray(l) ? l : l.structures ?? []).find((x) => x.name === 'Lesion_locked') ?? null)`);
await waitFor(`fetch('/api/v1/studies/${sid}/structures').then((r) => r.json()).then((l) => (Array.isArray(l) ? l : l.structures ?? []).some((x) => x.name === 'Lesion_locked'))`, '新結構建好', 15000);
const lockedSt = await structure();
if (JSON.stringify(lockedSt.frames) !== JSON.stringify([Number(locks[0])])) throw new Error(`新結構應只屬左格鎖定的第 ${Number(locks[0]) + 1} 幀：${JSON.stringify(lockedSt.frames)}`);
await clickButton(`document.querySelector('.roi-panel')`, '筆刷');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: lc.x, y: lc.y, button: 'left', buttons: 1, clickCount: 1 });
for (let i = 1; i <= 12; i += 1) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lc.x + i * 3, y: lc.y + i, buttons: 1, button: 'left' });
  await sleep(30);
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: lc.x + 36, y: lc.y + 12, button: 'left', buttons: 0, clickCount: 1 });
await waitFor(`fetch('/api/v1/studies/${sid}/structures').then((r) => r.json()).then((l) => { const x = (Array.isArray(l) ? l : l.structures ?? []).find((s) => s.name === 'Lesion_locked'); const v = Array.isArray(x?.volume_cc) ? x.volume_cc[0] : x?.volume_cc; return v > 0; })`, '筆刷畫進鎖定的那一幀（後端有體積）', 20000);
const painted = await structure();
await clickButton(`document.querySelector('.roi-panel')`, '筆刷'); // 收起筆刷
await clickButton('document', 'ROI 編輯');
await evaluate(`fetch('/api/v1/structures/${lockedSt.structure_id}', { method: 'DELETE' }).then((r) => r.status)`);
step(`鎖住的格子上標記 ROI：新結構只屬第 ${Number(locks[0]) + 1} 幀、筆刷畫進那一幀（${JSON.stringify(painted.volume_cc)} cc）`);
// 開頁腳本會把版面設回 2×2 —— 重新整理前拿掉，看的是使用者真的重新整理時（版面、鎖定都留著）
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: initScript.identifier });
await send('Page.reload', {});
await waitFor(`location.hash.includes('viewer') && document.querySelectorAll('.phase-lock label.is-locked').length === 2`, '重新整理後兩格的鎖還在', 120000);
await sleep(3000); // 載入鏈跑完（重抓體素、還原鎖定）再讀
await waitFor(`document.querySelectorAll('.phase-lock label.is-locked').length === 2`, '重新整理後兩格的鎖還在（穩定）', 60000);
const locksAfter = await evaluate(`[...document.querySelectorAll('.phase-lock select')].map((s) => s.value)`);
if (JSON.stringify(locksAfter) !== JSON.stringify(locks)) throw new Error(`重新整理後鎖定變了：${locks} → ${locksAfter}`);
step(`並排比較：兩格鎖在第 ${locks.map((v) => Number(v) + 1).join('、')} 幀、畫面不同；播放時鎖住的格子不動；重新整理後鎖定還在`);

// 7
await clickButton(`document.querySelector('.time-group')`, '拆回多張影像');
await waitFor(`${rows}.length === 12 && !document.querySelector('.time-group')`, '拆回：左欄 12 張、沒有時間軸列', 120000);
if ((await caseId()) !== case0) throw new Error('拆回後換了病例');
step('拆回多張影像：左欄 12 張、沒有時間軸列；從頭到尾同一個病例');

// 8
// 2026-10-06 CCTH-A06「MR 2006-08-27 沒辦法攤開成 3D」：一個序列內分幀的 DCE 62 幀，每一張攤開的影像帶一份整條時間軸的幀清單
// → scene.replace 385 KB 超過推送上限 → 按了沒反應、重新整理後畫面整片黑。公開資料（data/demo/cctumor）沒下載就略過。
const A06_STUDY = '1.3.6.1.4.1.14519.5.2.1.290340005755449898974701882106446082128';
const hasA06 = await evaluate(`fetch('/api/v1/catalog/studies/${A06_STUDY}/series').then((r) => (r.ok ? r.json() : null)).then((d) => (d?.images ?? []).length > 0).catch(() => false)`);
if (!hasA06) {
  console.log('－ 略過 8：資料庫沒有 CCTH-A06（data/demo/cctumor）');
} else {
  // 第 6 步換成並排版面了 → 回 2×2（要有「矢狀」格）、真的重新載入一次
  await evaluate(`localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.layout.trees.v1'); location.reload(); true`);
  await sleep(1500);
  await openStudy('CCTH-A06', '0 個 RT 物件MR');
  await evaluate(`${rowWith('image', 'DCE')}.querySelector('input[type=checkbox]').click(); true`);
  await openCase(false);
  await sleep(1500);
  if (await evaluate(`!!document.querySelector('.time-group.is-expanded')`)) {
    await clickButton(`document.querySelector('.time-group')`, '收回成 4D');
    await waitFor(`!document.querySelector('.time-group.is-expanded') && ${rows}.length === 1`, '收回上一輪的攤開', 60000);
  }
  await clickButton(`document.querySelector('.time-group')`, '攤開成 3D');
  await waitFor(`${rows}.length === 62 && !!document.querySelector('.time-group.is-expanded')`, 'CCTH-A06 攤開：左欄 62 張', 60000);
  await sleep(3000);
  const lit = await canvasSum('矢狀');
  if (!(lit > 0)) throw new Error(`攤開後矢狀格是黑的（${lit}）`);
  await send('Page.reload');
  await waitFor(`location.hash.includes('viewer') && ${rows}.length === 62 && !!document.querySelector('.time-group.is-expanded')`, '重新整理後仍攤開 62 張', 120000);
  await sleep(4000);
  const litAfter = await canvasSum('矢狀');
  if (!(litAfter > 0)) throw new Error(`重新整理後矢狀格是黑的（${litAfter}）`);
  await clickButton(`document.querySelector('.time-group')`, '收回成 4D');
  await waitFor(`!document.querySelector('.time-group.is-expanded') && ${rows}.length === 1`, 'CCTH-A06 收回成 4D', 60000);
  step('一個序列內分幀的 DCE 62 幀（CCTH-A06）：攤開 → 左欄 62 張、畫面有影像 → 重新整理仍在 → 收回');
}

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
