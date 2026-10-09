(() => {
  if (!window.__hook) {
    window.__hook = 1; window.__log = []; window.__ts = Date.now(); window.__phase = 0; window.__lt = [];
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
    const orig = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('render3d')) { const t = performance.now(); const b = init && init.body ? JSON.parse(init.body) : {}; const rec = { start: Math.round(t), layers: (b.layers || []).length, size: b.output_size_px, end: null, ms: null, status: null };
        window.__log.push(rec); return orig(input, init).then(r => { rec.end = Math.round(performance.now()); rec.ms = rec.end - rec.start; rec.status = r.status; return r; }); }
      return orig(input, init);
    };
  }
  const btn = (t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t);
  const showAll = btn('全顯示'); if (!showAll) return false;
  if (document.querySelectorAll('.structure-list li:not(.structure-set)').length < 20) return false;
  const since = Date.now() - window.__ts;
  const img = document.querySelector('[class*=render3d] img');
  if (window.__phase === 0) { if (since < 4000) return false; showAll.click(); window.__phase = 1; window.__ts = Date.now(); return false; }
  if (window.__phase === 1) { if (since < 15000 || !img) return false; window.__log = []; window.__lt = []; window.__phase = 2; window.__ts = Date.now();
    const r = img.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const ev = (type, x, y, buttons) => img.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons, pointerId: 1, isPrimary: true, pointerType: 'mouse' }));
    ev('pointerdown', cx, cy, 1); let i = 0;
    const step = () => { i++; ev('pointermove', cx + i * 6, cy + i * 2, 1); if (i < 40) setTimeout(step, 16); else { ev('pointerup', cx + i * 6, cy + i * 2, 0); window.__up = performance.now(); } };
    setTimeout(step, 30); return false; }
  if (since < 20000) return false;
  const done = window.__log.filter(r => r.end !== null);
  console.log('DRAG ' + JSON.stringify({ requests: window.__log.length, completed: done.length, small: window.__log.filter(r => r.size && r.size[0] <= 224).length,
    avgMs: Math.round(done.reduce((a, r) => a + r.ms, 0) / Math.max(1, done.length)), maxMs: Math.max(0, ...done.map(r => r.ms)),
    lastEndAfterUpMs: Math.round(Math.max(0, ...done.map(r => r.end)) - window.__up), longTasks: window.__lt.length, longTaskTotalMs: window.__lt.reduce((a, b) => a + b, 0), layers: window.__log[0]?.layers }));
  return true;
})()
