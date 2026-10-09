/**
 * 驗證腳本共用的 headless Chrome ＋ CDP 骨架（零相依）。之前的 verify-*.mjs 每支各抄一份；
 * 行動裝置那幾支要觸控、觸控筆、裝置模擬，抽出來共用。
 *
 *   import { launch } from './lib/cdp.mjs';
 *   const b = await launch({ url, outDir });
 *   await b.device('tablet');            // 800×1280、觸控、(pointer: coarse)
 *   await b.touch.drag([[x0, y0], [x1, y1]]);
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEVICES = {
  // Android 手機（Pixel 7 一類）與平板（Galaxy Tab 一類）；只驗 Chrome
  phone: { width: 412, height: 915, mobile: true, touch: true },
  'phone-landscape': { width: 915, height: 412, mobile: true, touch: true },
  'phone-small': { width: 390, height: 844, mobile: true, touch: true },
  tablet: { width: 800, height: 1280, mobile: true, touch: true },
  'tablet-landscape': { width: 1280, height: 800, mobile: true, touch: true },
  desktop: { width: 1600, height: 1000, mobile: false, touch: false },
};

export function parseArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(
    argv.reduce((acc, a, i, arr) => {
      if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
      return acc;
    }, []),
  );
}

export async function launch({ url, outDir = null, port = 9360, chrome = process.env.CHROME ?? 'google-chrome', token = process.env.TOKEN ?? null } = {}) {
  const origin = new URL(url).origin;
  const profile = mkdtempSync(join(tmpdir(), 'rtgaia-cdp-'));
  // --password-store=basic：Cookie 不經系統金鑰圈（D-Bus secret service）加密 —— 金鑰圈卡住時 setCookie 與所有請求都會永遠不回
  //（2026-10-09：inotify 名額夠了以後還是卡，原因是這個；錄 demo 的 Chrome 一直有這個參數所以沒事）
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--password-store=basic', '--disable-gpu', '--hide-scrollbars', '--window-size=1600,1000', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
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
  // 等到真的有 `page` 目標：Chrome 剛起來時清單裡可能只有擴充功能的 background_page／service_worker，
  // 連到那裡 `Page.enable` 永遠不回（2026-10-09 探路腳本偶發卡住的原因）
  let page = null;
  for (let i = 0; i < 600 && page === null; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = targets.find((t) => t.type === 'page') ?? null;
    } catch {
      /* 還沒起來 */
    }
    if (page === null) await sleep(100);
  }
  if (page === null) throw new Error(`Chrome 60 秒內沒有起來：${chromeErr.trim() || '（stderr 沒有輸出）'}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let seq = 0;
  const pending = new Map();
  const errors = [];
  /** CDP 事件的訂閱（例：`Fetch.requestPaused` 用來故意延遲某些請求）。 */
  const listeners = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method !== undefined && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
    } else if (msg.method === 'Runtime.consoleAPICalled' && process.env.CDP_CONSOLE) {
      console.log('[page]', msg.params.args.map((a) => a.value ?? a.description).join(' '));
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
    await shot('cdp-failed.png').catch(() => undefined);
    throw new Error(`等不到：${what}`);
  };
  await send('Runtime.enable');
  await send('Page.enable');
  // 導覽不要自己跳出來（會蓋住要點的東西）；版面從 2×2 開始
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); if (!localStorage.getItem('rtgaia.layout.current.v1')) localStorage.setItem('rtgaia.layout.current.v1', '2x2'); } catch {}" });
  if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });

  /** 裝置模擬：尺寸、行動版、觸控（觸控開著時 `(pointer: coarse)` 成立）。 */
  const device = async (name) => {
    const d = DEVICES[name];
    if (!d) throw new Error(`不認識的裝置 ${name}`);
    await send('Emulation.setDeviceMetricsOverride', { width: d.width, height: d.height, deviceScaleFactor: 1, mobile: d.mobile });
    await send('Emulation.setTouchEmulationEnabled', { enabled: d.touch, maxTouchPoints: d.touch ? 5 : 1 });
    return d;
  };

  /** 觸控：`points` 是 [[x, y], …]（一隻手指的路徑）；`fingers` 是多隻手指各自的路徑（等長）。 */
  const touchEvent = (type, pts) => send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
  const touch = {
    /** 直接送一個觸控事件（`touchStart`／`touchMove`／`touchEnd`，`pts` ＝ 目前所有手指）—— 要在手勢中途檢查畫面時用。 */
    raw: (type, pts) => touchEvent(type, pts),
    tap: async (x, y) => {
      await touchEvent('touchStart', [[x, y]]);
      await sleep(40);
      await touchEvent('touchEnd', []);
      await sleep(120);
    },
    longPress: async (x, y, ms = 700) => {
      await touchEvent('touchStart', [[x, y]]);
      await sleep(ms);
      await touchEvent('touchEnd', []);
      await sleep(150);
    },
    /** 一指拖曳：先停 `hold` ms（工具模式要等 90 ms 才下筆），再逐點移動。 */
    drag: async (path, { hold = 150, step = 16 } = {}) => {
      await touchEvent('touchStart', [path[0]]);
      await sleep(hold);
      for (const p of path.slice(1)) {
        await touchEvent('touchMove', [p]);
        await sleep(step);
      }
      await touchEvent('touchEnd', []);
      await sleep(200);
    },
    /** 多指：`fingers[i]` 是第 i 隻手指的路徑；同時落下。 */
    multi: async (fingers, { step = 16 } = {}) => {
      await touchEvent('touchStart', fingers.map((f) => f[0]));
      const n = Math.max(...fingers.map((f) => f.length));
      for (let i = 1; i < n; i += 1) {
        await touchEvent('touchMove', fingers.map((f) => f[Math.min(i, f.length - 1)]));
        await sleep(step);
      }
      await touchEvent('touchEnd', []);
      await sleep(200);
    },
    /** 第一隻手指先落下、`lag` ms 後第二隻才到（真實的雙指常常這樣）。 */
    staggered: async (first, second, { lag = 40, step = 16 } = {}) => {
      await touchEvent('touchStart', [first[0]]);
      await sleep(lag);
      await touchEvent('touchStart', [first[0], second[0]]);
      const n = Math.max(first.length, second.length);
      for (let i = 1; i < n; i += 1) {
        await touchEvent('touchMove', [first[Math.min(i, first.length - 1)], second[Math.min(i, second.length - 1)]]);
        await sleep(step);
      }
      await touchEvent('touchEnd', []);
      await sleep(200);
    },
  };

  /** 觸控筆（CDP 的 mouse 事件帶 `pointerType: 'pen'`）。 */
  const pen = {
    drag: async (path) => {
      const [x0, y0] = path[0];
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
      for (const [x, y] of path.slice(1)) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, pointerType: 'pen', force: 0.5 });
        await sleep(16);
      }
      const [x1, y1] = path[path.length - 1];
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
      await sleep(200);
    },
  };

  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(250);
  };
  const centerOf = (expr) => evaluate(`(() => { const e = (${expr}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top }; })()`);
  const clickButton = (scope, text) => evaluate(`(() => { const b = [...(${scope}).querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && x.getBoundingClientRect().width > 0); if (!b) return false; b.click(); return true; })()`);

  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  return { send, evaluate, shot, waitFor, device, touch, pen, clickAt, centerOf, clickButton, errors, origin, on, close: () => proc.kill('SIGKILL') };
}

/** 檢查清單：每項 `check(name, ok, detail)`；最後 `report()` 印出並回傳失敗數。 */
export function checklist() {
  const results = [];
  return {
    check(name, ok, detail = '') {
      results.push({ name, ok: Boolean(ok), detail });
      console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  （${detail}）` : ''}`);
    },
    report() {
      const failed = results.filter((r) => !r.ok);
      console.log(failed.length === 0 ? `\n全部通過（${results.length} 項）` : `\n${failed.length} 項失敗：\n${failed.map((r) => `  ✗ ${r.name} ${r.detail}`).join('\n')}`);
      return failed.length;
    },
  };
}

/** 資料頁的列（樹表格）。 */
export const rowWith = (kind, text) => `[...document.querySelectorAll('.catalog-tree tr[data-kind="${kind}"]')].find((r) => r.textContent.includes(${JSON.stringify(text)}))`;

/**
 * 在桌面尺寸開 SYN4D-CT1 的 4D 組（有結構、劑量、時間軸）—— 跟 verify-ui-matrix 同一個病例。
 * 之後換裝置模擬、重新載入 `#/viewer`，會接著開同一個 session。
 */
export async function openSynth4d(b) {
  await b.device('desktop');
  await b.send('Page.navigate', { url: `${b.origin}/#/library` });
  await b.waitFor(`!!${rowWith('patient', 'SYN4D-CT1')}`, '資料頁有 SYN4D-CT1', 60000);
  await b.evaluate(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '清空')?.click(); true`);
  await b.evaluate(`${rowWith('patient', 'SYN4D-CT1')}.click(); true`);
  await b.waitFor(`!!${rowWith('study', 'synth4d')}`, 'SYN4D-CT1 的 study');
  await b.evaluate(`${rowWith('study', 'synth4d')}.click(); true`);
  await b.waitFor(`!!${rowWith('temporal', '4D · 10 個相位')}`, 'SYN4D-CT1 的 4D 組');
  await b.evaluate(`${rowWith('temporal', '4D · 10 個相位')}.querySelector('input[type=checkbox]').click(); true`);
  await b.waitFor(`document.querySelector('.selection-summary')?.textContent.includes('主要影像')`, '選取有主要影像', 20000);
  await b.evaluate(`[...document.querySelectorAll('button.primary')].find((x) => x.textContent.trim() === '開啟').click(); true`);
  await b.waitFor(`location.hash.includes('viewer') && document.querySelectorAll('.viewport-cell canvas').length >= 1`, '病例開起來', 180000);
  await b.waitFor(`!document.querySelector('.mask-loading')`, '結構載入完', 120000);
  await sleep(1500);
}
