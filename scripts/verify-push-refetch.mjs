#!/usr/bin/env node
/**
 * 推送太大 → 伺服器改送「去拿」的小訊息 → 前端走 HTTP 拿場景 —— headless Chrome ＋ CDP（骨架同 `verify-temporal-compose.mjs`、零相依）。
 * 背景：MR 2006-08-27（CCTH-A06）曾經攤不開成 3D —— scene.replace 385 KB 超過推送上限，開發環境回 200 但畫面不動、重新整理後整片黑。
 *
 * chaos `push_limit` 把上限調到 2 KB（每一則 scene.replace 都超過），SYN4D-MR1（一個序列內 12 幀）：
 *   1. 開啟 → 連上時那一則也是「去拿」→ 畫面有影像、時間軸列在（HTTP 拿了場景）
 *   2. 攤開成 3D → 左欄 12 張；收回成 4D → 1 張（每次都走 HTTP 拿）
 *   3. 重新整理 → 照樣有影像
 *   4. chaos reset → 攤開／收回照樣更新，而且**不再**走 HTTP 拿（推送就夠）
 *
 *   PERF_TEST_API=1 scripts/perf/stack.sh start     （要 /_test/chaos）
 *   node scripts/verify-push-refetch.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR]
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
const port = Number(args.port ?? 9342);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-push-refetch-'));
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
  await shot('push-refetch-failed.png').catch(() => undefined);
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


const sceneFetches = [];
await send('Network.enable');
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  if (m.method === 'Network.requestWillBeSent' && /\/api\/v1\/sessions\/[^/]+\/scene/.test(m.params.request.url)) sceneFetches.push(m.params.request.url);
});
const chaos = (body) => fetch(`${new URL(url).origin}/api/v1/_test/chaos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => {
  if (!r.ok) throw new Error(`/_test/chaos ${r.status}（量測堆疊要用 PERF_TEST_API=1 啟動）`);
  return r.json();
});
try {
  // 1
  const st = await chaos({ reset: true, push_limit: 2048 });
  if (st.push_limit_bytes !== 2048) throw new Error(`chaos 沒設上：${JSON.stringify(st)}`);
  await openStudy('SYN4D-MR1', 'synth4d');
  await evaluate(`(document.querySelector('.catalog-tree tr[data-kind="temporal"] input[type=checkbox]') ?? document.querySelector('.catalog-tree tr[data-kind="image"] input[type=checkbox]')).click(); true`);
  await openCase(true);
  if (await evaluate(`!!document.querySelector('.time-group.is-expanded')`)) {
    await clickButton(`document.querySelector('.time-group')`, '收回成 4D');
    await waitFor(`!document.querySelector('.time-group.is-expanded') && ${rows}.length === 1`, '收回上一輪的攤開', 30000);
  }
  if (sceneFetches.length < 1) throw new Error('連上時應該收到「去拿」、走 HTTP 拿場景');
  await sleep(1500);
  if (!((await canvasSum('軸向')) > 0)) throw new Error('開啟後軸向格是黑的');
  step(`開啟（推送上限 2 KB）：連上時收到「去拿」→ HTTP 拿了場景 ${sceneFetches.length} 次、畫面有影像、時間軸列在`);

  // 2
  let n = sceneFetches.length;
  await clickButton(`document.querySelector('.time-group')`, '攤開成 3D');
  await waitFor(`${rows}.length === 12 && !!document.querySelector('.time-group.is-expanded')`, '攤開：左欄 12 張', 20000);
  if (sceneFetches.length <= n) throw new Error('攤開後應該走 HTTP 拿場景');
  await shot('push-refetch-expanded.png');
  n = sceneFetches.length;
  await clickButton(`document.querySelector('.time-group')`, '收回成 4D');
  await waitFor(`${rows}.length === 1 && !document.querySelector('.time-group.is-expanded')`, '收回：左欄 1 張', 20000);
  if (sceneFetches.length <= n) throw new Error('收回後應該走 HTTP 拿場景');
  step('攤開成 3D → 左欄 12 張、收回成 4D → 1 張（每次都經「去拿」→ HTTP）');

  // 3
  await send('Page.reload');
  await waitFor(`location.hash.includes('viewer') && ${rows}.length === 1 && !!document.querySelector('.time-group')`, '重新整理後回到病例', 120000);
  await sleep(3000);
  if (!((await canvasSum('軸向')) > 0)) throw new Error('重新整理後軸向格是黑的');
  step('重新整理：照樣有影像（以前連上時那一則丟例外 → 連線一直斷、整片黑）');

  // 4
  await chaos({ reset: true });
  await sleep(500);
  n = sceneFetches.length;
  await clickButton(`document.querySelector('.time-group')`, '攤開成 3D');
  await waitFor(`${rows}.length === 12`, 'reset 後攤開', 20000);
  await clickButton(`document.querySelector('.time-group')`, '收回成 4D');
  await waitFor(`${rows}.length === 1`, 'reset 後收回', 20000);
  await sleep(2000); // 過了「1.5 秒沒收到就自己拿」的時間
  if (sceneFetches.length !== n) throw new Error(`reset 後不該再走 HTTP 拿場景（多了 ${sceneFetches.length - n} 次）`);
  step('chaos reset：攤開／收回照樣更新，推送就夠、沒有多打 HTTP');
} finally {
  await chaos({ reset: true }).catch(() => undefined);
}

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
