#!/usr/bin/env node
/**
 * 點擊目標：用 headless Chrome ＋ CDP 量頁面上所有可互動元素的尺寸，列出 < 24×24 CSS px 的
 * （WCAG 2.2 2.5.8 最低值）。與 `screenshot.mjs` 同一套 CDP 骨架、零相依。
 *
 *   node scripts/verify-target-size.mjs --url http://127.0.0.1:5173/ [--wait-ms 15000] [--until "JS"] [--min 24] [--allow "selector,selector"]
 *
 * 退出碼：有未解釋的小目標 → 1。`--allow` 給例外（WCAG 的間距／行內／使用者代理例外要人判，這裡只列，不宣判）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);
const url = args.url ?? 'http://127.0.0.1:5173/';
const waitMs = Number(args['wait-ms'] ?? 15000);
const min = Number(args.min ?? 24);
const allow = (args.allow ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const port = Number(args.port ?? 9334);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const width = Number(args.width ?? 1366);
const height = Number(args.height ?? 768);

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-target-'));
const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--password-store=basic', '--disable-gpu', `--window-size=${width},${height}`, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 100 && targets === null; i += 1) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(100); }
}
if (targets === null) throw new Error('Chrome 沒有起來');
const page = targets.find((t) => t.type === 'page') ?? targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); } catch {}" }); // 選擇器是中文字樣；介面預設英文
await send('Runtime.enable');
await send('Page.navigate', { url });
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
const deadline = Date.now() + waitMs;
if (args.until) { while (Date.now() < deadline && !(await evalJs(args.until))) await sleep(200); } else await sleep(Math.min(waitMs, 4000));

const report = await evalJs(`(() => {
  const sel = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=menuitem], [role=menuitemcheckbox], [role=tab], summary';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const short = (el.textContent || el.getAttribute('title') || el.getAttribute('aria-label') || '').trim().slice(0, 24);
    const ua = el.matches('input[type=checkbox], input[type=radio], input[type=range]') && !el.className;  // 未改樣式的 UA 控制項：2.5.8 例外
    out.push({ tag: el.tagName.toLowerCase(), cls: el.className && typeof el.className === 'string' ? el.className.split(' ').slice(0, 3).join('.') : '', text: short, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, ua });
  }
  return out;
})()`);
const small = (report ?? []).filter((e) => e.w < min || e.h < min);
const allowed = small.filter((e) => e.ua || allow.some((a) => e.cls.includes(a.replace(/^\./, ''))));
const bad = small.filter((e) => !allowed.includes(e));
console.log(`量到 ${report?.length ?? 0} 個互動元素（${width}×${height}）；< ${min}px 的 ${small.length} 個，其中例外 ${allowed.length} 個`);
for (const e of bad) console.log(`  ❌ ${e.tag}${e.cls ? '.' + e.cls : ''} ${e.w}×${e.h} 「${e.text}」`);
for (const e of allowed) console.log(`  ⚪ ${e.tag}${e.cls ? '.' + e.cls : ''} ${e.w}×${e.h} 「${e.text}」（${e.ua ? 'UA 預設控制項' : '允許'}）`);
ws.close();
process.exit(bad.length ? 1 : 0);
