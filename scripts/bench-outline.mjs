/**
 * 量「20 結構的 outline 重算時間」—— 新架構下最重要的一個未實測數字。
 *
 * 用法：
 *   ./scripts/dev.sh dicom:/path/to/CT          # 起前後端
 *   google-chrome --headless=new --remote-debugging-port=9222 \
 *     --no-sandbox --window-size=1600,1000 about:blank &
 *   # 先讓頁面載入一次（bench 會自己 import core 的模組）
 *   node scripts/bench-outline.mjs
 *
 * 量的是 `reslicePlane()` ＋ `marchingSquares()` 這兩個核心呼叫本身
 * ——也就是效能預算的對象，不含 canvas 描邊與 React。
 */
/** 受控量測：直接驅動 renderer.render()，讀 FrameStats.outlineMs。 */
const CDP='http://127.0.0.1:9222';
const targets=await (await fetch(`${CDP}/json/list`)).json();
const page=targets.find(t=>t.type==='page');
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r=>(ws.onopen=r));
let id=0; const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
const send=(method,params={})=>new Promise(res=>{const n=++id;pending.set(n,res);ws.send(JSON.stringify({id:n,method,params}));});
await send('Runtime.enable');
const out=await send('Runtime.evaluate',{
  awaitPromise:true, returnByValue:true,
  expression:`(async()=>{
    const core = await import('/src/core/index.ts');
    // 從 DOM 找到 axial 的容器，重建一個獨立的 renderer 來量（不干擾畫面）
    const host = document.querySelector('.viewport[data-viewport-id=axial] .viewport-canvas-host');
    const results = [];
    // 透過已存在的 canvas 反推目前的 renderer 不可行（core 沒暴露），
    // 因此直接量「核心的兩個呼叫」——那才是效能預算的對象。
    const kmod = await import('/src/core/raster/resliceKernel.ts');
    const kernel = await kmod.loadResliceKernel();

    // 取回影像與 mask 體素（走 transport，與畫面同一條路）
    const transport = new core.TransportClient({});
    const sessions = await (await fetch('/api/v1/_test/sessions')).json();
    const studyId = sessions.sessions[0].study_id;
    const state = await (await fetch('/api/v1/_test/state')).json();
    const seriesIds = state.gridSet.frame_groups.map(f=>f.series_id);
    const grids = await transport.createGrids({studyId, primarySeriesId:seriesIds[0], seriesIds,
      capability:{webgl2:true,maxTexture3d:2048,hasNorm16:true,rendererString:'bench',looksSoftware:false,probeAllocMb:0,probeFps:60,tier:'A'}});
    const image = await transport.fetchImage({seriesId:seriesIds[0], lod:0});
    const structures = await transport.fetchStructures();

    // 取前 20 個有體積的結構（效能預算的基準）
    const picked = structures.filter(s=>typeof s.volumeCc==='number' && s.volumeCc>1).slice(0,20);
    const masks = [];
    for (const s of picked) {
      const m = await transport.fetchMask(s.structureId, {frameIndex:null});
      masks.push({
        voxels: new Uint8Array(m.voxels),
        key: 'm:'+s.structureId,
        grid: core.blockGridOf(grids.gridSet.maskGrid.grid, m.offsetIjk, m.sizeIjk),
      });
    }

    const W=512,H=512;
    const grid = image.gridSet.grid;
    const center = core.gridCenterWorld(grid);
    const baseView = core.orthoCamera({grid, orientation:'axial', displayGridId:grids.gridSet.displayGrid.displayGridId, planeOrigin:center});
    const pxMm = core.fitPxMm(grid, baseView, {w:W,h:H});
    const voxels = new Int16Array(image.voxels);

    const measure = (scale) => {
      const w = Math.round(W*scale), h = Math.round(H*scale), px = pxMm/scale;
      const imageMs=[], outlineMs=[], segs=[];
      for (let n=0;n<20;n++){
        // 每次換一張切片 —— 捲動就是改平面，輪廓完全失效
        const view = core.stepAlongNormal(grid, baseView, n-10);
        let t0=performance.now();
        kernel.reslicePlane({volume:voxels, volumeKey:'img', grid, view, outSizePx:[w,h], pxMm:px, blend:'center', outside:-1024});
        imageMs.push(performance.now()-t0);
        t0=performance.now();
        let total=0;
        for (const m of masks){
          const field = kernel.reslicePlane({volume:m.voxels, volumeKey:m.key, grid:m.grid, view, outSizePx:[w,h], pxMm:px, blend:'center', outside:0});
          total += kernel.marchingSquares(field, w, h, 0.5).length/4;
        }
        outlineMs.push(performance.now()-t0);
        segs.push(total);
      }
      const p=(a,q)=>{const b=[...a].sort((x,y)=>x-y);return +b[Math.floor(q*(b.length-1))].toFixed(2);};
      return {out:[w,h], imageP50:p(imageMs,0.5), imageP90:p(imageMs,0.9),
              outlineP50:p(outlineMs,0.5), outlineP90:p(outlineMs,0.9),
              segsP50:Math.round(p(segs,0.5))};
    };

    const final_ = measure(1.0);
    const interactive = measure(0.5);
    kernel.dispose();
    return JSON.stringify({structures:masks.length, pxMm:+pxMm.toFixed(3), final:final_, interactive}, null, 1);
  })()`
});
const r = out.result;
if (r?.exceptionDetails) {
  console.error('EXCEPTION:', r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
} else {
  console.log(r?.result?.value ?? JSON.stringify(r, null, 2));
}
ws.close();
