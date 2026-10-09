#!/usr/bin/env node
/**
 * 4D 的結構 —— headless Chrome ＋ CDP（骨架同 `verify-temporal-compose.mjs`、零相依）。
 * 同名結構跨相位合成一個時間結構、複製到全部相位、ITV。
 *
 *   SYN4D-CT2（每個相位一份 RS：GTV_c00…GTV_c90，各只在自己那一幀）：
 *   1. 開啟 → 時間軸列「相位結構…」→ 自動找到一組「GTV ← GTV_c00…（10 幀）」→ 合成 → 結構清單多一個 10 幀的 GTV（我的集）、成為作用中
 *   2. ROI 編輯面板「相位」列：在 10／10 幀；勾「蓋掉已有的」→「複製這一幀到其他相位」→ 每一幀內容 ＝ 第 1 幀
 *   3. 相位結構對話框：ITV 勾 GTV_c00…c90 的合成前來源（全部幀）→ 建立 ITV → 靜態、體積 ≥ 任何一幀
 *   開頭先刪掉上一輪留下的、結束時刪掉這一輪建的（GTV／ITV 在我的集；刪除進暫存區）。
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-temporal-structures.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR] [--token <rtgaia_session>]
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
const port = Number(args.port ?? 9343);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-temporal-structures-'));
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
  await shot('temporal-structures-failed.png').catch(() => undefined);
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


const api = (path, init) => evaluate(`fetch('/api/v1${path}', ${JSON.stringify(init ?? {})}).then(async (r) => ({ status: r.status, body: await r.text() }))`).then((r) => ({ status: r.status, body: r.body ? JSON.parse(r.body) : null }));
const listStructures = async () => {
  const sid = await studyId();
  const r = await api(`/studies/${sid}/structures`);
  return Array.isArray(r.body) ? r.body : (r.body?.structures ?? []);
};

// 開頭：上一輪留下的（我的集裡的 GTV／ITV）刪掉
await openStudy('SYN4D-CT2', 'synth4d');
await waitFor(`!!document.querySelector('.catalog-tree tr[data-kind="temporal"]')`, 'CT2 的時間軸');
await evaluate(`document.querySelector('.catalog-tree tr[data-kind="temporal"] input[type=checkbox]').click(); true`);
await openCase(true);
for (const s of await listStructures()) {
  if (s.structure_set_kind === 'work' && /^(GTV|ITV)$/.test(s.name)) await api(`/structures/${s.structure_id}`, { method: 'DELETE' });
}
await sleep(1000);

// 1
await clickButton(`document.querySelector('.time-group')`, '相位結構…');
await waitFor(`!!document.querySelector('.phase-structures-dialog')`, '相位結構對話框');
const groups = await evaluate(`[...document.querySelectorAll('.phase-groups li')].map((li) => ({ stem: li.dataset.stem, text: li.textContent }))`);
if (groups.length !== 1 || groups[0].stem !== 'GTV' || !groups[0].text.includes('10')) throw new Error(`自動分組：${JSON.stringify(groups)}`);
await shot('phase-structures-dialog.png');
await clickButton(`document.querySelector('.phase-groups li')`, '合成');
await waitFor(`document.querySelector('.phase-structures-dialog .ok')?.textContent.includes('已合成')`, '合成完成', 30000);
let gtv = (await listStructures()).find((s) => s.name === 'GTV' && s.structure_set_kind === 'work');
if (!gtv || JSON.stringify(gtv.frames) !== JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])) throw new Error(`合成的 GTV：${JSON.stringify(gtv)}`);
await clickButton(`document.querySelector('.phase-structures-dialog')`, '關閉');
step(`相位結構對話框自動找到「GTV ← GTV_c00…」→ 合成 → 一個 10 幀的 GTV（我的集）`);

// 2
await clickButton('document', 'ROI 編輯');
await waitFor(`!!document.querySelector('.roi-phase')`, 'ROI 面板的相位列（作用中 ＝ 合成的 GTV）', 20000);
const phaseText = await evaluate(`document.querySelector('.roi-phase').textContent`);
if (!phaseText.includes('10／10')) throw new Error(`相位列：${phaseText}`);
await evaluate(`document.querySelector('.roi-phase input[type=checkbox]').click(); true`);
const before = new Set(Object.values(gtv.content_hashes ?? {}));
if (before.size < 2) throw new Error('合成後每一幀應該不同');
await clickButton(`document.querySelector('.roi-phase')`, '複製這一幀到其他相位');
let same = false;
for (let i = 0; i < 40 && !same; i += 1) {
  await sleep(250);
  gtv = (await listStructures()).find((s) => s.structure_id === gtv.structure_id);
  same = new Set(Object.values(gtv.content_hashes ?? {})).size === 1;
}
if (!same) throw new Error(`複製到其他相位後每一幀應該一樣：${JSON.stringify(gtv.content_hashes)}`);
await clickButton('document', 'ROI 編輯');
step(`ROI 面板「相位」列：在 10／10 幀 →「蓋掉已有的」＋「複製這一幀到其他相位」→ 10 幀內容相同`);

// 3
await clickButton(`document.querySelector('.time-group')`, '相位結構…');
await waitFor(`!!document.querySelector('.phase-structures-itv')`, 'ITV 區');
await evaluate(`[...document.querySelectorAll('.phase-structures-itv .phase-pick-list label')].filter((l) => /GTV_c\\d\\d/.test(l.textContent)).forEach((l) => l.querySelector('input').click()); true`);
await clickButton(`document.querySelector('.phase-structures-itv')`, '建立 ITV');
await waitFor(`document.querySelector('.phase-structures-dialog .ok')?.textContent.includes('已建立')`, 'ITV 建立完成', 30000);
const all = await listStructures();
const itv = all.find((s) => s.name === 'ITV' && s.structure_set_kind === 'work');
const phases = all.filter((s) => /^GTV_c\d\d$/.test(s.name));
const maxPhase = Math.max(...phases.map((s) => (Array.isArray(s.volume_cc) ? s.volume_cc[0] : s.volume_cc)));
if (!itv || itv.frames !== null || !(itv.volume_cc > maxPhase)) throw new Error(`ITV：${JSON.stringify(itv)}，最大一幀 ${maxPhase}`);
await clickButton(`document.querySelector('.phase-structures-dialog')`, '關閉');
step(`ITV（GTV_c00…c90 全部幀）→ 靜態、${itv.volume_cc.toFixed(1)} cc > 任何一幀（最大 ${maxPhase.toFixed(1)} cc）`);

// 收尾：這一輪建的 GTV／ITV 刪掉（開發環境跑也不留東西；刪除進暫存區）
for (const s of await listStructures()) {
  if (s.structure_set_kind === 'work' && /^(GTV|ITV)$/.test(s.name)) await api(`/structures/${s.structure_id}`, { method: 'DELETE' });
}

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
