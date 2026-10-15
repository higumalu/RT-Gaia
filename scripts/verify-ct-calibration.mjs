#!/usr/bin/env node
/**
 * 管理頁「CT 校正曲線」—— headless Chrome ＋ CDP（骨架同 `verify-dose-ops.mjs`、零相依），真的滑鼠／鍵盤事件：
 *
 *   清單只有內建 Schneider 2000（示範用）→ 點開：曲線、25 段材質
 *   病例的 CT 現在用內建曲線（fallback）
 *   ＋ 新增曲線：比對規則填病例 CT 的機型與 kVp、貼點表（含表頭）→ 預覽有曲線 → 存成草稿 → 清單多一列「草稿」
 *   啟用 → 「啟用中」、病例的 CT 改用它；停用 → 「已停用」、病例的 CT 退回內建
 *   內建「複製成新草稿」：點表帶過來、預設曲線與示範用已勾 → 存成草稿 → 「編輯」改名稱與一點 → 存檔 →
 *   啟用 → 病例的 CT 用這條預設曲線（不是 fallback、但標示範用）→ 停用，退回內建
 *   英文模式沒有中文
 *
 * 需要量測堆疊（auth off、病例已載入）：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-ct-calibration.mjs --url http://127.0.0.1:5183/#/admin/ctcal [--out-dir DIR]
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
const url = args.url ?? 'http://127.0.0.1:5183/#/admin/ctcal';
const outDir = args['out-dir'] ?? null;
const port = Number(args.port ?? 9349);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-ctcal-'));
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

const tab = `document.querySelector('.ctcal-tab')`;
const rowsOf = () => evaluate(`[...${tab}.querySelectorAll('.ctcal-list tbody tr')].map((tr) => ({ id: tr.dataset.id, status: tr.dataset.status, text: tr.innerText.replace(/\\s+/g, ' ') }))`);
const typeInto = async (selector, text) => {
  await clickEl(selector);
  await send('Input.insertText', { text });
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
const sessionCt = async () => {
  const s = await evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json())`);
  const ct = s.layers.find((l) => l.kind === 'image' && /^CT$/i.test(l.modality ?? '') && l.frameOfReferenceUid === s.frameGroups?.find?.((f) => f.role === 'primary')?.frameOfReferenceUid) ?? s.layers.find((l) => l.kind === 'image' && /^CT$/i.test(l.modality ?? ''));
  return ct.contentRef;
};
await send('Page.navigate', { url });
await waitFor(`!!${tab}?.querySelector('.ctcal-list tbody tr')`, 'CT 校正曲線分頁');

// 1. 內建
let rows = await rowsOf();
if (rows.length !== 1 || rows[0].status !== 'builtin' || !/示範用/.test(rows[0].text)) throw new Error(`清單應只有內建（示範用）：${JSON.stringify(rows)}`);
await clickEl(`${tab}.querySelector('.ctcal-list tbody tr')`);
await waitFor(`!!${tab}.querySelector('.ctcal-detail .ctcal-plot path')`, '內建曲線的圖');
const mats = await evaluate(`${tab}.querySelectorAll('.ctcal-materials tbody tr').length`);
const segs = await evaluate(`${tab}.querySelector('.ctcal-detail .ctcal-plot path').getAttribute('d').split('L').length`);
if (mats !== 25 || segs < 100) throw new Error(`材質 25 段、曲線點數：${mats}、${segs}`);
await shot('ctcal-builtin.png');
step(`內建 Schneider 2000（示範用）：曲線 ${segs} 點、材質 ${mats} 段`);

// 2. 病例的 CT 現在用內建
const ct = await sessionCt();
let res = await evaluate(`fetch('/api/v1/series/' + encodeURIComponent(${JSON.stringify(ct)}) + '/ct-calibration').then((r) => r.json())`);
if (!res.fallback) throw new Error(`沒有使用者曲線時應退回內建：${JSON.stringify(res)}`);
step(`病例 CT（${res.scanner.manufacturer} ${res.scanner.model}、${res.scanner.kvp} kVp）：${res.reason}`);

// 3. 新增 → 預覽 → 草稿
await clickEl(`${tab}.querySelector('button[data-action="ctcal-new"]')`);
await waitFor(`!!${tab}.querySelector('.ctcal-form')`, '新增表單', 5000);
await typeInto(`${tab}.querySelector('[data-field="ctcal-name"]')`, 'Phantom 120 kV');
await typeInto(`${tab}.querySelector('[data-field="ctcal-manufacturer"]')`, res.scanner.manufacturer);
await typeInto(`${tab}.querySelector('[data-field="ctcal-model"]')`, res.scanner.model);
await typeInto(`${tab}.querySelector('[data-field="ctcal-kvp"]')`, String(res.scanner.kvp));
await typeInto(`${tab}.querySelector('[data-field="ctcal-points"]')`, 'HU, density\n-1000, 0.001\n-800, 0.2\n0, 1.0\n1000, 1.6\n3000, 2.8');
await typeInto(`${tab}.querySelector('[data-field="ctcal-reference"]')`, 'test phantom');
await clickEl(`${tab}.querySelector('button[data-action="ctcal-preview"]')`);
await waitFor(`!!${tab}.querySelector('.ctcal-form .ctcal-plot path')`, '預覽曲線', 10000);
await clickEl(`${tab}.querySelector('button[data-action="ctcal-save"]')`);
await waitFor(`[...${tab}.querySelectorAll('.ctcal-list tbody tr')].some((tr) => tr.dataset.status === 'draft')`, '草稿', 10000);
rows = await rowsOf();
step(`新增草稿：${rows.find((r) => r.status === 'draft').text}`);

// 4. 啟用 → 對到；停用 → 退回
await waitFor(`!!${tab}.querySelector('button[data-action="ctcal-activate"]')`, '啟用按鈕', 10000);
await clickEl(`${tab}.querySelector('button[data-action="ctcal-activate"]')`);
await waitFor(`[...${tab}.querySelectorAll('.ctcal-list tbody tr')].some((tr) => tr.dataset.status === 'active')`, '啟用中', 10000);
res = await evaluate(`fetch('/api/v1/series/' + encodeURIComponent(${JSON.stringify(ct)}) + '/ct-calibration').then((r) => r.json())`);
if (res.fallback || res.calibration.name !== 'Phantom 120 kV') throw new Error(`啟用後應對到：${JSON.stringify(res)}`);
await shot('ctcal-active.png');
step(`啟用 → 病例 CT 改用「${res.calibration.name}」（${res.reason}）`);
await waitFor(`!!${tab}.querySelector('button[data-action="ctcal-retire"]')`, '停用按鈕', 10000);
await clickEl(`${tab}.querySelector('button[data-action="ctcal-retire"]')`);
await waitFor(`[...${tab}.querySelectorAll('.ctcal-list tbody tr')].some((tr) => tr.dataset.status === 'retired')`, '已停用', 10000);
res = await evaluate(`fetch('/api/v1/series/' + encodeURIComponent(${JSON.stringify(ct)}) + '/ct-calibration').then((r) => r.json())`);
if (!res.fallback) throw new Error(`停用後應退回內建：${JSON.stringify(res)}`);
step('停用 → 「已停用」、病例 CT 退回內建');

// 5. 拿內建當底：複製 → 草稿 → 編輯 → 設成預設 → 啟用
const rowSel = (status) => `[...${tab}.querySelectorAll('.ctcal-list tbody tr')].find((tr) => tr.dataset.status === ${JSON.stringify(status)})`;
await clickEl(rowSel('builtin'));
await waitFor(`${tab}.querySelector('.ctcal-detail')?.dataset.id === 'builtin-schneider2000'`, '選內建', 10000);
await clickEl(`${tab}.querySelector('button[data-action="ctcal-copy"]')`);
await waitFor(`${tab}.querySelector('.ctcal-form')?.dataset.mode === 'copy'`, '複製表單', 5000);
const seeded = await evaluate(`({ lines: ${tab}.querySelector('[data-field="ctcal-points"]').value.split('\\n').length, def: ${tab}.querySelector('[data-field="ctcal-default"]').checked, demo: ${tab}.querySelector('[data-field="ctcal-demo"]').checked, kvpDisabled: ${tab}.querySelector('[data-field="ctcal-kvp"]').disabled, name: ${tab}.querySelector('[data-field="ctcal-name"]').value })`);
if (seeded.lines !== 13 || !seeded.def || !seeded.demo || !seeded.kvpDisabled) throw new Error(`複製內建應帶 13 點、預設、示範用：${JSON.stringify(seeded)}`);
await clickEl(`${tab}.querySelector('button[data-action="ctcal-save"]')`);
await waitFor(`!!${rowSel('draft')}`, '複製出的草稿', 10000);
await waitFor(`!!${tab}.querySelector('button[data-action="ctcal-edit"]')`, '編輯按鈕', 10000);
await clickEl(`${tab}.querySelector('button[data-action="ctcal-edit"]')`);
await waitFor(`${tab}.querySelector('.ctcal-form')?.dataset.mode === 'edit'`, '編輯表單', 5000);
await setValue(`${tab}.querySelector('[data-field="ctcal-name"]')`, 'Schneider edited');
const edited = (await evaluate(`${tab}.querySelector('[data-field="ctcal-points"]').value`)).replace(/^22, 1\.03$/m, '22, 1.04');
await evaluate(`(() => { const el = ${tab}.querySelector('[data-field="ctcal-points"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(edited)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await clickEl(`${tab}.querySelector('button[data-action="ctcal-save"]')`);
await waitFor(`${tab}.querySelector('.ctcal-detail h3')?.textContent === 'Schneider edited'`, '改好的草稿', 10000);
const draftId = await evaluate(`${tab}.querySelector('.ctcal-detail').dataset.id`);
const saved = await evaluate(`fetch('/api/v1/ct-calibrations/' + encodeURIComponent(${JSON.stringify(draftId)})).then((r) => r.json())`);
if (!saved.point_table.some(([h, r]) => h === 22 && r === 1.04) || saved.derived_from !== 'builtin-schneider2000' || !saved.match.default) throw new Error(`草稿內容不對：${JSON.stringify(saved)}`);
step(`複製內建 → 草稿 → 編輯（名稱、22 HU 的密度）→ ${draftId}`);
await clickEl(`${tab}.querySelector('button[data-action="ctcal-activate"]')`);
await waitFor(`${rowSel('active')}?.dataset.id === ${JSON.stringify(draftId)}`, '預設曲線啟用', 10000);
res = await evaluate(`fetch('/api/v1/series/' + encodeURIComponent(${JSON.stringify(ct)}) + '/ct-calibration').then((r) => r.json())`);
if (res.fallback || res.calibration.calibration_id !== draftId || !res.calibration.demo) throw new Error(`沒對到的 CT 應改用預設曲線：${JSON.stringify(res)}`);
await shot('ctcal-default.png');
step(`啟用預設曲線 → 病例 CT 用「${res.calibration.name}」（${res.reason}；示範用）`);
await waitFor(`!!${tab}.querySelector('button[data-action="ctcal-retire"]')`, '停用按鈕', 10000);
await clickEl(`${tab}.querySelector('button[data-action="ctcal-retire"]')`);
await waitFor(`!${rowSel('active')}`, '預設曲線停用', 10000);
res = await evaluate(`fetch('/api/v1/series/' + encodeURIComponent(${JSON.stringify(ct)}) + '/ct-calibration').then((r) => r.json())`);
if (!res.fallback) throw new Error(`停用預設曲線後應退回內建：${JSON.stringify(res)}`);
step('停用預設曲線 → 病例 CT 退回內建');

// 6. 英文
await send('Page.navigate', { url: url.replace('/#/', '/?lang=en#/') });
await waitFor(`!!${tab}?.querySelector('.ctcal-list tbody tr')`, '英文模式');
await clickEl(`${tab}.querySelector('.ctcal-list tbody tr')`);
await waitFor(`!!${tab}.querySelector('.ctcal-detail .ctcal-plot path')`, '英文模式的圖');
await clickEl(`${tab}.querySelector('button[data-action="ctcal-new"]')`);
await waitFor(`!!${tab}.querySelector('.ctcal-form')`, '英文模式的表單', 5000);
await evaluate(`${tab}.querySelector('.ctcal-detail details').open = true; true`);
const enText = await evaluate(`[${tab}.innerText, ...[...${tab}.querySelectorAll('[title],[placeholder],[aria-label]')].map((e) => (e.title || '') + ' ' + (e.getAttribute('placeholder') || '') + ' ' + (e.getAttribute('aria-label') || ''))].join(' | ')`);
const cjk = enText.match(/[　-鿿＀-￯]+/g);
if (cjk) throw new Error(`英文模式還有中文：${cjk.join(' ')}`);
step('英文模式：CT 校正曲線分頁沒有中文');

if (errors.length) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
