#!/usr/bin/env node
/**
 * 資料面板 FrameGroup 標題列（套用 rigid 的 CT 名稱曾被擋住，只剩「C…」）—— headless Chrome ＋ CDP。
 *
 * 對位徽章（`RIGID · Δ(…) mm`）、「套用對位」、「只看」以前跟標題擠同一列，標題 `flex: 1; min-width: 0` 被壓到剩一個字。
 * 現在第一列只有收合鈕、標題、「只看」，徽章與「套用對位」放第二列。這支確認：
 *   1. 每一組（含 secondary、有對位徽章的）標題拿到第一列扣掉兩顆按鈕的全部寬度，第二列在標題下面、徽章與「套用對位」同一列
 *   2. 標題滑過有完整名稱（`title` 屬性）
 *
 * 需要一個開著病例、而且有 secondary 影像組（最好有剛體對位）的堆疊，例如：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-data-panel-header.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR] [--token <rtgaia_session>]
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
const url = args.url ?? 'http://127.0.0.1:5183/#/viewer';
const outDir = args['out-dir'] ?? null;
const port = Number(args.port ?? 9337);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-fghead-'));
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
  await shot('fghead-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.sidebar.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.frame-group-header').length >= 2`, '病例載入、至少兩個影像組（要先開一個有 secondary 的病例）');
await sleep(1500);

const rows = await evaluate(`[...document.querySelectorAll('.frame-group')].map((sec) => {
  const h = sec.querySelector('.frame-group-header');
  const title = h.querySelector('.frame-group-title');
  const collapse = h.querySelector('.collapse');
  const solo = h.querySelector('.solo');
  const apply = h.querySelector('.apply-reg');
  const badgeEl = h.querySelector('.badge');
  const actions = h.querySelector('.frame-group-actions');
  const cs = getComputedStyle(h);
  const inner = h.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const gap = parseFloat(cs.columnGap) || 0;
  return {
    role: sec.dataset.role,
    text: title.textContent.trim(),
    tip: title.getAttribute('title') ?? '',
    titleW: title.getBoundingClientRect().width,
    expectW: inner - collapse.getBoundingClientRect().width - solo.getBoundingClientRect().width - 2 * gap,
    soloTop: solo.getBoundingClientRect().top,
    titleTop: title.getBoundingClientRect().top,
    oneRow: !apply || Math.abs(apply.getBoundingClientRect().top + apply.getBoundingClientRect().height / 2 - (badgeEl.getBoundingClientRect().top + badgeEl.getBoundingClientRect().height / 2)) < 4,
    titleBottom: title.getBoundingClientRect().bottom,
    actionsTop: actions ? actions.getBoundingClientRect().top : null,
    badge: h.querySelector('.badge')?.textContent.trim() ?? '',
    applyReg: !!h.querySelector('.apply-reg'),
  };
})`);
await shot('fghead.png');
for (const r of rows) {
  if (r.actionsTop === null) throw new Error(`${r.text}：沒有第二列（.frame-group-actions）`);
  if (r.titleW < r.expectW - 2) throw new Error(`${r.text}（${r.role}，${r.badge}）：標題只有 ${r.titleW.toFixed(0)} px，應佔滿第一列 ${r.expectW.toFixed(0)} px`);
  if (r.actionsTop < r.titleBottom - 1) throw new Error(`${r.text}：徽章／套用對位沒有在標題下面`);
  if (r.soloTop > r.titleBottom) throw new Error(`${r.text}：「只看」應在第一列標題右邊`);
  if (!r.oneRow) throw new Error(`${r.text}：徽章與「套用對位」應在同一列`);
  if (!r.tip || !r.tip.startsWith(r.text.split(' ')[0])) throw new Error(`${r.text}：標題滑過應有完整名稱，實際「${r.tip}」`);
}
const withReg = rows.filter((r) => r.applyReg);
step(`${rows.length} 組標題都佔滿第一列（${rows.map((r) => `${r.role} ${r.titleW.toFixed(0)}px`).join('、')}），「只看」在標題右邊、徽章與套用對位在第二列、滑過有完整名稱`);
if (withReg.length === 0) console.log('（這個病例沒有帶「套用對位」的組 —— 最初回報的情況沒涵蓋到）');
else step(`有對位的組：${withReg.map((r) => `${r.text.slice(0, 24)}… ／ ${r.badge}`).join('；')}`);

// 截圖給人看：把 primary 收起來，secondary 的標題列才在畫面內（收合狀態不影響判定，上面已經量完）
await evaluate(`document.querySelector('.frame-group[data-role="primary"] .frame-group-header .collapse')?.click(); true`);
await sleep(600);
await shot('fghead-secondary.png');
await evaluate(`document.querySelector('.frame-group[data-role="primary"] .frame-group-header .collapse')?.click(); true`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
