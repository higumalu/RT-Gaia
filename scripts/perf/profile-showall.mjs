#!/usr/bin/env node
/**
 * 全隱藏 → 全顯示 期間的 CPU profile（CDP `Profiler`），印 self time 前 N 名的函式。
 * 用法：node scripts/perf/profile-showall.mjs [--url http://127.0.0.1:5183/#/viewer] [--top 30] [--action showall|scroll]
 * 先 `scripts/perf/stack.sh start && scripts/perf/stack.sh load`。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => { if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]); return acc; }, []));
const url = args.url ?? 'http://127.0.0.1:5183/#/viewer';
const top = Number(args.top ?? 30);
const action = args.action ?? 'showall';
const port = 9334;
const proc = spawn(args.chrome ?? process.env.CHROME ?? 'google-chrome', ['--headless=new', '--no-sandbox', '--password-store=basic', '--disable-gpu', '--window-size=1600,1000', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'rtgaia-prof-'))}`, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { proc.kill('SIGKILL'); } catch {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 100 && targets === null; i += 1) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(100); } }
const page = targets.find((t) => t.type === 'page') ?? targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
const until = async (expr, ms) => { const d = Date.now() + ms; while (Date.now() < d) { try { if (await evaluate(expr)) return true; } catch {} await sleep(250); } return false; };

await send('Runtime.enable'); await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); } catch {}" }); // 選擇器是中文字樣；介面預設英文
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
const BTN = `(t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t)`;
if (!(await until(`(${BTN})('全顯示') && document.querySelectorAll('.structure-list li:not(.structure-set)').length >= 20`, 60000))) throw new Error('清單沒出來');
await sleep(4000);
await evaluate(`(${BTN})('全隱藏').click()`); await sleep(8000);
if (action === 'showall') {
  await evaluate(`(${BTN})('全顯示').click()`); await sleep(15000); // 抓 mask → 全部 render
  await evaluate(`(${BTN})('全隱藏').click()`); await sleep(6000);
}
await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 200 });
await send('Profiler.start');
const t0 = Date.now();
if (action === 'showall') { await evaluate(`performance.setResourceTimingBufferSize(20000); (${BTN})('全顯示').click()`); await sleep(12000); }
else if (action === 'scroll') { // 全顯示後在軸向格捲 20 格
  await evaluate(`(${BTN})('全顯示').click()`); await sleep(15000); await send('Profiler.stop'); await send('Profiler.start');
  await evaluate(`(() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect(); let i = 0; const f = () => { c.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2, deltaY: 100, deltaMode: 0 })); if (++i < 20) setTimeout(f, 60); }; f(); })()`);
  await sleep(6000);
}
const { profile } = await send('Profiler.stop');
const wall = Date.now() - t0;
// 彙整 self time：samples 對應 node id；timeDeltas 是取樣間隔
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
for (let i = 0; i < profile.samples.length; i += 1) {
  const n = byId.get(profile.samples[i]); const dt = (profile.timeDeltas[i] ?? 0) / 1000;
  const cf = n.callFrame; const key = `${cf.functionName || '(anonymous)'}  ${cf.url.split('/').slice(-2).join('/')}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + dt);
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
console.log(`profile ${action}: wall ${wall} ms, sampled ${Math.round(total)} ms (含 idle)`);
for (const [k, v] of rows) console.log(`${String(Math.round(v)).padStart(6)} ms  ${k}`);
ws.close(); proc.kill('SIGKILL'); process.exit(0);
