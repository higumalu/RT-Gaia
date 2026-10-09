#!/usr/bin/env node
/**
 * UI 驗收矩陣 —— headless Chrome ＋ CDP（骨架同 `verify-temporal-compose.mjs`、零相依）。
 * 把新功能的單點驗證擴充到穩定的典型場景 —— 視窗 × 語言 × 密度 × 200% 縮放，檢視器與資料頁各跑一次，
 * 每一格都量同一組**確定性**的版面斷言（不比對截圖）：
 *
 *   * 頁面不橫向溢出（表格、程式碼這類自己的捲動容器除外）
 *   * 標頭／任務列／時間軸列的按鈕都在視窗內
 *   * 讀數、時間軸文字沒有被截斷（scrollWidth ≤ clientWidth）
 *   * 檢視器：影像格合計 ≥ 視窗寬 40%、左欄 ≤ 45%；說明選單打得開而且整個在視窗內
 *   * 資料頁：study 列仍是表格列（不再被同名的 CSS class 蓋掉）、病人清單看得到
 *   * 密度只改尺寸：緊湊與舒適的任務列按鈕數一樣
 *
 * 另外加上觸控模擬的手機直式 390×844、橫式 844×390、平板 800×1280，**都算失敗**（以前 390 只報告）；
 * 手機的檢視器另外檢查：一格影像佔畫面高度一半以上、分頁列與方位切換在視窗內（手機沒有桌面工具列與說明選單）。
 * 觸控裝置只跑舒適密度（密度切換是桌面的；觸控裝置的尺寸由 `pointer: coarse` 決定）。
 * 角色（viewer／contourer／approver／admin）與「離線、保存失敗」各有自己的腳本（verify-save-recovery、verify-leave-guard、verify-push-fallback）。
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-ui-matrix.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR]
 * 退出碼：任一格有問題 → 1（全部格子跑完才列出來）。
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
const url = args.url ?? 'http://127.0.0.1:5183/#/library';
const outDir = args['out-dir'] ?? null;
const port = Number(args.port ?? 9351);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-ui-matrix-'));
const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--password-store=basic', '--disable-gpu', '--hide-scrollbars', '--window-size=1600,1000', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
// CI runner 上 Chrome 冷啟動偶爾超過 10 秒（2026-10-07 run 37562160122）→ 等 60 秒，起不來時印出 Chrome 自己的錯誤
let chromeErr = '';
proc.stderr.on('data', (d) => {
  chromeErr = (chromeErr + d).slice(-4000);
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
for (let i = 0; i < 600 && targets === null; i += 1) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    await sleep(100);
  }
}
if (targets === null) throw new Error(`Chrome 60 秒內沒有起來：${chromeErr.trim() || '（stderr 沒有輸出）'}`);
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
  await shot('ui-matrix-failed.png').catch(() => undefined);
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
const initScript = await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });

const rowWith = (kind, text) => `[...document.querySelectorAll('.catalog-tree tr[data-kind="${kind}"]')].find((r) => r.textContent.includes(${JSON.stringify(text)}))`;
const rowsWith = (kind, text) => `[...document.querySelectorAll('.catalog-tree tr[data-kind="${kind}"]')].filter((r) => r.textContent.includes(${JSON.stringify(text)}))`;
/** 資料頁：清空選取 → 展開病人 → 展開第一個描述含 `study` 的 study。 */
const openStudy = async (patientId, study, { reload = true } = {}) => {
  if (reload) await send('Page.navigate', { url: `${origin}/#/library` });
  else await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '資料庫…').click(); true`);
  await waitFor(`!!${rowWith('patient', patientId)}`, `資料頁有 ${patientId}`, 60000);
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '清空')?.click(); true`);
  await evaluate(`${rowWith('patient', patientId)}.click(); true`);
  await waitFor(`!!${rowWith('study', study)}`, `${patientId} 的 study「${study}」`);
  await evaluate(`${rowWith('study', study)}.click(); true`);
  await waitFor(`!!document.querySelector('.catalog-tree tr[data-kind="image"], .catalog-tree tr[data-kind="temporal"]')`, `${study} 的影像`);
  await sleep(500);
};
const summary = () => evaluate(`document.querySelector('.selection-summary')?.textContent.trim() ?? ''`);
const openCase = async (needTime = false) => {
  // 勾影像要先抓它的 RT 列才進選取（懶載入）→ 等摘要有主要影像再按開啟
  await waitFor(`document.querySelector('.selection-summary')?.textContent.includes('主要影像')`, '選取有主要影像', 20000);
  await evaluate(`[...document.querySelectorAll('button.primary')].find((b) => b.textContent.trim() === '開啟').click(); true`);
  await waitFor(`location.hash.includes('viewer') && document.querySelectorAll('.viewport-cell canvas').length >= 3${needTime ? " && !!document.querySelector('.time-group')" : ''}`, '病例開起來', 180000);
  await waitFor(`!document.querySelector('.mask-loading')`, '結構載入完', 120000);
  await sleep(1500);
};
const pageText = () => evaluate(`document.body.innerText`);
const structureCount = () => evaluate(`document.querySelectorAll('.structure-list li').length`);
/** 資料面板的「▸ 結構（…）」收合時清單不渲染 → 展開。 */
const expandStructures = () => evaluate(`(() => { const h = [...document.querySelectorAll('button, summary, span, div')].find((e) => e.children.length === 0 && /^▸ 結構（/.test(e.textContent.trim())); h?.click(); return !!h; })()`);


const rows = `[...document.querySelectorAll('.frame-group .image-row')]`;
const caseId = () => evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.caseId)`);
const studyId = () => evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.studyId)`);
/** 某一格 canvas 的指紋（取樣像素和）—— 比較兩張畫面是不是同一張。 */
const canvasSum = (label) => evaluate(`(() => { const c = ${cellSel(label)}?.querySelector('canvas'); const x = c?.getContext('2d'); if (!x) return -1; const d = x.getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 16) s += d[i]; return s; })()`);
const timeText = () => evaluate(`document.querySelector('.time-group .time-text')?.textContent.trim() ?? null`);
const clickButton = (scope, text) => evaluate(`(() => { const b = [...(${scope}).querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);


const CHECKS = `(() => {
  const issues = [];
  const W = innerWidth;
  const doc = document.documentElement;
  if (doc.scrollWidth > W + 1) issues.push('頁面橫向溢出 ' + doc.scrollWidth + ' > ' + W);
  for (const b of document.querySelectorAll('header button, .task-bar button, .time-group button, .library-header button, .phone-tabbar button, .phone-viewbar button, .phone-toolrow button')) {
    const r = b.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || b.checkVisibility?.() === false) continue;
    if (r.right > W + 1 || r.left < -1) issues.push('按鈕出界：' + (b.textContent || b.title).trim().slice(0, 24));
  }
  for (const sel of ['.time-group .time-text', '.probe-world', '.selection-summary']) {
    for (const e of document.querySelectorAll(sel)) {
      if (e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1) issues.push('被截斷：' + sel + '（' + e.scrollWidth + ' > ' + e.clientWidth + '）');
    }
  }
  const cells = [...document.querySelectorAll('.viewport-cell')].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0);
  if (location.hash.includes('viewer')) {
    if (cells.length === 0) issues.push('沒有影像格');
    else {
      const left = Math.min(...cells.map((r) => r.left));
      const right = Math.max(...cells.map((r) => r.right));
      if (right - left < 0.4 * W) issues.push('影像格只有 ' + Math.round(right - left) + ' px（< 40%）');
    }
    const side = document.querySelector('.sidebar-left');
    if (side && side.getBoundingClientRect().width > 0.45 * W) issues.push('左欄太寬 ' + Math.round(side.getBoundingClientRect().width));
    if (document.documentElement.dataset.form === 'phone') {
      const tall = Math.max(...cells.map((r) => r.height), 0);
      const minH = innerHeight > innerWidth ? 0.5 * innerHeight : 0.4 * innerHeight;
      if (tall < minH) issues.push('手機影像格只有 ' + Math.round(tall) + ' px 高');
      if (!document.querySelector('.phone-tabbar')) issues.push('手機沒有分頁列');
    }
  }
  if (location.hash.includes('library')) {
    const study = document.querySelector('.catalog-tree tr[data-kind="study"]');
    if (study && getComputedStyle(study).display !== 'table-row') issues.push('study 列不是表格列：' + getComputedStyle(study).display);
    const patient = document.querySelector('.catalog-tree tr[data-kind="patient"]');
    if (!patient || patient.getBoundingClientRect().height === 0) issues.push('看不到病人清單');
  }
  return issues;
})()`;

const SIZES = [
  { w: 1440, h: 900, dpr: 1, name: '1440×900' },
  { w: 1024, h: 768, dpr: 1, name: '1024×768' },
  { w: 720, h: 450, dpr: 2, name: '1440×900 縮放 200%' },
  // 觸控模擬（Android Chrome）
  { w: 390, h: 844, dpr: 1, touch: true, name: '手機 390×844' },
  { w: 844, h: 390, dpr: 1, touch: true, name: '手機橫拿 844×390' },
  { w: 800, h: 1280, dpr: 1, touch: true, name: '平板 800×1280' },
];
const LANGS = ['zh-TW', 'en'];
const DENSITIES = ['comfortable', 'compact'];
const results = [];
let n = 0;
const setup = async (size, lang, density, hash) => {
  await send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: size.dpr, mobile: size.touch === true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: size.touch === true, maxTouchPoints: size.touch ? 5 : 1 });
  await evaluate(`localStorage.setItem('rtgaia.lang', ${JSON.stringify(lang)}); localStorage.setItem('rtgaia.density', ${JSON.stringify(density)}); true`);
  n += 1;
  await send('Page.navigate', { url: `${origin}/?m=${n}${hash}` });
};

// 檢視器要有一個病例（SYN4D-CT1：有時間軸列、結構、劑量）
await openStudy('SYN4D-CT1', 'synth4d');
await waitFor(`!!${rowWith('temporal', '4D · 10 個相位')}`, 'SYN4D-CT1 的 4D 組');
await evaluate(`${rowWith('temporal', '4D · 10 個相位')}.querySelector('input[type=checkbox]').click(); true`);
await openCase(true);

// 開發環境用使用者帳號跑時：語言與密度會同步到帳號偏好 —— 先記下原本的，結束時改回去（重新載入一次讓它同步）
const original = await evaluate(`({ lang: localStorage.getItem('rtgaia.lang') ?? 'zh-TW', density: localStorage.getItem('rtgaia.density') ?? 'comfortable' })`);
const taskButtons = {};
for (const size of SIZES) {
  for (const lang of LANGS) {
    for (const density of size.touch ? ['comfortable'] : DENSITIES) {
      const label = `檢視器 ${size.name} ${lang} ${density}`;
      await setup(size, lang, density, '#/viewer');
      try {
        await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= (document.documentElement.dataset.form === 'phone' ? 1 : 3) && !!document.querySelector('.time-group')`, label, 120000);
        await sleep(1500);
        const phone = await evaluate(`document.documentElement.dataset.form === 'phone'`);
        // 讀數：指標放在軸向格中間（觸控：點一下）
        const c = await centerOf(`${cellSel(lang === 'en' ? 'Axial' : '軸向')} ?? document.querySelector('.viewport-cell')`);
        if (size.touch) {
          await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y, id: 0 }] });
          await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
        }
        await sleep(400);
        const issues = await evaluate(CHECKS);
        if (phone) {
          // 手機沒有說明選單：「更多」打得開、整個在視窗內、有說明手冊
          await evaluate(`document.querySelector('.phone-tabbar button[data-tab="more"]')?.click(); true`);
          await sleep(300);
          const more = await evaluate(`(() => { const m = document.querySelector('.phone-more'); if (!m || m.hidden) return 'none'; const r = m.getBoundingClientRect(); if (!(r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1)) return 'out ' + JSON.stringify([r.left, r.right, r.bottom]); return m.querySelector('.phone-help') ? 'ok' : 'no-help'; })()`);
          if (more !== 'ok') issues.push(`「更多」：${more}`);
          await evaluate(`document.querySelector('.phone-tabbar button[data-tab="more"]')?.click(); true`);
        } else {
          // 說明選單：打得開、整個在視窗內
          await evaluate(`document.querySelector('.help-toggle')?.click(); true`);
          await sleep(300);
          const menu = await evaluate(`(() => { const m = document.querySelector('.help-dropdown'); if (!m) return 'none'; const r = m.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 ? 'ok' : 'out ' + JSON.stringify([r.left, r.right, r.bottom]); })()`);
          if (menu !== 'ok') issues.push(`說明選單：${menu}`);
          await evaluate(`document.querySelector('.help-toggle')?.click(); true`);
        }
        const key = `${size.name} ${lang}`;
        const count = await evaluate(`document.querySelectorAll('.task-bar button').length`);
        taskButtons[key] ??= {};
        taskButtons[key][density] = count;
        if (density === 'compact' && taskButtons[key].comfortable !== undefined && taskButtons[key].comfortable !== count) issues.push(`密度改了按鈕數：舒適 ${taskButtons[key].comfortable}、緊湊 ${count}`);
        results.push({ label, issues });
        if (issues.length > 0) await shot(`matrix-${n}.png`);
      } catch (e) {
        results.push({ label, issues: [String(e.message ?? e)] });
      }
    }
  }
}
for (const size of SIZES) {
  for (const lang of LANGS) {
    const label = `資料頁 ${size.name} ${lang}`;
    await setup(size, lang, 'comfortable', '#/library');
    try {
      await waitFor(`!!document.querySelector('.catalog-tree tr[data-kind="patient"]')`, label, 60000);
      await evaluate(`${rowWith('patient', 'SYN4D-CT1')}?.click(); true`);
      await sleep(1500);
      const issues = await evaluate(CHECKS);
      // 「更多」選單：打開後整個在視窗內
      await evaluate(`(() => { const d = document.querySelector('.library-more'); if (d) d.open = true; return true; })()`);
      await sleep(300);
      const more = await evaluate(`(() => { const b = document.querySelector('.library-more-body'); if (!b) return 'none'; const r = b.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 ? 'ok' : 'out ' + JSON.stringify([Math.round(r.left), Math.round(r.right)]); })()`);
      if (more !== 'ok' && more !== 'none') issues.push(`「更多」選單：${more}`);
      await evaluate(`(() => { const d = document.querySelector('.library-more'); if (d) d.open = false; return true; })()`);
      results.push({ label, issues });
      if (issues.length > 0) await shot(`matrix-${n}.png`);
    } catch (e) {
      results.push({ label, issues: [String(e.message ?? e)] });
    }
  }
}
await setup({ w: 1600, h: 1000, dpr: 1 }, original.lang, original.density, '#/viewer');
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3`, '改回原本的語言與密度', 120000);
await sleep(2000);

const bad = results.filter((r) => r.issues.length > 0);
for (const r of results) console.log(`${r.issues.length === 0 ? '✓' : '✗'} ${r.label}${r.issues.length ? '：' + r.issues.join('；') : ''}`);
if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
if (bad.length > 0) throw new Error(`${bad.length}／${results.length} 格有問題`);
console.log(`全部通過（${results.length} 格）`);
process.exit(0);
