#!/usr/bin/env node
/**
 * 管理頁「射束資料」—— headless Chrome ＋ CDP（骨架同 `verify-ct-calibration.mjs`、零相依），真的滑鼠／鍵盤事件：
 *
 *   清單有 11 份內建的公開文獻資料（示範用）→ 點開 Gao 2019 Halcyon：出處、授權、10 筆量測；點方形射野輸出因子 → 折線 9 點
 *   複製成新草稿：量測帶過來 → 貼通用 CSV 加一筆 PDD → 解析並加入（11 筆）→ 移除一筆 → 存成草稿
 *   編輯 → 改成 CSV 編輯（量測搬進文字框）→ 解析並加入 → 存檔：量測筆數不變
 *   鎖定 → 「已鎖定」、沒有編輯按鈕
 *   英文模式沒有中文
 *
 * 需要量測堆疊（auth off）：
 *   scripts/perf/stack.sh start
 *   node scripts/verify-beam-data.mjs --url http://127.0.0.1:5183/#/admin/beamdata [--out-dir DIR]
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
const url = args.url ?? 'http://127.0.0.1:5183/#/admin/beamdata';
const outDir = args['out-dir'] ?? null;
const port = Number(args.port ?? 9351);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-beamdata-'));
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
  await shot('beamdata-failed.png').catch(() => undefined);
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

const tab = `document.querySelector('.beamdata-tab')`;
const rowsOf = () => evaluate(`[...${tab}.querySelectorAll('.beamdata-list tbody tr')].map((tr) => ({ id: tr.dataset.id, status: tr.dataset.status, text: tr.innerText.replace(/\\s+/g, ' ') }))`);
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
await waitFor(`!!${tab}?.querySelector('.beamdata-list tbody tr')`, '射束資料分頁');

const rowSel = (id) => `${tab}.querySelector('.beamdata-list tbody tr[data-id=${JSON.stringify(id)}]')`;
const mRows = (scope) => evaluate(`${tab}.querySelectorAll('${scope} .beamdata-measurements tbody tr').length`);

// 1. 內建
let rows = await rowsOf();
const builtin = rows.filter((r) => r.status === 'builtin');
if (builtin.length !== 11 || !builtin.every((r) => /示範用/.test(r.text))) throw new Error(`應有 11 份內建（示範用）：${JSON.stringify(rows)}`);
await clickEl(rowSel('pub-gao2019-halcyon'));
await waitFor(`${tab}.querySelector('.beamdata-detail')?.dataset.id === 'pub-gao2019-halcyon'`, 'Gao 2019 的內容');
const head = await evaluate(`${tab}.querySelector('.beamdata-detail').innerText`);
if (!/CC BY 4\.0/.test(head) || !/10\.1002\/acm2\.12719/.test(head)) throw new Error(`出處或授權沒顯示：${head.slice(0, 400)}`);
if ((await mRows('.beamdata-detail')) !== 10) throw new Error(`Gao 2019 應有 10 筆量測：${await mRows('.beamdata-detail')}`);
await clickEl(`${tab}.querySelector('.beamdata-detail .beamdata-measurements tr[data-id="gao2019-t5-of-square"]')`);
await waitFor(`${tab}.querySelectorAll('.beamdata-detail .beamdata-plot circle').length === 9`, '方形射野輸出因子的折線（9 點）', 10000);
await shot('beamdata-builtin.png');
step(`內建 ${builtin.length} 份（示範用）；Gao 2019：出處、授權、10 筆量測、輸出因子折線 9 點`);

// 2. 複製 → 加一筆 CSV → 移除一筆 → 存成草稿
await clickEl(`${tab}.querySelector('button[data-action="beamdata-copy"]')`);
await waitFor(`${tab}.querySelector('.beamdata-form')?.dataset.mode === 'copy'`, '複製表單', 5000);
if ((await mRows('.beamdata-form')) !== 10) throw new Error('複製表單應帶 10 筆量測');
await setValue(`${tab}.querySelector('[data-field="beamdata-name"]')`, 'Halcyon copy');
await typeInto(`${tab}.querySelector('[data-field="beamdata-csv"]')`, '# kind: depth_dose\n# quantity: pdd\n# field_mm: 100 x 100\n# ssd_mm: 900\n# unit: percent\ndepth_mm, value\n12.5, 100\n100, 63.2\n200, 36.5');
await clickEl(`${tab}.querySelector('button[data-action="beamdata-parse"]')`);
await waitFor(`${tab}.querySelectorAll('.beamdata-form .beamdata-measurements tbody tr').length === 11`, '解析後 11 筆', 10000);
await clickEl(`${tab}.querySelector('.beamdata-form .beamdata-measurements tr[data-id="gao2019-tg51"] button[data-action="beamdata-remove-measurement"]')`);
await waitFor(`${tab}.querySelectorAll('.beamdata-form .beamdata-measurements tbody tr').length === 10`, '移除後 10 筆', 5000);
await clickEl(`${tab}.querySelector('button[data-action="beamdata-save"]')`);
await waitFor(`[...${tab}.querySelectorAll('.beamdata-list tbody tr')].some((tr) => tr.dataset.status === 'draft')`, '草稿', 10000);
await waitFor(`${tab}.querySelector('.beamdata-detail h3')?.textContent === 'Halcyon copy'`, '草稿的內容', 10000);
const draftId = await evaluate(`${tab}.querySelector('.beamdata-detail').dataset.id`);
let saved = await evaluate(`fetch('/api/v1/beam-data/' + encodeURIComponent(${JSON.stringify(draftId)})).then((r) => r.json())`);
const ids = saved.measurements.map((x) => x.measurement_id);
if (saved.derived_from !== 'pub-gao2019-halcyon' || ids.length !== 10 || ids.includes('gao2019-tg51') || !saved.measurements.some((x) => x.label === 'PDD 100×100 SSD 900')) throw new Error(`草稿內容不對：${JSON.stringify(ids)}`);
step(`複製 → 貼 CSV 加一筆 PDD → 移除絕對校正 → 草稿 ${draftId}（10 筆、複製自 Gao 2019）`);

// 3. 編輯：改成 CSV 編輯 → 解析 → 存檔
await clickEl(`${tab}.querySelector('button[data-action="beamdata-edit"]')`);
await waitFor(`${tab}.querySelector('.beamdata-form')?.dataset.mode === 'edit'`, '編輯表單', 5000);
await clickEl(`${tab}.querySelector('button[data-action="beamdata-export"]')`);
await waitFor(`${tab}.querySelectorAll('.beamdata-form .beamdata-measurements tbody tr').length === 0 && ${tab}.querySelector('[data-field="beamdata-csv"]').value.includes('# kind: output_factor')`, '量測搬進 CSV 欄位', 5000);
await clickEl(`${tab}.querySelector('button[data-action="beamdata-parse"]')`);
await waitFor(`${tab}.querySelectorAll('.beamdata-form .beamdata-measurements tbody tr').length === 10`, 'CSV 解析回 10 筆', 10000);
await clickEl(`${tab}.querySelector('button[data-action="beamdata-save"]')`);
await waitFor(`!${tab}.querySelector('.beamdata-form')`, '存檔', 10000);
saved = await evaluate(`fetch('/api/v1/beam-data/' + encodeURIComponent(${JSON.stringify(draftId)})).then((r) => r.json())`);
const rect = saved.measurements.find((x) => x.columns[0] === 'field_x_mm');
if (saved.measurements.length !== 10 || !saved.updated_by || !rect || rect.points.length !== 2) throw new Error(`CSV 往返後內容不對：${JSON.stringify(saved.measurements.map((x) => x.label))}`);
step('編輯 → 改成 CSV 編輯 → 解析並加入 → 存檔：10 筆不變（長方形射野的輸出因子也對）');

// 4. 鎖定
await waitFor(`!!${tab}.querySelector('button[data-action="beamdata-lock"]')`, '鎖定按鈕', 10000);
await clickEl(`${tab}.querySelector('button[data-action="beamdata-lock"]')`);
await waitFor(`${rowSel(draftId)}?.dataset.status === 'locked'`, '已鎖定', 10000);
await waitFor(`!${tab}.querySelector('button[data-action="beamdata-edit"]')`, '鎖定後沒有編輯按鈕', 10000);
await shot('beamdata-locked.png');
step('鎖定 → 「已鎖定」、不能再編輯');

// 5. 英文
await send('Page.navigate', { url: url.replace('/#/', '/?lang=en#/') });
await waitFor(`!!${tab}?.querySelector('.beamdata-list tbody tr')`, '英文模式');
await clickEl(rowSel('pub-gao2019-halcyon'));
await waitFor(`!!${tab}.querySelector('.beamdata-detail')`, '英文模式的內容');
await clickEl(`${tab}.querySelector('.beamdata-detail .beamdata-measurements tr[data-id="gao2019-t5-of-square"]')`);
await clickEl(`${tab}.querySelector('button[data-action="beamdata-copy"]')`);
await waitFor(`!!${tab}.querySelector('.beamdata-form')`, '英文模式的表單', 5000);
const enText = await evaluate(`[${tab}.innerText, ...[...${tab}.querySelectorAll('[title],[placeholder],[aria-label]')].map((e) => (e.title || '') + ' ' + (e.getAttribute('placeholder') || '') + ' ' + (e.getAttribute('aria-label') || ''))].join(' | ')`);
const cjk = enText.match(/[　-鿿＀-￯]+/g);
if (cjk) throw new Error(`英文模式還有中文：${cjk.join(' ')}`);
step('英文模式：射束資料分頁沒有中文');

if (errors.length) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
