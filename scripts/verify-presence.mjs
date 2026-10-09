#!/usr/bin/env node
/**
 * presence「正在編輯哪個結構」—— 兩個方向都走一次（量測堆疊，`RTGAIA_AUTH=off`）。
 * headless Chrome ＋ CDP（骨架同 `verify-demo-open.mjs`、零相依）＋ `scripts/presence_peer.py`（另一個人 lin）。
 *
 *   Pancreas-CT-CB_014：資料頁勾 CT（帶 RS、劑量）→ 開啟（記下 `POST /sessions` 的 body）
 *   我：ROI 編輯 → 新建「PresenceProbe」→ 筆刷 → 0.4 s 後後端的 presence 裡我的 session `editing` ＝ PresenceProbe；關筆刷 → null
 *   lin（presence_peer.py，用同一個 body 開同一個病例、連 WS、回報正在編輯第一個結構）→
 *       我的結構清單那一列出現「✎ lin」；標頭「● 1 人在線」的說明有「lin：編輯 <名稱>」
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-presence.mjs --url http://127.0.0.1:5183/#/library [--api http://127.0.0.1:8091] [--out-dir DIR]
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

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-presence-'));
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
  await shot('presence-failed.png').catch(() => undefined);
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

const api = args.api ?? 'http://127.0.0.1:8091';
const clickButton = (scope, text) => evaluate(`(() => { const b = [...(${scope}).querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
const sessionBodies = [];
const requests = new Map();
await send('Network.enable');
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  if (m.method === 'Network.requestWillBeSent' && m.params.request.method === 'POST' && /\/api\/v1\/sessions$/.test(m.params.request.url)) {
    requests.set(m.params.requestId, true);
    if (m.params.request.postData) sessionBodies.push(m.params.request.postData);
  }
});

await openStudy('Pancreas-CT-CB_014', 'UPPER GI');
const withDose = `${rowsWith('image', 'Aligned CT')}.find((r) => r.querySelector('.badge.dose'))`;
await waitFor(`!!${withDose}`, '有劑量的 CT 列');
await evaluate(`${withDose}.querySelector('input[type=checkbox]').click(); true`);
await waitFor(`document.querySelector('.selection-summary').textContent.includes('套結構集')`, '選取帶進結構集', 20000);
await openCase();
if (sessionBodies.length === 0) throw new Error('沒有攔到 POST /sessions 的 body');
const current = await evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json())`);
const caseId = current.caseId;
const mySid = current.sessionId;
const myEditing = () => evaluate(`fetch('/api/v1/cases/${caseId}').then((r) => r.json()).then((c) => (c.presence.find((p) => p.session_id === '${mySid}') ?? {}).editing ?? null)`);

// 我：新建 → 筆刷 → editing ＝ 新結構
await clickButton('document', 'ROI 編輯');
await waitFor(`!!document.querySelector('.roi-panel')`, 'ROI 編輯面板');
await clickButton(`document.querySelector('.roi-panel')`, '新建');
await waitFor(`!!document.querySelector('.roi-create .roi-name')`, '新建欄位');
await evaluate(`(() => { const el = document.querySelector('.roi-create .roi-name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'PresenceProbe'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await clickButton(`document.querySelector('.roi-create')`, '建立');
const probeId = async () => (await evaluate(`fetch('/api/v1/studies/${current.studyId}/structures').then((r) => r.json()).then((l) => ((Array.isArray(l) ? l : l.structures ?? []).find((x) => x.name === 'PresenceProbe') ?? {}).structure_id ?? null)`));
await waitFor(`fetch('/api/v1/studies/${current.studyId}/structures').then((r) => r.json()).then((l) => (Array.isArray(l) ? l : l.structures ?? []).some((x) => x.name === 'PresenceProbe'))`, 'PresenceProbe 建好', 15000);
const pid = await probeId();
await clickButton(`document.querySelector('.roi-panel')`, '筆刷');
let edited = null;
for (let i = 0; i < 40 && edited !== pid; i += 1) {
  await sleep(150);
  edited = await myEditing();
}
if (edited !== pid) throw new Error(`筆刷作用中時 presence 應回報 PresenceProbe（${pid}）：${edited}`);
step(`我：筆刷作用中 → presence 的 editing ＝ PresenceProbe`);
await clickButton(`document.querySelector('.roi-panel')`, '筆刷');
for (let i = 0; i < 40 && edited !== null; i += 1) {
  await sleep(150);
  edited = await myEditing();
}
if (edited !== null) throw new Error(`關掉筆刷後 editing 應清掉：${edited}`);
step('我：關掉筆刷 → editing 清掉');

// lin：開同一個病例、回報正在編輯第一個結構
const bodyFile = join(profile, 'session-body.json');
writeFileSync(bodyFile, sessionBodies[sessionBodies.length - 1]);
const peer = spawn('uv', ['run', 'python', 'scripts/presence_peer.py', '--api', api, '--user', 'lin', '--body', bodyFile], { stdio: ['pipe', 'pipe', 'inherit'] });
process.on('exit', () => {
  try {
    peer.kill('SIGKILL');
  } catch {
    /* already gone */
  }
});
const peerLine = await new Promise((resolve, reject) => {
  let buf = '';
  peer.stdout.on('data', (d) => {
    buf += String(d);
    const nl = buf.indexOf('\n');
    if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl)));
  });
  peer.on('exit', (code) => reject(new Error(`presence_peer 結束了（${code}）`)));
  setTimeout(() => reject(new Error('presence_peer 60 s 沒回報')), 60000);
});
await expandStructures();
const ROW = `[...document.querySelectorAll('.structure-list li')].find((li) => li.querySelector('.editing-note')?.textContent.includes('lin'))`;
await waitFor(`!!${ROW}`, `結構清單出現「✎ lin」（lin 在編輯 ${peerLine.name}）`, 20000);
const rowText = await evaluate(`${ROW}.textContent`);
if (!rowText.includes(peerLine.name)) throw new Error(`「✎ lin」應該在 ${peerLine.name} 那一列：${rowText}`);
await waitFor(`(document.querySelector('.case-summary .online')?.title ?? '').includes('lin：編輯 ${peerLine.name}')`, `標頭說明「lin：編輯 ${peerLine.name}」`, 10000);
const headerTitle = await evaluate(`document.querySelector('.case-summary .online').title`);
await shot('presence-presence.png');
step(`lin 在編輯「${peerLine.name}」→ 那一列「✎ lin」、標頭說明「${headerTitle.replace(/\n/g, ' ｜ ')}」`);
peer.stdin.end();
await new Promise((r) => peer.on('exit', r));

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
