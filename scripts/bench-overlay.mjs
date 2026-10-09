// canvas 2D vs SVG：畫同一批輪廓 polyline 的每幀成本。
// 「outline 走 canvas 還是 SVG」先前的實測量的是
// marching squares 與影像重切，沒有量繪製路徑本身。這裡補上。
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
await send('Runtime.enable');

const expr = `(async () => {
  const W = 512, H = 512;
  const STRUCTURES = 20, SEGMENTS_TOTAL = 3326;   // 實測的全解析度數字
  const perStructure = Math.round(SEGMENTS_TOTAL / STRUCTURES);

  // 產生 20 條封閉 polyline，總段數 ≈ 3326，形狀與大小接近真實 ROI 輪廓
  const polys = [];
  for (let s = 0; s < STRUCTURES; s += 1) {
    const cx = 100 + (s % 5) * 80, cy = 100 + Math.floor(s / 5) * 90;
    const r = 25 + (s % 4) * 12;
    const pts = [];
    for (let i = 0; i < perStructure; i += 1) {
      const t = (i / perStructure) * Math.PI * 2;
      pts.push([cx + r * Math.cos(t) * (1 + 0.15 * Math.sin(5 * t)),
                cy + r * Math.sin(t) * (1 + 0.15 * Math.cos(4 * t))]);
    }
    polys.push({ pts, color: 'rgb(' + (50 + s * 9) + ',200,150)' });
  }
  const totalSegs = polys.reduce((n, p) => n + p.pts.length, 0);

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;width:512px;height:512px;z-index:99999;opacity:0.01;pointer-events:none';
  document.body.appendChild(host);

  // 🔴 **不用 requestAnimationFrame gating**：那會讓每個樣本至少一個 vsync 間隔
  // （60 Hz = 16.7 ms），三種做法全部量到 16.7 ms，數字毫無意義。
  // 這裡量的是「同步的 JS ＋ DOM 變更 ＋ 強制 layout」，不含 compositor 的 paint。
  // canvas 的光柵化發生在 stroke() 內，SVG 的 paint 在之後 —— 這個限制要一起報。
  const frames = (draw, n, flush) => {
    for (let w = 0; w < 5; w += 1) { draw(w); flush(); }   // warm-up
    const t = [];
    for (let f = 0; f < n; f += 1) {
      const t0 = performance.now();
      draw(f);
      flush();
      t.push(performance.now() - t0);
    }
    t.sort((a, b) => a - b);
    return { p50: +t[Math.floor(t.length * 0.5)].toFixed(2), p90: +t[Math.floor(t.length * 0.9)].toFixed(2) };
  };

  // ── A) canvas 2D：每個結構一次 beginPath/stroke ────────────────────────
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H; host.appendChild(cv);
  const ctx = cv.getContext('2d');
  const canvasDraw = (f) => {
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1.5;
    for (const p of polys) {
      ctx.strokeStyle = p.color;
      ctx.beginPath();
      const o = (f % 3) * 0.5;   // 每幀都不同，避免任何快取
      ctx.moveTo(p.pts[0][0] + o, p.pts[0][1] + o);
      for (let i = 1; i < p.pts.length; i += 1) ctx.lineTo(p.pts[i][0] + o, p.pts[i][1] + o);
      ctx.closePath();
      ctx.stroke();
    }
  };
  const canvas = frames(canvasDraw, 200, () => { void cv.getBoundingClientRect().width; });
  cv.remove();

  // ── B) SVG，每個結構一個 <path>，只更新 d（SVG 的最佳情況）────────────
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', W); svg.setAttribute('height', H);
  host.appendChild(svg);
  const paths = polys.map((p) => {
    const el = document.createElementNS(NS, 'path');
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', p.color);
    el.setAttribute('stroke-width', '1.5');
    svg.appendChild(el);
    return el;
  });
  const svgPathDraw = (f) => {
    const o = (f % 3) * 0.5;
    for (let s = 0; s < polys.length; s += 1) {
      const pts = polys[s].pts;
      let d = 'M' + (pts[0][0] + o) + ' ' + (pts[0][1] + o);
      for (let i = 1; i < pts.length; i += 1) d += 'L' + (pts[i][0] + o) + ' ' + (pts[i][1] + o);
      paths[s].setAttribute('d', d + 'Z');
    }
  };
  const svgPath = frames(svgPathDraw, 200, () => { void svg.getBBox(); });
  svg.remove();

  // ── C) SVG，每一段一個 <line>（擔心的是「數萬節點屬性」）──────
  const svg2 = document.createElementNS(NS, 'svg');
  svg2.setAttribute('width', W); svg2.setAttribute('height', H);
  host.appendChild(svg2);
  const lines = [];
  for (const p of polys) {
    for (let i = 0; i < p.pts.length; i += 1) {
      const el = document.createElementNS(NS, 'line');
      el.setAttribute('stroke', p.color);
      el.setAttribute('stroke-width', '1.5');
      svg2.appendChild(el);
      lines.push([el, p.pts, i]);
    }
  }
  const svgLineDraw = (f) => {
    const o = (f % 3) * 0.5;
    for (const [el, pts, i] of lines) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      el.setAttribute('x1', a[0] + o); el.setAttribute('y1', a[1] + o);
      el.setAttribute('x2', b[0] + o); el.setAttribute('y2', b[1] + o);
    }
  };
  const svgLine = frames(svgLineDraw, 60, () => { void svg2.getBBox(); });
  const nodeCount = svg2.childElementCount;
  svg2.remove();
  host.remove();

  return JSON.stringify({
    structures: STRUCTURES, segments: totalSegs,
    canvas2d: canvas, svgOnePathPerStructure: svgPath,
    svgOneLinePerSegment: { ...svgLine, domNodes: nodeCount },
  });
})()`;
const out = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log(out.result.result?.value ?? JSON.stringify(out.result));
ws.close();
