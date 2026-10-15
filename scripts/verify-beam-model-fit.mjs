#!/usr/bin/env node
/**
 * 管理頁「射束模型」的擬合 —— headless Chrome ＋ CDP（骨架同 `verify-beam-data.mjs`、零相依），真的滑鼠／鍵盤事件。
 * 要 GPU（擬合是真的跑；用最小的資料與統計量，幾分鐘）：
 *
 *   ＋ 擬合新模型：先驗選雙層 MLC 的示範模型、Lim 2019（Halcyon MLC）設成「擬合」、名稱、最少歷史數 → 開始擬合 → 進度
 *   完成 → 清單多一列「草稿」並選中：擬合的段（準直器有效密度）、比對（擬合用的 Lim 2019）
 *   啟用 → 「啟用中」、劑量計算的引擎清單裡是 active；停用 → 「已停用」
 *   英文模式沒有中文
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-beam-model-fit.mjs --url http://127.0.0.1:5183/#/admin/beammodel [--out-dir DIR]
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
const url = args.url ?? 'http://127.0.0.1:5183/#/admin/beammodel';
const outDir = args['out-dir'] ?? null;
const port = Number(args.port ?? 9353);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-beammodel-'));
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
  await shot('beammodel-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(250);
};
const centerOf = (expr) => evaluate(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);

const setValue = (selector, value, kind = 'input') =>
  evaluate(`(() => { const el = ${selector}; const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))}); el.dispatchEvent(new Event(${JSON.stringify(kind)}, { bubbles: true })); return true; })()`);
const clickEl = async (expr) => {
  await evaluate(`(${expr}).scrollIntoView({ block: 'center' }); true`);
  const c = await centerOf(expr);
  await clickAt(c.x, c.y);
};

const tab = `document.querySelector('.beammodel-tab')`;
const rowsOf = () => evaluate(`[...${tab}.querySelectorAll('.beammodel-list tbody tr')].map((tr) => ({ id: tr.dataset.id, status: tr.dataset.status, text: tr.innerText.replace(/\\s+/g, ' ') }))`);
const typeInto = async (selector, text) => {
  await clickEl(selector);
  await send('Input.insertText', { text });
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`!!${tab}?.querySelector('.beammodel-list tbody tr')`, '射束模型分頁');
const before = (await rowsOf()).length;

// 1. 擬合表單
await clickEl(`${tab}.querySelector('button[data-action="beammodel-fit"]')`);
await waitFor(`!!${tab}.querySelector('.beammodel-fit-form [data-field="fit-prior"]')`, '擬合表單', 5000);
await setValue(`${tab}.querySelector('[data-field="fit-prior"]')`, 'demo-6xfff-dual', 'change');
await waitFor(`!!${tab}.querySelector('.beammodel-fit-datasets tr[data-id="pub-lim2019-halcyon-mlc"]')`, 'Halcyon 的射束資料', 10000);
const offered = await evaluate(`[...${tab}.querySelectorAll('.beammodel-fit-datasets tbody tr')].map((tr) => tr.dataset.id)`);
if (offered.some((id) => /beyer2013-6x|akino2020-6x$/.test(id))) throw new Error(`6 MV FFF 的模型不該列出 6X 的資料：${offered}`);
await setValue(`${tab}.querySelector('.beammodel-fit-datasets tr[data-id="pub-lim2019-halcyon-mlc"] [data-field="fit-role"]')`, 'fit', 'change');
await typeInto(`${tab}.querySelector('[data-field="fit-name"]')`, 'Halcyon MLC fit (verify)');
await evaluate(`(() => { const el = ${tab}.querySelector('.beammodel-fit-form select:not([data-field])'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, '250000000'); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
await clickEl(`${tab}.querySelector('button[data-action="fit-start"]')`);
await waitFor(`!!${tab}.querySelector('.beammodel-fit-form [data-job]')`, '擬合工作開始', 10000);
step(`擬合表單：可選 ${offered.length} 份同能量模式的資料（${offered.join(', ')}）→ 工作開始`);

// 2. 完成 → 草稿
await waitFor(`!${tab}.querySelector('.beammodel-fit-form') && [...${tab}.querySelectorAll('.beammodel-list tbody tr')].some((tr) => tr.dataset.status === 'draft')`, '擬合完成（草稿）', 1_800_000);
const rows = await rowsOf();
if (rows.length !== before + 1) throw new Error(`清單應多一列：${rows.length} vs ${before}`);
await waitFor(`!!${tab}.querySelector('.beammodel-fit .beammodel-stages tr[data-stage="collimator_density"]')`, '擬合的段', 20000);
const stageText = await evaluate(`${tab}.querySelector('.beammodel-fit .beammodel-stages').innerText`);
if (!/MLCX1/.test(stageText) || !/MLCX2/.test(stageText)) throw new Error(`準直器密度的段應列出兩層：${stageText}`);
await clickEl(`${tab}.querySelector('.beammodel-fit details[data-dataset="pub-lim2019-halcyon-mlc"] summary')`);
await waitFor(`${tab}.querySelectorAll('.beammodel-fit details[data-dataset="pub-lim2019-halcyon-mlc"] .beammodel-checks tbody tr').length === 8`, '逐點比對 8 點', 10000);
const trans = await evaluate(`[...${tab}.querySelectorAll('.beammodel-fit .beammodel-checks tbody tr')].filter((tr) => /transmission/.test(tr.innerText)).map((tr) => tr.dataset.status)`);
await shot('beammodel-fit-draft.png');
step(`完成 → 草稿；段：準直器有效密度（MLCX1、MLCX2）；Lim 2019 逐點 8 點、穿透 ${trans.join('／')}`);

// 3. 啟用 → 停用
const id = await evaluate(`${tab}.querySelector('.beammodel-fit').dataset.for`);
await clickEl(`${tab}.querySelector('button[data-action="beammodel-activate"]')`);
await waitFor(`${tab}.querySelector('.beammodel-list tbody tr[data-id=${JSON.stringify(id)}]')?.dataset.status === 'active'`, '啟用中', 10000);
const eng = await evaluate(`fetch('/api/v1/dosecalc/engines').then((r) => r.json())`);
if (eng.beam_models.find((m) => m.model_id === id)?.status !== 'active') throw new Error('引擎清單裡應是 active');
await waitFor(`!!${tab}.querySelector('button[data-action="beammodel-retire"]')`, '停用按鈕', 10000);
await clickEl(`${tab}.querySelector('button[data-action="beammodel-retire"]')`);
await waitFor(`${tab}.querySelector('.beammodel-list tbody tr[data-id=${JSON.stringify(id)}]')?.dataset.status === 'retired'`, '已停用', 10000);
step(`啟用 → 劑量計算的模型清單是 active；停用 → 「已停用」（${id}）`);

// 4. 英文
await send('Page.navigate', { url: url.replace('/#/', '/?lang=en#/') });
await waitFor(`!!${tab}?.querySelector('.beammodel-list tbody tr')`, '英文模式');
await clickEl(`${tab}.querySelector('.beammodel-list tbody tr[data-id=${JSON.stringify(id)}]')`);
await waitFor(`!!${tab}.querySelector('.beammodel-fit .beammodel-stages')`, '英文模式的擬合內容', 10000);
await clickEl(`${tab}.querySelector('button[data-action="beammodel-fit"]')`);
await waitFor(`!!${tab}.querySelector('.beammodel-fit-form')`, '英文模式的表單', 5000);
const enText = await evaluate(`[${tab}.innerText, ...[...${tab}.querySelectorAll('[title],[placeholder],[aria-label]')].map((e) => (e.title || '') + ' ' + (e.getAttribute('placeholder') || '') + ' ' + (e.getAttribute('aria-label') || ''))].join(' | ')`);
const cjk = (enText.match(/[　-鿿＀-￯]+/g) || []).filter((x) => x !== '×');
if (cjk.length) throw new Error(`英文模式還有中文：${cjk.join(' ')}`);
step('英文模式：射束模型分頁沒有中文');

if (errors.length) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
