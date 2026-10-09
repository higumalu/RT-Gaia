(() => {
  if (!window.__obs) { try { performance.setResourceTimingBufferSize(20000); } catch (e) {}
    window.__lt = [];
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
    window.__obs = 1;
  }
  const btn = (t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t);
  const hideAll = btn('全隱藏'), showAll = btn('全顯示');
  if (!hideAll || !showAll) return false;
  const rows = document.querySelectorAll('.structure-list li:not(.structure-set)').length;
  if (!window.__t0) {
    if (rows < 20) return false;
    // 等首次載入的 mask 都到齊再開始
    if (performance.getEntriesByType('resource').filter(e => e.name.includes('/mask')).length < 5) return false;
    hideAll.click(); window.__t0 = Date.now(); return false;
  }
  if (Date.now() - window.__t0 < 8000) return false;
  if (!window.__t1) {
    window.__lt = []; window.__m0 = performance.getEntriesByType('resource').length;
    window.__frames = 0; window.__gap = 0; let last = performance.now();
    const tick = (now) => { window.__frames++; window.__gap = Math.max(window.__gap, now - last); last = now; if (window.__t1 && !window.__done) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    showAll.click(); window.__t1 = performance.now(); return false;
  }
  const res = performance.getEntriesByType('resource').slice(window.__m0);
  const masks = res.filter(e => e.name.includes('/mask'));
  const r3d = res.filter(e => e.name.includes('render3d'));
  const lastEnd = Math.max(window.__t1, ...res.map(e => e.responseEnd));
  if (performance.now() - lastEnd < 5000) return false;
  window.__done = 1;
  const sum = a => a.reduce((x, y) => x + y, 0);
  console.log('METRICS ' + JSON.stringify({
    rows, sinceShowAllMs: Math.round(performance.now() - window.__t1),
    longTasks: window.__lt.length, longTaskTotalMs: sum(window.__lt), longTaskMaxMs: Math.max(0, ...window.__lt), longTaskTop5: [...window.__lt].sort((a, b) => b - a).slice(0, 5),
    maxFrameGapMs: Math.round(window.__gap), frames: window.__frames,
    maskRequests: masks.length, maskKB: Math.round(sum(masks.map(e => e.transferSize || e.encodedBodySize)) / 1024),
    maskFirstEndMs: Math.round(Math.min(...masks.map(e => e.responseEnd)) - window.__t1), maskLastEndMs: Math.round(Math.max(0, ...masks.map(e => e.responseEnd)) - window.__t1),
    render3d: r3d.map(e => ({ durMs: Math.round(e.duration), endMs: Math.round(e.responseEnd - window.__t1) })),
    otherRequests: res.length - masks.length - r3d.length,
    checked: document.querySelectorAll('.structure-list li input[type=checkbox]:checked').length,
  }));
  return true;
})()
