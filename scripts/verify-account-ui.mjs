#!/usr/bin/env node
/**
 * 帳號管理的前端流程，用 headless Chrome ＋ CDP 走一次（與 `screenshot.mjs` 同一套骨架、零相依）：
 *
 *   1. 空資料庫 → bootstrap 一個 admin → `#/admin/users`
 *   2. CSV 批次建 `wang`（密碼空白）→ 畫面一次性列出臨時密碼
 *   3. 登出、用臨時密碼登入 → 強制改密碼對話框擋住、其他 API 403
 *   4. 在對話框改密碼 → 對話框消失、資料頁 API 200
 *
 * 需要**認證開啟**、**空的**資料庫的堆疊；`scripts/verify-account-ui.sh` 會建一個臨時 DB 起堆疊再跑這支。
 *
 *   node scripts/verify-account-ui.mjs --url http://127.0.0.1:5185/ [--out-dir DIR]
 *
 * 退出碼：任一步失敗 → 1。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);
const url = args.url ?? 'http://127.0.0.1:5185/';
const outDir = args['out-dir'] ?? null;
const port = Number(args.port ?? 9335);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-account-'));
const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--password-store=basic', '--disable-gpu', '--window-size=1400,900', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], {
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
const waitFor = async (expression, what, ms = 15000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return;
    } catch {
      /* 頁面還在換 */
    }
    await sleep(200);
  }
  const seen = await evaluate(`location.hash + ' | ' + document.body.innerText.slice(0, 300).replace(/\\s+/g, ' ')`).catch(() => '?');
  await shot('account-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}（畫面：${seen}）`);
};
const shot = async (name) => {
  if (!outDir) return;
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, name), Buffer.from(data, 'base64'));
};
// React 受控輸入：用原生 setter 再發 input 事件
const typeInto = (selector, value) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('找不到 ' + ${JSON.stringify(selector)});
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
const clickButton = (scope, text) =>
  evaluate(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
    if (!b) throw new Error('找不到按鈕 ' + ${JSON.stringify(text)});
    if (b.disabled) throw new Error('按鈕是灰的 ' + ${JSON.stringify(text)});
    b.click();
    return true;
  })()`);
const api = (method, path, body) =>
  evaluate(`fetch('/api/v1${path}', { method: '${method}', headers: { 'content-type': 'application/json' }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ''} }).then(async (r) => ({ status: r.status, body: await r.text() }))`);

// 只換 hash 不會重載 → App 還拿著換帳號前的身分（未登入時還會先被導到 #/login）；換身分後一律整頁載入
const go = async (hash) => {
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await send('Page.navigate', { url: `${url}${hash}` });
  await sleep(300);
  await waitFor(`document.readyState === 'complete'`, '頁面載入');
};
const step = (s) => console.log(`✓ ${s}`);
await send('Runtime.enable');
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); } catch {}" }); // 選擇器是中文字樣；介面預設英文
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await waitFor(`document.readyState === 'complete'`, '頁面載入');

const ADMIN_PW = 'verify-admin-Passw0rd';
const boot = await api('POST', '/auth/bootstrap', { username: 'root', password: ADMIN_PW });
if (boot.status !== 201) throw new Error(`bootstrap ${boot.status} ${boot.body}（資料庫要是空的）`);
step('bootstrap admin');

await go('#/admin/users');
await waitFor(`!!document.querySelector('.admin-users table.admin-table')`, '使用者表格');
await evaluate(`document.querySelector('.batch-users').open = true`);
await typeInto('.batch-users textarea', 'username,display_name,role,password\nwang,王醫師,contourer,\nbad,,contourer,short\n');
await clickButton('.batch-users', '建立');
await waitFor(`!!document.querySelector('.issued-passwords code')`, '臨時密碼');
const temp = await evaluate(`document.querySelector('.issued-passwords code').textContent`);
const batchErr = await evaluate(`[...document.querySelectorAll('.batch-users ul.error li')].map((li) => li.textContent).join(' | ')`);
if (!/^[A-Za-z0-9]{16}$/.test(temp)) throw new Error(`臨時密碼格式不對：${temp}`);
if (!batchErr.includes('第 3 行')) throw new Error(`批次錯誤沒列出第 3 行（標題是第 1 行）：${batchErr}`);
await waitFor(`[...document.querySelectorAll('.admin-users tbody tr')].some((tr) => tr.textContent.includes('wang') && tr.textContent.includes('待改密碼'))`, 'wang 列標「待改密碼」');
step(`批次建立：wang 臨時密碼顯示一次；錯誤列 → ${batchErr}`);
await shot('account-admin.png');

await api('POST', '/auth/logout');
const login = await api('POST', '/auth/login', { username: 'wang', password: temp });
if (login.status !== 200) throw new Error(`臨時密碼登入 ${login.status} ${login.body}`);
await go('#/library');
await waitFor(`!!document.querySelector('.change-password-dialog')`, '強制改密碼對話框');
if (await evaluate(`[...document.querySelectorAll('.change-password-dialog button')].some((b) => b.textContent.trim() === '取消')`)) throw new Error('強制模式不該有取消');
const blocked = await api('GET', '/library/patients?limit=1');
if (blocked.status !== 403 || !blocked.body.includes('PASSWORD_CHANGE_REQUIRED')) throw new Error(`改密碼前 API 應 403：${blocked.status} ${blocked.body}`);
step('臨時密碼登入 → 強制對話框、其他 API 403 PASSWORD_CHANGE_REQUIRED');
await shot('account-forced.png');

const NEW_PW = 'river-stone-Passw0rd-1'; // 不可含帳號（政策）
await typeInto('.change-password-dialog input[autocomplete="current-password"]', temp);
const inputs = '.change-password-dialog input[autocomplete="new-password"]';
await evaluate(`document.querySelectorAll('${inputs}')[0].setAttribute('data-v16', 'a'); document.querySelectorAll('${inputs}')[1].setAttribute('data-v16', 'b'); true`);
await typeInto('[data-v16="a"]', NEW_PW);
await typeInto('[data-v16="b"]', NEW_PW);
await clickButton('.change-password-dialog', '修改');
await waitFor(`!document.querySelector('.change-password-dialog')`, '對話框消失');
const ok = await api('GET', '/library/patients?limit=1');
if (ok.status !== 200) throw new Error(`改完密碼後 API 應 200：${ok.status} ${ok.body}`);
step('改密碼 → 對話框消失、API 200');
await shot('account-done.png');

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
