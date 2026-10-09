#!/usr/bin/env node
/**
 * 真實 DICOM 的 4D／動態影像 —— headless Chrome ＋ CDP（骨架同 `verify-ui-polish.mjs`、零相依）。
 * 資料：合成測資 `uv run python -m rtgaia_testbe.fixtures.synth4d --out data/test_4d`（量測堆疊的資料庫根目錄是 `data/`）。
 *
 *   ct1（4DCT 每相位一個序列）：資料頁合成一列「4D · 10 個相位（0%…90%）」＋ AVG、MIP、MinIP；展開才看到 13 個成員與徽章；
 *        勾整組 → 開啟 → 時間軸「相位 0%（1／10）」→ 下一個 ×5 →「相位 50%（6／10）」、軸向格畫面變了（腫瘤隨呼吸動）、
 *        GTV_50 標「只在 50%」、ITV 不標
 *   mr1（DCE 一個序列、位置重複）：資料頁「動態 ×12」；開啟 → 時間軸「第 1／12 個時間點 · t = 0.00 s」→ 下一個 → t = 10.0 s
 *   ct4（沒有相位標籤）：資料頁「可能是同一次動態掃描」＋「需確認」、合併開關預設沒勾；勾整組＋勾合併 → 開啟 → 10 個時間點
 *   ct5（Enhanced 多幀，一個檔 400 幀）：資料頁「多幀 400」；開啟 → 相位 0%（1／10）→ 下一個 ×3 → 相位 30%（4／10）
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-temporal-4d.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR] [--token <rtgaia_session>]
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

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-v2b-'));
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
  await shot('v2b-failed.png').catch(() => undefined);
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
/** 資料頁：清空選取 → 展開病人與它唯一的 study。 */
const openPatient = async (patientId) => {
  await send('Page.navigate', { url: `${origin}/#/library` });
  await waitFor(`!!${rowWith('patient', patientId)}`, `資料頁有 ${patientId}`, 60000);
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '清空')?.click(); true`);
  await evaluate(`${rowWith('patient', patientId)}.click(); true`);
  await waitFor(`!!document.querySelector('.catalog-tree tr[data-kind="study"]') && [...document.querySelectorAll('.catalog-tree tr[data-kind="study"]')].some((r) => r.textContent.includes('synth4d'))`, `${patientId} 的 study`);
  await evaluate(`[...document.querySelectorAll('.catalog-tree tr[data-kind="study"]')].find((r) => r.textContent.includes('synth4d')).click(); true`);
};
const openCase = async () => {
  await evaluate(`[...document.querySelectorAll('button.primary')].find((b) => b.textContent.trim() === '開啟').click(); true`);
  await waitFor(`location.hash.includes('viewer') && document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.time-group')`, '病例與時間軸', 90000);
  await waitFor(`!document.querySelector('.mask-loading')`, '結構載入完', 60000);
  await sleep(1500);
};
const timeText = () => evaluate(`document.querySelector('.time-group .time-text').textContent.trim()`);
const next = async (n = 1) => {
  for (let i = 0; i < n; i += 1) {
    await evaluate(`document.querySelector('.time-group button[title="下一個"]').click(); true`);
    await sleep(150);
  }
};
const axialHash = () =>
  evaluate(`(() => { const c = ${"[...document.querySelectorAll('.viewport-cell')].find((c) => c.querySelector('.viewport-label')?.textContent.trim() === '軸向')"}?.querySelector('canvas'); if (!c) return null; const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data; if (!d) return c.toDataURL().length; let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) % 1000000007; return h; })()`);

// ── ct1 ─────────────────────────────────────────────────────────────────────
await openPatient('SYN4D-CT1');
await waitFor(`!!${rowWith('temporal', '4D · 10 個相位')}`, '4D 組一列');
const group = await evaluate(`(() => { const r = ${rowWith('temporal', '4D · 10 個相位')}; return { text: r.textContent, merged: r.querySelector('.merge-toggle input').checked, images: [...document.querySelectorAll('.catalog-tree tr[data-kind="image"]')].length }; })()`);
if (!group.text.includes('（0%…90%）') || !group.text.includes('＋ AVG、MIP、MinIP') || !group.merged) throw new Error(`4D 組的標題／附註／預設合併不對：${JSON.stringify(group)}`);
if (group.images !== 0) throw new Error(`沒展開前不該列出成員：${group.images}`);
await evaluate(`${rowWith('temporal', '4D · 10 個相位')}.querySelector('.expander').click(); true`);
await waitFor(`document.querySelectorAll('.catalog-tree tr[data-kind="image"]').length === 13`, '展開後 13 個成員');
const badges = await evaluate(`[...document.querySelectorAll('.catalog-tree tr[data-kind="image"] .badge.temporal-member')].map((b) => b.textContent.trim())`);
if (badges[0] !== '0%' || badges[5] !== '50%' || !badges.includes('AVG') || !badges.includes('MinIP')) throw new Error(`成員徽章：${badges.join(',')}`);
await shot('v2b-library-ct1.png');
step(`ct1 資料頁：一列「${group.text.slice(0, 40)}…」，預設合併；展開 13 個成員（${badges.slice(0, 3).join('、')}…${badges.slice(-3).join('、')}）`);
await evaluate(`${rowWith('temporal', '4D · 10 個相位')}.querySelector('input[type=checkbox]').click(); true`);
await waitFor(`${rowWith('temporal', '4D · 10 個相位')}.dataset.selected === 'true'`, '整組勾起來');
await openCase();
const t0 = await timeText();
if (!t0.startsWith('相位 0%（1／10）')) throw new Error(`時間軸文字：${t0}`);
const title = await evaluate(`document.querySelector('.time-group .time-title').textContent.trim()`);
await waitFor(`!document.querySelector('.time-group .time-text').textContent.includes('載入中')`, '0% 載入完', 60000);
await sleep(1000);
const h0 = await axialHash();
await next(5);
await waitFor(`document.querySelector('.time-group .time-text').textContent.trim().startsWith('相位 50%（6／10）')`, '相位 50%');
await waitFor(`!document.querySelector('.time-group .time-text').textContent.includes('載入中')`, '50% 載入完', 60000);
await sleep(2500);
const h5 = await axialHash();
if (h0 === null || h0 === h5) throw new Error(`換到 50% 後軸向格應該變：${h0} → ${h5}`);
const notes = await evaluate(`Object.fromEntries([...document.querySelectorAll('.structure-list li')].map((li) => [li.querySelector('.name, .label, button')?.textContent.trim() ?? li.textContent.trim().slice(0, 12), li.querySelector('.frame-note')?.textContent.trim() ?? null]))`);
const gtv50 = Object.entries(notes).find(([k]) => k.includes('GTV_50'));
const itv = Object.entries(notes).find(([k]) => k.includes('ITV'));
if (!gtv50 || gtv50[1] !== '只在 50%' || (itv && itv[1] !== null)) throw new Error(`結構的幀標示：${JSON.stringify(notes)}`);
await shot('v2b-viewer-ct1.png');
step(`ct1 檢視器：「${title}」${t0} → 相位 50%（6／10），軸向格變了；GTV_50「只在 50%」、ITV 不標`);

// ── mr1 ─────────────────────────────────────────────────────────────────────
await openPatient('SYN4D-MR1');
await waitFor(`!!${rowWith('image', 'DCE T1 FFE dyn')}`, 'DCE 序列');
const dyn = await evaluate(`${rowWith('image', 'DCE T1 FFE dyn')}.querySelector('.badge.dynamic')?.textContent.trim() ?? null`);
if (dyn !== '動態 ×12') throw new Error(`動態徽章：${dyn}`);
await evaluate(`${rowWith('image', 'DCE T1 FFE dyn')}.querySelector('input[type=checkbox]').click(); true`);
await openCase();
const m0 = await timeText();
await next(1);
await waitFor(`document.querySelector('.time-group .time-text').textContent.includes('t = 10.0 s')`, 'DCE 第 2 個時間點');
if (!m0.startsWith('第 1／12 個時間點 · t = 0.00 s')) throw new Error(`DCE 時間軸文字：${m0}`);
step(`mr1：資料頁「${dyn}」→ 開啟「${m0}」→ 下一個「${await timeText()}」`);

// ── ct4 ─────────────────────────────────────────────────────────────────────
await openPatient('SYN4D-CT4');
await waitFor(`!!${rowWith('temporal', '可能是同一次動態掃描')}`, '低信心候選');
const low = await evaluate(`(() => { const r = ${rowWith('temporal', '可能是同一次動態掃描')}; return { merged: r.querySelector('.merge-toggle input').checked, badge: r.querySelector('.badge.temporal-low')?.textContent.trim() }; })()`);
if (low.merged || low.badge !== '需確認') throw new Error(`低信心候選預設不合併、要標需確認：${JSON.stringify(low)}`);
await evaluate(`${rowWith('temporal', '可能是同一次動態掃描')}.querySelector('input[type=checkbox]').click(); true`);
await evaluate(`${rowWith('temporal', '可能是同一次動態掃描')}.querySelector('.merge-toggle input').click(); true`);
await openCase();
const c0 = await timeText();
if (!c0.startsWith('第 1／10 個時間點')) throw new Error(`低信心候選合併後應是 10 個時間點：${c0}`);
step(`ct4：「需確認」、預設不合併；勾合併 → 開啟「${c0}」`);

// ── ct5（Enhanced 多幀，一個檔）──────────────────────────────────────────────
await openPatient('SYN4D-CT5');
await waitFor(`!!${rowWith('image', 'Thorax 4D Enhanced')}`, 'Enhanced 序列');
const mf = await evaluate(`${rowWith('image', 'Thorax 4D Enhanced')}.querySelector('.badge.dynamic')?.textContent.trim() ?? null`);
if (mf !== '多幀 400') throw new Error(`多幀徽章：${mf}`);
await evaluate(`${rowWith('image', 'Thorax 4D Enhanced')}.querySelector('input[type=checkbox]').click(); true`);
await openCase();
const e0 = await timeText();
await next(3);
await waitFor(`document.querySelector('.time-group .time-text').textContent.trim().startsWith('相位 30%（4／10）')`, 'Enhanced 相位 30%');
if (!e0.startsWith('相位 0%（1／10）')) throw new Error(`Enhanced 時間軸文字：${e0}`);
step(`ct5：資料頁「${mf}」→ 開啟「${e0}」→ 相位 30%（4／10）`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
