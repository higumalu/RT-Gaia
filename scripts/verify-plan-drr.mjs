#!/usr/bin/env node
/**
 * DRR ＋ 結構投影 —— headless Chrome ＋ CDP（骨架同 `verify-plan-panel.mjs`、零相依）：
 *
 *   BEV 的 DRR 預設開（「DRR @ CP n」）；關掉 → BEV 畫面跟開著時不一樣
 *   換對比（高對比 → 原始）→ 畫面又變
 *   投影輪廓：同一個請求帶顯示中的結構 → 回來的輪廓 > 0 條
 *   拖到 CP 91 → 重新算（「DRR @ CP 91」）
 *   英文模式沒有中文
 *
 * 需要一個開著量測病例（`.rtgaia/perf/case.json`，要有 RTPLAN 與劑量）的堆疊：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-plan-drr.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR]
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
const port = Number(args.port ?? 9345);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-plan23d-'));
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
  await shot('plan23d-failed.png').catch(() => undefined);
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
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.plan-toggle button')`, '病例載入（要有 RTPLAN → 工具列「計畫」）');
await waitFor(`!document.querySelector('.mask-loading')`, '載入完', 60000);
await sleep(1200);
const setValue = (selector, value, kind = 'input') =>
  evaluate(`(() => { const el = ${selector}; const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))}); el.dispatchEvent(new Event(${JSON.stringify(kind)}, { bubbles: true })); return true; })()`);
const clickEl = async (expr) => {
  await evaluate(`(${expr}).scrollIntoView({ block: 'center' }); true`);
  const c = await centerOf(expr);
  await clickAt(c.x, c.y);
};
const bev = `document.querySelector('.plan-bev-embedded .bev-view')`;
const readout = () => evaluate(`${bev}.querySelector('.bev-readout')?.textContent ?? ''`);
const cpOf = (text) => Number((text.match(/CP (\d+) \//) ?? [])[1]);
const canvasShot = async () => {
  await evaluate(`${bev}.querySelector('.bev-canvas').scrollIntoView({ block: 'center' }); true`);
  await sleep(200);
  const r = await evaluate(`(() => { const b = ${bev}.querySelector('.bev-canvas').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
  return (await send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } })).data;
};
const drrBox = `[...${bev}.querySelectorAll('.bev-drr-row label')].find((l) => l.textContent.trim().startsWith('DRR')).querySelector('input')`;
const note = () => evaluate(`${bev}.querySelector('.bev-drr-note')?.textContent ?? ''`);

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.plan-toggle button')`, '病例載入（要有 RTPLAN）');
await waitFor(`!document.querySelector('.mask-loading')`, '載入完', 60000);
await clickEl(`document.querySelector('.plan-toggle button')`);
await waitFor(`/CP 1 \\/ 180/.test(${bev}?.querySelector('.bev-readout')?.textContent ?? '')`, 'BEV', 30000);
await setValue(`${bev}.querySelector('.bev-slider')`, 45);
await sleep(600);

// 1. DRR 預設開（CT 的射束視角當背景）；關掉 → 畫面變；再打開
await waitFor(`/CP 46/.test(${bev}.querySelector('.bev-drr-note')?.textContent ?? '')`, 'DRR 預設開：DRR @ CP 46', 60000);
if (!(await evaluate(`${drrBox}.checked`))) throw new Error('DRR 應該預設開');
await sleep(500);
const on = await canvasShot();
await shot('plan23d-drr.png');
await clickEl(drrBox);
await sleep(500);
const off = await canvasShot();
if (on === off) throw new Error('關掉 DRR 後 BEV 畫面沒變');
await clickEl(drrBox);
await waitFor(`!!${bev}.querySelector('.bev-drr-note')`, 'DRR 再打開', 30000);
await sleep(500);
step(`DRR 預設開：${await note()}；關掉畫面有變`);

// 2. 換對比
await setValue(`[...${bev}.querySelectorAll('.bev-drr-row select')][0]`, 'raw', 'change');
await sleep(2500);
const raw = await canvasShot();
if (raw === on) throw new Error('換成「原始」對比後畫面沒變');
step('高對比 → 原始：畫面有變');

// 3. 投影輪廓：同一個請求、帶顯示中的結構
const sid = await evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.studyId)`);
const plans = await evaluate(`fetch('/api/v1/studies/' + encodeURIComponent(${JSON.stringify(sid)}) + '/plans').then((r) => r.json())`);
const visible = await evaluate(`fetch('/api/v1/studies/' + encodeURIComponent(${JSON.stringify(sid)}) + '/structures').then((r) => r.json()).then((l) => (Array.isArray(l) ? l : l.structures ?? []).filter((s) => s.default_visible).map((s) => s.structure_id).slice(0, 6))`);
const resp = await evaluate(`fetch('/api/v1/studies/' + encodeURIComponent(${JSON.stringify(sid)}) + '/plans/' + encodeURIComponent(${JSON.stringify(plans.plans[0].plan_id)}) + '/beams/2/drr?cp=45&size=128&half=150&structure_ids=' + encodeURIComponent(${JSON.stringify(visible.join(','))})).then((r) => r.json())`);
const withLines = resp.contours.filter((c) => c.polylines.length > 0);
if (visible.length === 0 || withLines.length === 0) throw new Error(`投影輪廓：結構 ${visible.length} 個、有輪廓的 ${withLines.length} 個`);
step(`投影輪廓：${withLines.length}／${resp.contours.length} 個結構有輪廓（${withLines.map((c) => c.name).join(', ')}）`);

// 4. 換 CP → 重新算
await setValue(`${bev}.querySelector('.bev-slider')`, 90);
await waitFor(`/CP 91/.test(${bev}.querySelector('.bev-drr-note')?.textContent ?? '')`, 'DRR @ CP 91', 60000);
step(`拖到 CP 91 → ${await note()}`);

// 4b. 播放中 DRR 也跟著（小張、一次一個請求）
await setValue(`${bev}.querySelector('.bev-timeline select')`, 5, 'change');
await clickEl(`${bev}.querySelector('.bev-play')`);
const before = await note();
await waitFor(`(${bev}.querySelector('.bev-drr-note')?.textContent ?? '') !== ${JSON.stringify(before)}`, '播放中 DRR 跟著換', 20000);
await clickEl(`${bev}.querySelector('.bev-play')`);
step(`播放中 DRR 跟著換：${before} → ${await note()}`);

// 5. 英文模式
await send('Page.navigate', { url: url.replace('/#/', '/?lang=en#/') });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.plan-toggle button')`, '英文模式載入');
if (!(await evaluate(`!!document.querySelector('.plan-panel')`))) await evaluate(`document.querySelector('.plan-toggle button').click(); true`);
await waitFor(`!!${bev}?.querySelector('.bev-drr-row')`, '英文模式的 BEV', 30000);
await waitFor(`!!${bev}.querySelector('.bev-drr-note')`, '英文模式的 DRR', 60000);
const enText = await evaluate(`[${bev}.querySelector('.bev-drr-row').innerText, ...[...${bev}.querySelectorAll('.bev-drr-row [title], .bev-drr-row [aria-label]')].map((e) => (e.title || '') + ' ' + (e.getAttribute('aria-label') || ''))].join(' | ')`);
const cjk = enText.match(/[　-鿿＀-￯]+/g);
if (cjk) throw new Error(`英文模式還有中文：${cjk.join(' ')}`);
step('英文模式：DRR 控制列沒有中文');

if (errors.length) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
