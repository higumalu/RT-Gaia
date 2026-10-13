#!/usr/bin/env node
/**
 * 管理頁「射束模型」—— headless Chrome ＋ CDP（骨架同 `verify-ct-calibration.mjs`、零相依），真的滑鼠事件：
 *
 *   清單有三個內建示範模型（demo-6x、demo-6xfff、demo-6xfff-dual），都標「示範用」
 *   點開 demo-6x：能譜圖有柱、平均能量、射源、準直器三列（jaw、jaw、MLC）、MU 校正條件、來源與限制
 *   做過 MU 校正的模型有 PDD 折線與每 MU 歷史數（沒做過的說明會在第一次計算時做）
 *   點開 demo-6xfff-dual：準直器有固定主準直器、兩層 MLC
 *   英文模式沒有中文
 *
 * 需要量測堆疊（auth off）：
 *   scripts/perf/stack.sh start
 *   node scripts/verify-beam-models.mjs --url http://127.0.0.1:5183/#/admin/beammodel [--out-dir DIR]
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
  await shot('ctcal-failed.png').catch(() => undefined);
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

const tab = `document.querySelector('.beammodel-tab')`;
const rowsOf = () => evaluate(`[...${tab}.querySelectorAll('.beammodel-list tbody tr')].map((tr) => ({ id: tr.dataset.id, text: tr.innerText.replace(/\\s+/g, ' ') }))`);

await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); } catch {}" });
await send('Page.navigate', { url: url.replace('/#/', '/?lang=zh-TW#/') }); // 帳號偏好可能是英文（別的腳本切過）
await waitFor(`${tab}?.querySelectorAll('.beammodel-list tbody tr').length >= 3`, '射束模型清單', 30000);
const rows = await rowsOf();
const ids = rows.map((r) => r.id);
if (!['demo-6x', 'demo-6xfff', 'demo-6xfff-dual'].every((id) => ids.includes(id)) || rows.some((r) => !r.text.includes('示範用'))) throw new Error(`清單：${JSON.stringify(rows)}`);
step(`清單：${rows.map((r) => r.text).join(' ／ ')}`);

// demo-6x
await clickEl(`${tab}.querySelector('.beammodel-list tr[data-id="demo-6x"]')`);
const detail = `${tab}.querySelector('.beammodel-detail[data-for="demo-6x"]')`;
await waitFor(`!!${detail}`, 'demo-6x 細節', 10000);
const info = await evaluate(`(() => { const d = ${detail}; return { bars: d.querySelectorAll('.beammodel-spectrum rect').length, cols: [...d.querySelectorAll('.beammodel-collimators tr')].map((tr) => tr.dataset.device), text: d.innerText, pdd: d.querySelector('.beammodel-pdd polyline')?.getAttribute('points')?.split(' ').length ?? 0 }; })()`);
if (info.bars < 20) throw new Error(`能譜柱 ${info.bars}`);
if (info.cols.join(',') !== 'jaw_y,jaw_x,MLCX') throw new Error(`準直器 ${info.cols}`);
if (!/平均能量 1\.\d\d MeV/.test(info.text) || !info.text.includes('1 MU ＝ 1 cGy') || !info.text.includes('Mohan')) throw new Error(`說明：${info.text.slice(0, 400)}`);
const calibrated = rows.find((r) => r.id === 'demo-6x').text.includes('已校正');
if (calibrated && info.pdd < 50) throw new Error(`做過校正但 PDD 只有 ${info.pdd} 點`);
if (!calibrated && !info.text.includes('還沒做過這個模型的 MU 校正')) throw new Error('沒校正的說明');
await shot('beammodel-6x.png');
step(`demo-6x：能譜 ${info.bars} 段、準直器 ${info.cols.join('／')}、${calibrated ? `PDD ${info.pdd} 點` : '還沒校正'}`);

// demo-6xfff-dual
await clickEl(`${tab}.querySelector('.beammodel-list tr[data-id="demo-6xfff-dual"]')`);
const dual = `${tab}.querySelector('.beammodel-detail[data-for="demo-6xfff-dual"]')`;
await waitFor(`!!${dual}`, 'demo-6xfff-dual 細節', 10000);
const dcols = await evaluate(`[...${dual}.querySelectorAll('.beammodel-collimators tr')].map((tr) => tr.innerText.replace(/\\s+/g, ' '))`);
if (dcols.length !== 4 || !dcols.some((c) => c.includes('固定主準直器') && c.includes('開口 ± 140 mm')) || !dcols.some((c) => c.startsWith('MLCX2'))) throw new Error(`雙層：${JSON.stringify(dcols)}`);
step(`demo-6xfff-dual：${dcols.join(' ／ ')}`);

// 英文
await send('Page.navigate', { url: url.replace('/#/', '/?lang=en#/') });
await waitFor(`${tab}?.querySelectorAll('.beammodel-list tbody tr').length >= 3`, '英文模式', 30000);
await clickEl(`${tab}.querySelector('.beammodel-list tr[data-id="demo-6xfff-dual"]')`);
await waitFor(`!!${tab}.querySelector('.beammodel-detail')`, '英文模式細節', 10000);
const enText = await evaluate(`[${tab}.innerText, ...[...${tab}.querySelectorAll('[title],[aria-label]')].map((e) => (e.title || '') + ' ' + (e.getAttribute('aria-label') || ''))].join(' | ')`);
const cjk = enText.match(/[　-鿿＀-￯]+/g);
if (cjk) throw new Error(`英文模式還有中文：${cjk.join(' ')}`);
step('英文模式：射束模型分頁沒有中文');

if (errors.length) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
