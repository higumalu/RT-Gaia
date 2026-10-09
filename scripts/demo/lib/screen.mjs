/**
 * Demo 影片錄製的底層：Xvfb 虛擬螢幕 ＋ 有畫面的 Chrome（kiosk）＋ xdotool 真的滑鼠／鍵盤 ＋ ffmpeg x11grab。
 * 跟 verify-*.mjs 的 headless ＋ CDP 不同：這裡要錄到真的游標與動畫，所以輸入走 X（xdotool），CDP 只用來查元素位置與等狀態。
 *
 *   const s = await openScreen({ url, token });          // Xvfb :99、Chrome kiosk 1920×1080
 *   await s.moveTo(x, y); await s.click(); await s.type('Pancreas');
 *   const rec = s.record('out.mp4'); … rec.cue('Open a case'); … await rec.stop();
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SIGTERM：Xvfb 收到才會清掉 /tmp/.X99-lock（SIGKILL 會留下鎖檔，下次起不來）
const kill = (p) => {
  try {
    p.kill('SIGTERM');
  } catch {
    /* 已經結束 */
  }
};

/** 上次沒收好留下的鎖檔（行程已經不在）就刪掉；真的有人在用這個 display 就報錯。 */
function clearStaleDisplay(display) {
  const n = display.replace(/^:/, '');
  const lock = `/tmp/.X${n}-lock`;
  if (!existsSync(lock)) return;
  const pid = Number(readFileSync(lock, 'utf8').trim());
  try {
    process.kill(pid, 0);
    throw new Error(`display ${display} 已經有 X server 在用（pid ${pid}）；換一個 display 或先關掉它`);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
  rmSync(lock, { force: true });
  rmSync(`/tmp/.X11-unix/X${n}`, { force: true });
}

export async function openScreen({ url, token = null, width = 1920, height = 1080, scale = 1.25, display = ':99', port = 9377, chrome = process.env.CHROME ?? 'google-chrome', chromeArgs = [], localStorage = {}, emulate = null }) {
  const children = [];
  // 訊號也要收：Node 收到 SIGTERM／SIGINT 預設直接結束、不跑 'exit'，Xvfb 與 Chrome 會變孤兒
  process.on('exit', () => children.forEach(kill));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      children.forEach(kill);
      process.exit(128 + (sig === 'SIGINT' ? 2 : sig === 'SIGTERM' ? 15 : 1));
    });
  }
  // ── 虛擬螢幕 ──
  clearStaleDisplay(display);
  const xvfb = spawn('Xvfb', [display, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' });
  children.push(xvfb);
  await sleep(800);
  const env = { ...process.env, DISPLAY: display };
  // ── Chrome（有畫面、kiosk、沒有任何瀏覽器外框）──
  const profile = mkdtempSync(join(tmpdir(), 'rtgaia-demo-chrome-'));
  process.on('exit', () => {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Chrome 還在收尾；留在 /tmp 也無妨 */
    }
  });
  const proc = spawn(
    chrome,
    [
      '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-infobars', '--disable-translate',
      '--disable-features=Translate,MediaRouter', '--hide-crash-restore-bubble', '--password-store=basic',
      `--force-device-scale-factor=${scale}`, `--window-size=${Math.round(width / scale)},${Math.round(height / scale)}`, '--window-position=0,0', '--kiosk',
      '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...chromeArgs, 'about:blank',
    ],
    { env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  children.push(proc);
  let chromeErr = '';
  proc.stderr.on('data', (d) => {
    chromeErr = (chromeErr + d).slice(-4000);
  });
  // 等到真的有 `page` 目標（剛起來時可能只有擴充功能的 background_page，連過去 Page.enable 永遠不回）
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
  if (page === null) throw new Error(`Chrome 沒有起來：${chromeErr.trim()}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let seq = 0;
  const pending = new Map();
  const errors = [];
  const dialogs = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      // 原生 confirm／alert 會卡住頁面的 JS（evaluate 永遠不回）：記下來、按確定，錄完再看是哪一句
      dialogs.push(msg.params.message);
      console.warn(`[dialog] ${msg.params.type}：${msg.params.message}`);
      void send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined);
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
  const waitFor = async (expression, what, ms = 60000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return;
      } catch {
        /* 頁面還在換 */
      }
      await sleep(200);
    }
    throw new Error(`等不到：${what}`);
  };
  await send('Runtime.enable');
  await send('Page.enable');
  const seedStorage = { 'rtgaia.tour.v1': 'done', 'rtgaia.lang': 'en', ...localStorage };
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { ${Object.entries(seedStorage).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(' ')} } catch {}`,
  });
  // 手機：裝置模擬（CSS 尺寸、DPR、觸控；滑鼠事件轉成觸控 —— 一指拖曳換切片那些手勢才走得到）
  if (emulate) {
    await send('Emulation.setDeviceMetricsOverride', { width: emulate.width, height: emulate.height, deviceScaleFactor: emulate.deviceScaleFactor ?? 1, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  }
  const origin = new URL(url).origin;
  if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
  await send('Page.navigate', { url });

  // ── 輸入：xdotool（真的 X 事件，游標會被錄進去）──
  const xdo = (...args) => execFileSync('xdotool', args.map(String), { env });
  let pos = { x: width / 2, y: height / 2 };
  xdo('mousemove', pos.x, pos.y);
  /** 平滑移動（ease-in-out），時間依距離 250–700 ms。 */
  const moveTo = async (x, y, ms = null) => {
    const dist = Math.hypot(x - pos.x, y - pos.y);
    const dur = ms ?? Math.min(700, Math.max(250, dist * 0.6));
    const steps = Math.max(2, Math.round(dur / 16));
    const from = { ...pos };
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      xdo('mousemove', Math.round(from.x + (x - from.x) * e), Math.round(from.y + (y - from.y) * e));
      await sleep(dur / steps);
    }
    pos = { x, y };
  };
  const click = async ({ button = 1, double = false } = {}) => {
    xdo('click', ...(double ? ['--repeat', 2, '--delay', 90] : []), button);
    await sleep(150);
  };
  /** 按住拖曳（`path` 是 [[x, y], …]，第一點按下）。 */
  const drag = async (path, { button = 1, stepMs = 16 } = {}) => {
    await moveTo(path[0][0], path[0][1]);
    xdo('mousedown', button);
    await sleep(80);
    for (const [x, y] of path.slice(1)) {
      xdo('mousemove', Math.round(x), Math.round(y));
      pos = { x, y };
      await sleep(stepMs);
    }
    xdo('mouseup', button);
    await sleep(150);
  };
  /** 滾輪：正數往下（下一張切片）。 */
  const wheel = async (n, { delay = 70 } = {}) => {
    for (let i = 0; i < Math.abs(n); i += 1) {
      xdo('click', n > 0 ? 5 : 4);
      await sleep(delay);
    }
  };
  const type = async (text, { delay = 70 } = {}) => {
    xdo('type', '--delay', delay, text);
    await sleep(100);
  };
  const key = async (...keys) => {
    xdo('key', ...keys);
    await sleep(120);
  };

  /** 元素位置換成螢幕 px（kiosk、視窗在 0,0；CSS px × 縮放）。`expr` 是回傳 Element 的 JS 運算式。 */
  const box = async (expr) => {
    const r = await evaluate(`(() => { const e = (${expr}); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; })()`);
    if (!r) return null;
    const k = emulate ? (emulate.deviceScaleFactor ?? 1) : scale;
    return { x: (r.left + r.w / 2) * k, y: (r.top + r.h / 2) * k, w: r.w * k, h: r.h * k, left: r.left * k, top: r.top * k, right: (r.left + r.w) * k, bottom: (r.top + r.h) * k };
  };
  const clickOn = async (expr, what = expr, opts = {}) => {
    await waitFor(`(() => { const e = (${expr}); return !!e && e.getBoundingClientRect().width > 0; })()`, what, opts.timeout ?? 30000);
    // 在可捲動的面板裡、被面板切掉（不只是超出視窗）→ 先平滑捲到中間（錄得到捲動，像人在操作）
    const scrolled = await evaluate(`(() => {
      const e = (${expr});
      const r = e.getBoundingClientRect();
      let top = 0, bottom = innerHeight;
      for (let p = e.parentElement; p; p = p.parentElement) {
        const st = getComputedStyle(p);
        if (/(auto|scroll|hidden)/.test(st.overflowY) && p.scrollHeight > p.clientHeight) {
          const pr = p.getBoundingClientRect();
          top = Math.max(top, pr.top);
          bottom = Math.min(bottom, pr.bottom);
        }
      }
      if (r.top >= top && r.bottom <= bottom) return false;
      e.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    })()`);
    if (scrolled) await sleep(700);
    const b = await box(expr);
    await moveTo(b.x + (opts.dx ?? 0), b.y + (opts.dy ?? 0));
    await sleep(opts.hover ?? 200);
    await click(opts);
  };
  /** 依按鈕文字找（只找看得見的）。 */
  const button = (text, scope = 'document') =>
    `[...(${scope}).querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && x.getBoundingClientRect().width > 0)`;

  /** ffmpeg x11grab 錄整個螢幕；`cue(text)` 記字幕時間點（相對錄影開始）。 */
  const record = (file, { fps = 30 } = {}) => {
    const ff = spawn(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-framerate', String(fps), '-video_size', `${width}x${height}`, '-i', `${display}.0`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14', '-pix_fmt', 'yuv444p', file],
      { env, stdio: ['pipe', 'ignore', 'pipe'] },
    );
    children.push(ff);
    let ffErr = '';
    ff.stderr.on('data', (d) => {
      ffErr = (ffErr + d).slice(-4000);
    });
    const t0 = Date.now();
    const cues = [];
    return {
      now: () => (Date.now() - t0) / 1000,
      /** 開一段字幕（上一段自動結束）。`null` ＝ 只結束上一段。 */
      cue(text) {
        const t = (Date.now() - t0) / 1000;
        // 上一段「字幕」（中間可能夾著 mark）
        const last = [...cues].reverse().find((c) => c.text !== undefined);
        if (last && last.end === null) last.end = t;
        if (text !== null) cues.push({ start: t, end: null, text });
      },
      /** 標一個片段（短片剪輯用）。 */
      mark(name, edge) {
        cues.push({ mark: name, edge, t: (Date.now() - t0) / 1000 });
      },
      async stop(cueFile) {
        this.cue(null);
        ff.stdin.write('q');
        await new Promise((resolve) => ff.on('close', resolve));
        if (ffErr.trim()) console.error('[ffmpeg]', ffErr.trim());
        if (cueFile) writeFileSync(cueFile, JSON.stringify(cues, null, 2));
        return cues;
      },
    };
  };

  /** 從 X 螢幕抓一張（跟錄影看到的一樣；CDP 截圖走 compositor，GPU 路徑有問題時兩者會不同）。 */
  const grab = (file) =>
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-video_size', `${width}x${height}`, '-i', `${display}.0`, '-frames:v', '1', file], { env });

  const shot = async (file, clip = null) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    writeFileSync(file, Buffer.from(data, 'base64'));
  };

  return {
    send, evaluate, waitFor, moveTo, click, drag, wheel, type, key, box, clickOn, button, record, shot, grab, xdo, errors, dialogs, origin, width, height, scale,
    get pos() {
      return pos;
    },
    close: () => children.forEach(kill),
  };
}

/** 用帳號密碼換 token（demo 堆疊是 auth required）。 */
export async function login(api, username, password) {
  const r = await fetch(`${api}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (!r.ok) throw new Error(`登入失敗 ${r.status}`);
  return (await r.json()).token;
}
