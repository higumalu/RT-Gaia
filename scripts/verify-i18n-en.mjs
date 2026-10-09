#!/usr/bin/env node
/**
 * 左下角讀數列出所在 ROI —— headless Chrome ＋ CDP 真的移動滑鼠（與 `screenshot.mjs` 同一套骨架、零相依）：
 *
 *   1. 開檢視器（要有病例）→ 結構「全顯示」→ 在軸向格掃點、挑 ROI 最多的一點→ 狀態列「ROI」列出色塊＋名稱，BODY 這類大的排最後、最多 5 個
 *   2. 移到軸向格左上角（空氣）→ 沒有 ROI
 *   3. 回到中心、把清單第一個 ROI 在結構清單關掉 → 它從狀態列消失（只列顯示中的）
 *   4. 滑鼠離開影像格 → 座標 N/A、ROI 清空
 *
 * 需要一個開著病例的堆疊，例如：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-i18n-en.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR]
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
const port = Number(args.port ?? 9338);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-i18n-'));
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
  await shot('i18n-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const allow = (args.allow ?? '').split(',').filter(Boolean);
const base = url.split('#')[0];
const pages = (args.pages ?? 'viewer').split(',');
const found = new Map();
/** DOM 裡的中文：文字節點與三種屬性；略過 DICOM 內容（結構名稱、病人列）所在的節點。 */
const collect = async (where) => {
  const hits = await evaluate(`(() => {
    const CJK = /[\\u3400-\\u9fff\\uff00-\\uffef\\u3000-\\u303f]/;
    const out = [];
    const skip = (el) => !!el.closest('.structure-name, .set-title, .case-summary, .patient, [data-dicom], .probe-roi, .dvh-legend, .measure-label, .rt-measure-label, [data-user-content]');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const v = n.nodeValue.trim();
      if (v && CJK.test(v) && n.parentElement && !skip(n.parentElement) && getComputedStyle(n.parentElement).display !== 'none') out.push(v.slice(0, 90));
    }
    for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]')) {
      if (skip(el)) continue;
      for (const a of ['title', 'placeholder', 'aria-label']) {
        const v = el.getAttribute(a);
        if (v && CJK.test(v)) out.push('@' + a + ': ' + v.slice(0, 90));
      }
    }
    return [...new Set(out)];
  })()`);
  for (const h of hits) if (!allow.some((a) => h.includes(a))) found.set(h, found.get(h) ?? where);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done') } catch {}" });
for (const pg of pages) {
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await send('Page.navigate', { url: `${base}${base.includes('?') ? '&' : '?'}lang=en#/${pg}` });
  if (pg === 'viewer') {
    await waitFor(`/Structures \\(\\d/.test(document.body.innerText) || /結構（\\d/.test(document.body.innerText)`, '病例載入（要先開一個病例）');
    await sleep(2500);
    await collect('viewer');
    const toggles = await evaluate(`[...document.querySelectorAll('.mode-toggle button')].map((b, i) => i)`);
    for (const i of toggles) {
      await evaluate(`document.querySelectorAll('.mode-toggle button')[${i}]?.click(); true`);
      await sleep(1200);
      const label = await evaluate(`document.querySelectorAll('.mode-toggle button')[${i}]?.textContent.trim() ?? ''`);
      await collect(`viewer + ${label}`);
      await evaluate(`document.querySelectorAll('.mode-toggle button')[${i}]?.click(); true`);
      await sleep(300);
    }
  } else {
    await sleep(3000);
    await collect(pg);
  }
}
if (outDir) await shot('i18n-en.png');
if (found.size > 0) {
  console.log(`還有中文（${found.size} 條）：`);
  for (const [text, where] of found) console.log(`  [${where}] ${text}`);
  process.exit(1);
}
console.log('英文模式下沒有中文');
process.exit(0);
