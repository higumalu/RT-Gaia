(() => {
  if (!window.__obs) { try { performance.setResourceTimingBufferSize(20000); } catch (e) {} window.__lt = [];
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch (e) {} window.__obs = 1; window.__phase = 0; window.__ts = Date.now(); }
  const btn = (t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t);
  const hideAll = btn('全隱藏'), showAll = btn('全顯示'); if (!hideAll || !showAll) return false;
  if (document.querySelectorAll('.structure-list li:not(.structure-set)').length < 20) return false;
  const since = Date.now() - window.__ts;
  // phase 0: 第一次全顯示（抓 mask）；phase 1: 等 12 s；phase 2: 全隱藏；phase 3: 等 8 s；phase 4: 第二次全顯示（mask 都在本地）量一次 render 的成本
  if (window.__phase === 0) { showAll.click(); window.__phase = 1; window.__ts = Date.now(); return false; }
  if (window.__phase === 1) { if (since < 12000) return false; hideAll.click(); window.__phase = 2; window.__ts = Date.now(); return false; }
  if (window.__phase === 2) { if (since < 8000) return false; window.__lt = []; window.__m0 = performance.getEntriesByType('resource').length; showAll.click(); window.__phase = 3; window.__ts = Date.now(); return false; }
  if (since < 6000) return false;
  const res = performance.getEntriesByType('resource').slice(window.__m0);
  console.log('METRICS2 ' + JSON.stringify({ secondShowAll: { longTasks: window.__lt.length, longTaskTotalMs: window.__lt.reduce((a, b) => a + b, 0), longTaskMaxMs: Math.max(0, ...window.__lt), requests: res.length, maskRequests: res.filter(e => e.name.includes('/mask')).length } }));
  return true;
})()
