/**
 * Demo 影片的分鏡。每一幕：`setup(s, ctx)` 不錄、把畫面準備好；`run(s, rec, ctx)` 錄。
 * 字幕寫英文（影片是英文版），一句講一件事；節奏抓「操作 → 停一下讓人看清楚」。
 * 選擇器用英文介面的實際字樣（apps/viewer/src/core/i18n/en.ts）。
 */
import { sleep } from './lib/screen.mjs';

// ── 選擇器 ──────────────────────────────────────────────────────────────────
const rowWith = (kind, text) =>
  `[...document.querySelectorAll('.catalog-tree tr[data-kind="${kind}"]')].find((r) => r.innerText.includes(${JSON.stringify(text)}))`;
const cell = (label) => `[...document.querySelectorAll('.viewport-cell')].find((c) => c.innerText.trim().startsWith(${JSON.stringify(label)}))`;
const SEARCH = `document.querySelector('input[placeholder^="Search patient ID"]')`;

// ── 共用動作 ────────────────────────────────────────────────────────────────
/** 回到資料庫頁、清掉上一次的選取（不錄）。 */
async function freshLibrary(s, ctx) {
  await s.send('Page.navigate', { url: `${ctx.FE}/#/library` });
  await s.waitFor(`document.querySelectorAll('.catalog-tree tr[data-kind="patient"]').length >= 1`, '資料庫頁', 60000);
  await s.evaluate(`(${s.button('Clear')})?.click(); true`);
  await sleep(500);
}

/**
 * 不錄的開病例：病人 → study → 勾影像（或 4D 組）→ 開啟。`images` 是要勾的影像列文字（第一個當主要影像）；
 * `temporal` 是 4D 組那一列的文字（整組勾）。
 */
async function openCase(s, ctx, { patient, study, images = [], temporal = null, rts = [] }) {
  await freshLibrary(s, ctx);
  // 點列是切換展開：已經展開（上一次留下的）就不要再點
  if (!(await s.evaluate(`!!${rowWith('study', study)}`))) await s.evaluate(`${rowWith('patient', patient)}.click(); true`);
  await s.waitFor(`!!${rowWith('study', study)}`, `study ${study}`);
  const first = temporal ? rowWith('temporal', temporal) : rowWith('image', images[0]);
  if (!(await s.evaluate(`!!${first}`))) await s.evaluate(`${rowWith('study', study)}.click(); true`);
  if (temporal) {
    await s.waitFor(`!!${first}`, `4D 組 ${temporal}`);
    await s.evaluate(`(() => { const c = ${first}.querySelector('input[type=checkbox]'); if (!c.checked) c.click(); return true; })()`);
    await sleep(600);
  }
  for (const image of images) {
    await s.waitFor(`!!${rowWith('image', image)}`, `影像 ${image}`);
    await s.evaluate(`${rowWith('image', image)}.querySelector('input[type=checkbox]').click(); true`);
    await sleep(400);
  }
  for (const rt of rts) {
    // RT 物件列要展開影像列才看得到：用搜尋把整條路徑展開
    await s.evaluate(`(() => { const i = ${SEARCH}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(patient)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await s.waitFor(`!!${rowWith('rt', rt)}`, `RT 物件 ${rt}`);
    await s.evaluate(`(() => { const c = ${rowWith('rt', rt)}.querySelector('input[type=checkbox]'); if (!c.checked) c.click(); return true; })()`);
    await sleep(400);
  }
  await s.evaluate(`(${s.button('Open')}).click(); true`);
  await waitViewer(s);
}

async function waitViewer(s) {
  // 2D 格有 canvas；3D 格是伺服器出的圖（版面跟帳號存，上一幕留下的可能是 3D 格）
  await s.waitFor(`location.hash.includes('viewer') && document.querySelectorAll('.viewport-cell canvas, .viewport-cell .render3d-img').length >= 1`, '檢視器', 300000);
  await s.waitFor(`!document.querySelector('.mask-loading')`, '結構載入完', 300000);
  await sleep(1500);
}

/** 不錄的換帳號：換掉 session cookie 再整頁重新載入（App 會記住登入的人，只換 hash 不會重讀）。 */
async function signInAs(s, ctx, username) {
  const token = await ctx.login(username);
  await s.send('Network.setCookie', { name: 'rtgaia_session', value: token, url: s.origin, httpOnly: true });
  await s.send('Page.navigate', { url: `${ctx.FE}/#/library` });
  await s.send('Page.reload', { ignoreCache: false });
  // 重新載入後可能直接回到這個帳號上次開的病例（檢視器），所以等標頭的帳號名稱，不等資料頁
  const who = await (await fetch(`${ctx.BE}/api/v1/auth/status`, { headers: { cookie: `rtgaia_session=${token}` } })).json();
  const name = who.user?.display_name ?? username;
  await s.waitFor(`document.body.innerText.includes(${JSON.stringify(name)})`, `以 ${username} 登入`, 60000);
  await sleep(800);
}

/** 不錄的：確定是這個帳號（標頭有它的顯示名稱）；不是就換。單獨重錄某一幕時用得到。 */
async function ensureUser(s, ctx, username) {
  const who = await (await fetch(`${ctx.BE}/api/v1/auth/status`, { headers: { cookie: `rtgaia_session=${await ctx.login(username)}` } })).json();
  const name = who.user?.display_name ?? username;
  if (!(await s.evaluate(`document.body.innerText.includes(${JSON.stringify(name)})`))) await signInAs(s, ctx, username);
}

/** 不錄的劑量顯示開關（劑量列的勾選框）。 */
async function showDose(s, on) {
  await s.evaluate(`(() => { const c = document.querySelector('.dose-row label.visibility input'); if (c && c.checked !== ${on}) c.click(); return true; })()`);
  await sleep(600);
}

/** 按住某個鍵做事（例：Ctrl ＋ 滾輪縮放）。 */
async function holding(s, key, fn) {
  s.xdo?.('keydown', key);
  try {
    await fn();
  } finally {
    s.xdo?.('keyup', key);
  }
}

/**
 * 錄得到的下拉選單：點開、用方向鍵移到那一項、Enter（原生下拉的位置不好算，鍵盤最穩）。
 * `want` 比對 option 的 value 或文字。
 */
async function chooseOption(s, selectExpr, want) {
  const { from, to } = await s.evaluate(`(() => { const sel = ${selectExpr}; const o = [...sel.options]; return { from: sel.selectedIndex, to: o.findIndex((x) => x.value === ${JSON.stringify(want)} || x.textContent.trim() === ${JSON.stringify(want)}) }; })()`);
  if (to < 0) throw new Error(`下拉選單沒有：${want}`);
  await s.clickOn(selectExpr, `下拉選單（${want}）`);
  await sleep(500);
  for (let i = 0; i < Math.abs(to - from); i += 1) await s.key(to > from ? 'Down' : 'Up');
  await sleep(300);
  await s.key('Return');
  await sleep(700);
  // 下拉清單沒開（Chrome 偶爾卡住）時方向鍵會跑去別的地方：沒選到就停下來，不要錄出錯的畫面
  const got = await s.evaluate(`(${selectExpr}).selectedIndex`);
  if (got !== to) throw new Error(`下拉選單沒選到 ${want}（停在第 ${got} 項）`);
}

const chooseLayout = (s, label) => chooseOption(s, `document.querySelector('.layout-picker select')`, label);

/** 不錄的版面切換：依選項文字（英文介面）設 `.layout-picker select`。 */
async function setLayout(s, label) {
  const ok = await s.evaluate(`(() => {
    const sel = document.querySelector('.layout-picker select');
    const opt = [...sel.options].find((o) => o.textContent.trim() === ${JSON.stringify(label)});
    if (!opt) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!ok) throw new Error(`沒有這個版面：${label}`);
  await sleep(800);
  // 版面的格子內容、分割、大小跟著帳號存：上一次改過（例：把格子換成冠狀）就有「Reset layout」，按掉回到預設
  await s.evaluate(`(${s.button('Reset layout')})?.click(); true`);
  await sleep(1000);
}

const PET_ROW = `[...document.querySelectorAll('.image-row')].find((r) => r.querySelector('.image-row-name')?.title.includes('FDG'))`;

const PANCREAS = { patient: 'Pancreas-CT-CB_014', study: 'UPPER GI', images: ['CTDI'], rts: ['Eclipse Doses'] };

/** 這一格現在的切片（「38 / 74」的 38）。 */
const sliceOf = (s, label) => s.evaluate(`Number((${cell(label)})?.innerText.match(/(\\d+) \\/ \\d+/)?.[1])`);

/** 不錄的換切片：滾輪往上一格 ＝ 下一張（編號 +1）。 */
async function goToSlice(s, label, n) {
  const b = await s.box(cell(label));
  s.xdo('mousemove', Math.round(b.x), Math.round(b.y));
  for (let i = 0; i < 200; i += 1) {
    const cur = await sliceOf(s, label);
    if (cur === n) return;
    s.xdo('click', cur < n ? 4 : 5);
    await sleep(60);
  }
  throw new Error(`換不到第 ${n} 張`);
}

/** 讀數的取像網格索引 (i, j, k)；指標不在影像上 → null。 */
async function readIjk(s, x, y) {
  s.xdo('mousemove', Math.round(x) + 1, Math.round(y));
  await sleep(120);
  s.xdo('mousemove', Math.round(x), Math.round(y));
  await sleep(250);
  const m = (await s.evaluate(`document.querySelector('.probe-ijk')?.textContent ?? ''`)).match(/\((-?\d+), (-?\d+), (-?\d+)\)/);
  return m ? { i: Number(m[1]), j: Number(m[2]), k: Number(m[3]) } : null;
}

/**
 * 不錄的定位：某一格裡體素 (i, j) 在螢幕上的哪裡。用讀數量兩個方向的換算（版面、縮放都不用寫死）。
 * 只適用軸狀格（i 跟 x、j 跟 y 走）；回傳螢幕 px。
 */
async function locateVoxel(s, label, { i, j }) {
  const b = await s.box(cell(label));
  const d = 120;
  const o = await readIjk(s, b.x, b.y);
  const rx = await readIjk(s, b.x + d, b.y);
  const ry = await readIjk(s, b.x, b.y + d);
  if (!o || !rx || !ry) throw new Error('定位：讀數讀不到（指標不在影像上？）');
  const ix = (rx.i - o.i) / d;
  const jy = (ry.j - o.j) / d;
  return { x: b.x + (i - o.i) / ix, y: b.y + (j - o.j) / jy };
}

/** 輸入框：點進去、Ctrl+A 全選再打字（number 欄位三連擊選不到內容）。 */
async function typeInto(s, expr, text, what) {
  await s.clickOn(expr, what);
  await s.key('ctrl+a');
  if (String(text) === '') await s.key('BackSpace');
  else await s.type(String(text), { delay: 70 });
  await s.key('Tab');
}

/** 範圍滑桿調到某個值：點一下滑桿取得焦點，再用方向鍵一格一格調（比拖曳準）。 */
async function setRange(s, expr, value, what) {
  const b = await s.box(expr);
  const { min, max, cur } = await s.evaluate(`(() => { const e = ${expr}; return { min: Number(e.min), max: Number(e.max), cur: Number(e.value) }; })()`);
  await s.moveTo(b.left + ((cur - min) / (max - min)) * b.w, b.y);
  await sleep(150);
  await s.click();
  for (let n = 0; n < 100; n += 1) {
    const v = Number(await s.evaluate(`${expr}.value`));
    if (Math.abs(v - value) < 1e-6) return;
    await s.key(v < value ? 'Right' : 'Left');
    await sleep(60);
  }
  throw new Error(`${what} 調不到 ${value}`);
}

/** 不錄的：把某一格換成別的方位或面板（格子右上角的選單；`vp:coronal`、`panel:dvh.chart`…）。 */
async function setCellContent(s, cellExpr, value) {
  const ok = await s.evaluate(`(() => {
    const sel = (${cellExpr})?.querySelector('select.cell-picker');
    if (!sel || ![...sel.options].some((o) => o.value === ${JSON.stringify(value)})) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(value)});
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!ok) throw new Error(`格子選單沒有 ${value}`);
  await sleep(1500);
}

/** 不錄的：十字線移到螢幕上這一點（十字線工具的 Shift＋點）。 */
async function shiftClick(s, x, y) {
  s.xdo('mousemove', Math.round(x), Math.round(y));
  await sleep(200);
  s.xdo('keydown', 'shift');
  await sleep(80);
  s.xdo('click', 1);
  await sleep(80);
  s.xdo('keyup', 'shift');
  await sleep(800);
}

/** 不錄的：結構清單只留名稱符合 `keep` 的（其他取消勾選）。 */
async function onlyStructures(s, keep) {
  await s.evaluate(`(() => {
    // 結構列：<li><label.visibility><input></label>…<span.name></li>
    for (const row of document.querySelectorAll('li')) {
      const name = row.querySelector(':scope > span.name')?.textContent.trim();
      const box = row.querySelector(':scope > label.visibility input[type=checkbox]');
      if (name !== undefined && box && box.checked !== ${keep}.test(name)) box.click();
    }
    return true;
  })()`);
  await sleep(1500);
}

const ROI_PANEL = `document.querySelector('.roi-panel')`;
const POST = `[...document.querySelectorAll('.roi-panel .roi-section')].find((x) => x.querySelector('.roi-section-title')?.textContent.trim() === 'Post-processing')`;
/** 脊髓腔中心（Pancreas-CT-CB_014 CTDI；第 39 張與第 45 張骨環完整，閾值筆刷不會漏到椎間孔）。 */
const CANAL = { first: 39, last: 45, voxel: { i: 245, j: 340 }, lastOffsetPx: 24 };
/** 4D-Lung 113_HM10395、1999-11-26 的 4DCT：腫瘤在左肺門（軸向第 50 張的體素）。 */
const LUNG4D = { patient: '113_HM10395', study: '1999-11-26', temporal: 'CT4D', slice: 50, tumor: { i: 321, j: 326 } };
/**
 * PROTEAS 腦轉移（Zenodo CC BY 4.0）的 P21：多弧 VMAT、非共平面。**這個病例沒有去臉**（選用它的條件）：
 * 不出 3D、不出矢狀 —— 版面用 1×1 分割，右格放 BEV／MLC，從頭到尾不建 3D 格。
 */
const PROTEAS = { patient: 'RPRO29', study: '(no description)', images: ['512×512×355'], rts: ['AP1MTFINAL'] };
const BEV_CELL = `[...document.querySelectorAll('.viewport-cell')].find((c) => c.innerText.trim().startsWith('BEV'))`;
const PLUGINS_BUTTON = `document.querySelector('.plugins-menu > button')`;
const NNUNET_ITEM = `[...document.querySelectorAll('.plugins-dropdown button[role=menuitemcheckbox]')].find((b) => b.textContent.includes('nnU-Net'))`;
const NNUNET = `document.querySelector('.nnunet-panel')`;

// ── 分鏡 ────────────────────────────────────────────────────────────────────
export const SCENES = [
  {
    id: 'library',
    async setup(s, ctx) {
      await freshLibrary(s, ctx);
      await s.moveTo(1500, 700, 300);
    },
    async run(s, rec) {
      rec.cue('All DICOM in one library: patients, studies and series');
      await sleep(1800);
      await s.clickOn(SEARCH, '搜尋欄');
      await s.type('Pancreas', { delay: 85 });
      // 搜尋會自動展開符合的路徑；沒展開才點
      await sleep(1300);
      if (!(await s.evaluate(`!!${rowWith('study', 'UPPER GI')}`))) {
        await s.clickOn(rowWith('patient', 'Pancreas-CT-CB_014'), '病人列', { dx: -300 });
        await sleep(700);
      }
      if (!(await s.evaluate(`!!${rowWith('image', 'CTDI')}`))) {
        await s.clickOn(rowWith('study', 'UPPER GI'), 'study 列', { dx: -300 });
      }
      await sleep(1200);
      rec.cue('Tick an image: its structure sets and registrations come along');
      await s.clickOn(`${rowWith('image', 'CTDI')}.querySelector('input[type=checkbox]')`, 'CTDI 勾選');
      await sleep(1800);
      rec.cue('Add a dose from the same frame of reference');
      await s.clickOn(`${rowWith('rt', 'Eclipse Doses')}.querySelector('input[type=checkbox]')`, '劑量勾選');
      await sleep(1800);
      rec.cue('Open the case');
      await s.clickOn(s.button('Open'), '開啟');
      await waitViewer(s);
      await sleep(1500);
    },
  },
  {
    id: 'viewer',
    async setup(s, ctx) {
      const open = await s.evaluate(`location.hash.includes('viewer') && document.body.innerText.includes('Pancreas-CT-CB_014')`);
      if (!open) await openCase(s, ctx, PANCREAS);
      await setLayout(s, '2×2');
      // 劑量留到劑量那一幕；這一幕看影像與結構
      await showDose(s, false);
      await sleep(2500);
      const axial = await s.box(cell('Axial'));
      await s.moveTo(axial.x + 120, axial.y - 150, 300);
    },
    async run(s, rec) {
      const axial = await s.box(cell('Axial'));
      rec.cue('Linked axial, coronal and sagittal views, with structures from the RTSTRUCT');
      await s.moveTo(axial.x, axial.y);
      await sleep(500);
      await s.wheel(8, { delay: 90 });
      await sleep(300);
      await s.wheel(-5, { delay: 90 });
      await sleep(700);
      rec.cue('Right-drag adjusts window and level');
      // 左右改窗寬、上下改窗位：先拉開再拉回一點，像人在找合適的對比
      const wl = [];
      for (let i = 0; i <= 30; i += 1) wl.push([axial.x + i * 5, axial.y - i * 1.5]);
      for (let i = 1; i <= 20; i += 1) wl.push([axial.x + 150 - i * 6, axial.y - 45 + i * 3]);
      await s.drag(wl, { button: 3, stepMs: 22 });
      await sleep(900);
      rec.cue('Ctrl + wheel zooms around the pointer');
      await s.moveTo(axial.x + 15, axial.y - 5, 400);
      await holding(s, 'Control_L', () => s.wheel(-5, { delay: 110 }));
      await sleep(900);
      rec.cue('The readout shows the value and every structure under the pointer');
      await s.moveTo(axial.x - 20, axial.y - 10, 600);
      await sleep(2200);
      await s.moveTo(axial.x + 50, axial.y + 25, 600);
      await sleep(1800);
    },
  },
  {
    id: 'contour',
    async setup(s, ctx) {
      const open = await s.evaluate(`location.hash.includes('viewer') && document.body.innerText.includes('Pancreas-CT-CB_014')`);
      if (!open) await openCase(s, ctx, PANCREAS);
      await setLayout(s, '1×1 axial');
      await showDose(s, false);
      // ROI 編輯面板先開好（開面板會讓影像格變窄，定位要在開好之後量）
      if (!(await s.evaluate(`!!${ROI_PANEL}`))) await s.evaluate(`(${s.button('ROI editing')}).click(); true`);
      await s.waitFor(`!!${ROI_PANEL}`, 'ROI editing 面板');
      // 「New」是開關：上一次留著的建立列先收起來
      if (await s.evaluate(`!!document.querySelector('.roi-create')`)) await s.evaluate(`(${s.button('New', ROI_PANEL)}).click(); true`);
      await s.key('Escape');
      // 工具列按鈕前面有圖示字元（「✛Crosshair」）：用結尾比對；已經選了就不要再點（工具按鈕是開關）
      await s.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().endsWith('Crosshair')); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); return true; })()`);
      await s.evaluate(`(${s.button('Fit', cell('Axial'))}).click(); true`);
      await sleep(1000);
      await goToSlice(s, 'Axial', CANAL.first);
      ctx.canal = await locateVoxel(s, 'Axial', CANAL.voxel);
      await s.moveTo(ctx.canal.x + 260, ctx.canal.y - 330, 300);
    },
    async run(s, rec, ctx) {
      const P = ctx.canal;
      rec.cue('Create a structure: RT-Gaia suggests the TG-263 standard name');
      await s.clickOn(s.button('New', ROI_PANEL), 'New');
      await s.clickOn(`document.querySelector('.roi-create input.roi-name')`, '名稱欄');
      await s.type('cord', { delay: 100 });
      await sleep(300);
      await s.clickOn(s.button('Create', `document.querySelector('.roi-create')`), 'Create');
      await s.waitFor(`${ROI_PANEL}.innerText.includes('TG-263 suggests')`, 'TG-263 建議', 15000);
      await sleep(1100);
      await s.clickOn(s.button('Use', ROI_PANEL), 'Use', { hover: 300 });
      await s.waitFor(`document.body.innerText.includes('SpinalCord')`, '改名成 SpinalCord');
      await sleep(800);

      rec.cue('The threshold brush paints only voxels within an HU range');
      await s.moveTo(P.x, P.y);
      await sleep(300);
      await holding(s, 'Control_L', () => s.wheel(-8, { delay: 65 }));
      await sleep(400);
      await s.clickOn(s.button('Threshold brush', ROI_PANEL), 'Threshold brush');
      const brush = `${ROI_PANEL}.querySelector('.roi-brush')`;
      await s.waitFor(`!!${brush}`, '筆刷設定', 5000);
      await setRange(s, `${brush}.querySelector('input[type=range]')`, 8, '筆刷半徑');
      await typeInto(s, `${brush}.querySelectorAll('.roi-inline input')[0]`, 0, 'HU 下限');
      await typeInto(s, `${brush}.querySelectorAll('.roi-inline input')[1]`, 100, 'HU 上限');
      await sleep(300);
      // 在骨環裡畫幾圈：碰到骨頭的部分不會被畫進去
      const loop = (cx, cy, r, turns) => Array.from({ length: turns * 24 + 1 }, (_, n) => [cx + r * Math.cos((n / 24) * 2 * Math.PI), cy + r * Math.sin((n / 24) * 2 * Math.PI)]);
      await s.drag(loop(P.x, P.y, 16, 2), { stepMs: 16 });
      await sleep(700);

      rec.cue('Contour every few slices, then interpolate the slices in between');
      await chooseOption(s, `${POST}.querySelector('select')`, 'interpolate');
      await s.clickOn(s.button('Start = current', POST), 'Start = current');
      await sleep(500);
      await s.moveTo(P.x, P.y);
      await s.wheel(-(CANAL.last - CANAL.first), { delay: 100 });
      await sleep(400);
      await s.drag(loop(P.x, P.y + CANAL.lastOffsetPx, 16, 2), { stepMs: 16 });
      await sleep(500);
      await s.clickOn(s.button('End = current', POST), 'End = current');
      await sleep(500);
      await s.clickOn(s.button('Run', POST), 'Run');
      await s.waitFor(`[...${ROI_PANEL}.querySelectorAll('.hint')].some((e) => /^Last:.*Interpolat/.test(e.textContent.trim()))`, '內插完成', 30000);
      // 十字游標工具：捲動時不要有筆刷預覽圈
      await s.key('c');
      await sleep(500);
      await s.moveTo(P.x + 160, P.y - 40);
      await s.wheel(CANAL.last - CANAL.first, { delay: 320 });
      await sleep(1100);
    },
  },
  {
    id: '4d',
    async setup(s, ctx) {
      await openCase(s, ctx, LUNG4D);
      await setLayout(s, '1×1 axial');
      await goToSlice(s, 'Axial', LUNG4D.slice);
      const p = await locateVoxel(s, 'Axial', LUNG4D.tumor);
      await shiftClick(s, p.x, p.y);
      await setCellContent(s, cell('Axial'), 'vp:coronal');
      await s.evaluate(`(${s.button('Fit', cell('Coronal'))}).click(); true`);
      await onlyStructures(s, /^(Tumor|ITV)/);
      await s.moveTo(1500, 700, 300);
    },
    async run(s, rec) {
      const TIME = `document.querySelector('.time-group')`;
      const play = `[...${TIME}.querySelectorAll('button')].find((b) => b.title === 'Play' || b.title === 'Pause')`;
      const cor = await s.box(cell('Coronal'));
      rec.cue('4D CT: play through the breathing phases, each with its own contours');
      await s.clickOn(play, 'Play');
      await sleep(2600);
      rec.cue('The time curve follows the value under the pointer across phases');
      // 左橫膈頂（肺與脾胃的交界）：呼吸時上下動，曲線起伏最明顯
      await s.moveTo(cor.left + cor.w * 0.62, cor.top + cor.h * 0.66, 600);
      await sleep(2600);
      await s.clickOn(play, 'Pause');
      await sleep(300);
      rec.cue('Merge the per-phase tumor contours into one structure, then build an ITV');
      await s.clickOn(s.button('Phase structures…', TIME), 'Phase structures…');
      const dlg = `document.querySelector('[role=dialog]')`;
      await s.waitFor(`!!${dlg}`, 'Phase structures 對話框');
      await sleep(700);
      const mergeTumor = `[...${dlg}.querySelectorAll('input')].find((i) => i.value === 'Tumor')?.parentElement.querySelector('button')`;
      await s.clickOn(mergeTumor, 'Merge（Tumor）', { hover: 500 });
      const itvTumor = `[...${dlg}.querySelectorAll('label')].find((l) => l.innerText.replace(/\\s+/g, ' ').trim() === 'Tumor (10 frames)')?.querySelector('input')`;
      await s.waitFor(`!!${itvTumor}`, '合併好的 Tumor', 20000);
      await sleep(700);
      await s.clickOn(itvTumor, 'ITV：勾 Tumor');
      await sleep(400);
      await s.clickOn(s.button('Create ITV', dlg), 'Create ITV');
      await s.waitFor(`${dlg}.innerText.includes('Created')`, 'ITV 建好', 20000);
      await sleep(900);
      await s.clickOn(s.button('Close', dlg), 'Close');
      await sleep(400);
      rec.cue('The ITV covers the tumor in every phase');
      await s.clickOn(play, 'Play');
      await s.moveTo(cor.left + cor.w * 0.92, cor.top + cor.h * 0.5, 500);
      await sleep(2800);
      await s.clickOn(play, 'Pause');
      await sleep(500);
    },
  },
  {
    id: 'plan',
    async setup(s, ctx) {
      await openCase(s, ctx, PROTEAS);
      await setLayout(s, '1×1 axial');
      await setCellContent(s, `[...document.querySelectorAll('.viewport-cell')][0]`, 'act:split-row');
      await setCellContent(s, `[...document.querySelectorAll('.viewport-cell')][1]`, 'panel:plan.bev');
      // BEV 的投影輪廓只留靶區與附近的危及器官（BODY 投影是一大片雜線）
      await onlyStructures(s, /^(PTV|BrainStem|OpticNerve|Eye_)/);
      // 計畫面板先收起來，錄影時再開
      await s.evaluate(`(() => { const b = ${s.button('Plans')}; if (b?.getAttribute('aria-pressed') === 'true') b.click(); return true; })()`);
      await sleep(1500);
      await s.moveTo(1500, 520, 300);
    },
    async run(s, rec) {
      const play = `[...(${BEV_CELL}).querySelectorAll('button')].find((b) => /^(Play|Pause)/.test(b.title))`;
      rec.cue('Plans: prescription, beams and the isocenter, with arcs drawn on the images');
      await s.clickOn(s.button('Plans'), 'Plans');
      await sleep(1200);
      await s.clickOn(s.button('Go to ISO'), 'Go to ISO');
      await sleep(1800);
      rec.cue("Beam's-eye view: the MLC aperture over a DRR, control point by control point");
      await s.clickOn(play, 'BEV Play');
      await sleep(4400);
      await s.clickOn(play, 'BEV Pause');
      await sleep(400);
      rec.cue('Non-coplanar arcs: the gantry sketch follows the gantry and the couch');
      await chooseOption(s, `(${BEV_CELL}).querySelector('select')`, '3');
      await s.clickOn(play, 'BEV Play');
      await sleep(3800);
      await s.clickOn(play, 'BEV Pause');
      await sleep(500);
    },
  },
  {
    id: '3d',
    async setup(s, ctx) {
      const open = await s.evaluate(`location.hash.includes('viewer') && document.body.innerText.includes('Pancreas-CT-CB_014')`);
      if (!open) await openCase(s, ctx, PANCREAS);
      await showDose(s, true);
      await setLayout(s, '1×1 axial');
      await setCellContent(s, `[...document.querySelectorAll('.viewport-cell')][0]`, 'vp:3d');
      // 不顯示結構：有結構表面時，拖曳中的預覽只畫表面（刻意的設計，省時間），錄起來像 CT 一轉就不見
      await onlyStructures(s, /^$/);
      // 3D 面板：沒有裁切、CT-Bone（探路或重錄時改過的話），然後收起來；相機回正面、往前推一點
      await s.evaluate(`(() => { const b = ${s.button('3D')}; if (b?.getAttribute('aria-pressed') !== 'true') b.click(); return true; })()`);
      await sleep(1000);
      await s.evaluate(`(() => { const c = [...document.querySelectorAll('.right-sidebar label')].find((l) => l.textContent.trim() === 'Crop')?.querySelector('input'); if (c?.checked) c.click(); return true; })()`);
      await s.evaluate(`(() => {
        const sel = [...document.querySelectorAll('.right-sidebar select')].find((x) => [...x.options].some((o) => o.textContent.trim() === 'CT-Bone'));
        const opt = [...sel.options].find((o) => o.textContent.trim() === 'CT-Bone');
        if (sel.value !== opt.value) { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value); sel.dispatchEvent(new Event('change', { bubbles: true })); }
        return true;
      })()`);
      await sleep(800);
      await s.evaluate(`(${s.button('3D')}).click(); true`);
      await sleep(800);
      await s.evaluate(`(${s.button('Front')})?.click(); true`);
      await sleep(1500);
      const c = await s.box(`[...document.querySelectorAll('.viewport-cell')][0]`);
      s.xdo('mousemove', Math.round(c.x), Math.round(c.y));
      for (let i = 0; i < 4; i += 1) {
        s.xdo('click', 4);
        await sleep(200);
      }
      await sleep(3000);
      await s.moveTo(c.x + c.w * 0.42, c.y - c.h * 0.3, 300);
    },
    async run(s, rec) {
      const c = await s.box(`[...document.querySelectorAll('.viewport-cell')][0]`);
      rec.cue('3D volume rendering on the server GPU, with the dose');
      const orbit = (dx, dy, n) => Array.from({ length: n + 1 }, (_, i) => [c.x - dx / 2 + (dx * i) / n, c.y - dy / 2 + (dy * i) / n]);
      await s.drag(orbit(420, 0, 90), { stepMs: 28 });
      await sleep(900);
      await s.drag(orbit(0, -160, 40), { stepMs: 28 });
      await sleep(1100);
      rec.cue('Presets and transfer functions');
      await s.clickOn(s.button('3D'), '3D 面板');
      await sleep(700);
      await chooseOption(s, `[...document.querySelectorAll('.right-sidebar select')].find((x) => [...x.options].some((o) => o.textContent.trim() === 'CT-Muscle'))`, 'CT-Muscle');
      // 停在這個角度（再轉的話鏡頭貼著皮膚，只剩一片表面）
      await s.moveTo(c.x + c.w * 0.3, c.y + c.h * 0.32, 500);
      await sleep(2600);
    },
  },
  {
    id: 'plugin',
    async setup(s, ctx) {
      await ensureUser(s, ctx, 'physicist');
      const open = await s.evaluate(`location.hash.includes('viewer') && document.body.innerText.includes('Pancreas-CT-CB_014')`);
      if (!open) await openCase(s, ctx, PANCREAS);
      await showDose(s, false);
      // 軸向｜冠狀並排：器官輪廓一次看兩個方向
      await setLayout(s, '1×1 axial');
      await setCellContent(s, `[...document.querySelectorAll('.viewport-cell')][0]`, 'act:split-row');
      await setCellContent(s, `[...document.querySelectorAll('.viewport-cell')][1]`, 'vp:coronal');
      for (const c of ['Axial', 'Coronal']) {
        await s.evaluate(`(${s.button('Fit', cell(c))})?.click(); true`);
        await sleep(300);
        const b = await s.box(cell(c));
        s.xdo('mousemove', Math.round(b.x), Math.round(b.y));
        await holding(s, 'Control_L', () => s.wheel(-3, { delay: 80 }));
      }
      await onlyStructures(s, /^$/);
      // 3D 那一幕留下的 3D 設定面板收起來
      await s.evaluate(`(() => { const b = ${s.button('3D')}; if (b?.getAttribute('aria-pressed') === 'true') b.click(); return true; })()`);
      // plugin 面板先關掉（Plugins 選單的項目是開關）
      if (await s.evaluate(`!!${NNUNET}`)) {
        await s.evaluate(`${PLUGINS_BUTTON}.click(); true`);
        await sleep(500);
        await s.evaluate(`${NNUNET_ITEM}.click(); true`);
        await sleep(800);
      }
      await s.moveTo(1500, 520, 300);
    },
    async run(s, rec) {
      rec.cue('Plugins: AI auto-contouring with nnU-Net / TotalSegmentator on the GPU');
      await s.clickOn(PLUGINS_BUTTON, 'Plugins');
      await sleep(700);
      await s.clickOn(NNUNET_ITEM, 'AI contouring');
      await s.waitFor(`!!${NNUNET}`, 'nnU-Net 面板');
      await sleep(1200);
      const row = (name) => `[...${NNUNET}.querySelectorAll('.nnunet-rois li')].find((li) => li.innerText.trim().split(/\\s/)[0] === ${JSON.stringify(name)})?.querySelector('input')`;
      const search = `${NNUNET}.querySelector('input[placeholder]')`;
      for (const [q, names] of [['liver', ['liver']], ['kidney', ['kidney_left', 'kidney_right']], ['pancreas', ['pancreas']]]) {
        await typeInto(s, search, q, `搜尋 ${q}`);
        await sleep(300);
        for (const n of names) await s.clickOn(row(n), n, { hover: 120 });
        await sleep(250);
      }
      await typeInto(s, search, '', '清掉搜尋');
      await sleep(400);
      await s.clickOn(`${NNUNET}.querySelector('button.nnunet-run')`, 'Run');
      // 推論的等待時間在成片裡加速（render.mjs 讀 fast 標記）
      rec.mark('fast', 'begin');
      await s.waitFor(`/^(Done|Failed)/.test(${NNUNET}.querySelector('.nnunet-job')?.textContent ?? '')`, '推論完成', 600000);
      rec.mark('fast', 'end');
      if (await s.evaluate(`/^Failed/.test(${NNUNET}.querySelector('.nnunet-job').textContent)`)) throw new Error('推論失敗');
      rec.cue('Results arrive as AI-generated structures; review them, then save them to your work set');
      await sleep(1200);
      await s.moveTo(560, 640, 700);
      await sleep(2600);
      // 「Save」：plugin 結果（暫存集）進我的工作集 —— 不存的話，之後換頁會跳「有未保存的 plugin 結果」確認框
      const save = `[...document.querySelectorAll('.structure-sets button')].find((b) => b.textContent.trim() === 'Save')`;
      await s.clickOn(save, 'Save');
      await s.waitFor(`!${save}`, 'plugin 結果存好', 30000);
      await sleep(1800);
    },
  },
  {
    id: 'phone',
    // 手機：另一個螢幕（412×860 CSS、DPR 1.2、觸控模擬；滑鼠轉成觸控）；render.mjs 把它放在畫面中間
    screen: { width: 494, height: 1032, scale: 1.2, user: 'physicist', emulate: { width: 412, height: 860, deviceScaleFactor: 1.2 } },
    async setup(s, ctx) {
      await s.send('Page.navigate', { url: `${ctx.FE}/#/library` });
      await s.waitFor(`document.querySelectorAll('.catalog-tree tr[data-kind="patient"]').length >= 1`, '手機資料頁', 60000);
      await sleep(600);
      // 手機的資料頁：點病人 → study 列的「Open」（自動挑主要影像、帶進結構與劑量）
      if (!(await s.evaluate(`!!${rowWith('study', 'UPPER GI')}`))) await s.evaluate(`${rowWith('patient', 'Pancreas-CT-CB_014')}.click(); true`);
      await s.waitFor(`!!${rowWith('study', 'UPPER GI')}`, 'study 列');
      await s.evaluate(`(${s.button('Open', rowWith('study', 'UPPER GI'))}).click(); true`);
      await s.waitFor(`location.hash.includes('viewer') && document.querySelectorAll('.viewport-cell canvas').length >= 1`, '手機檢視器', 180000);
      await s.waitFor(`!document.querySelector('.mask-loading')`, '結構載入完', 120000);
      await sleep(2500);
      await s.moveTo(380, 300, 200);
    },
    async run(s, rec) {
      const tab = (name) => `document.querySelector('.phone-tabbar button[data-tab="${name}"]')`;
      const view = (label) => s.button(label, `document.querySelector('.phone-views') ?? document`);
      rec.cue('On a phone: the same case, one view at a time');
      const c = await s.box(`document.querySelector('.viewport-cell')`);
      // 一指上下拖曳換切片（觸控模擬）
      const swipe = (dy) => Array.from({ length: 21 }, (_, i) => [c.x + 40, c.y + (dy * i) / 20]);
      await s.drag(swipe(-140), { stepMs: 30 });
      await sleep(500);
      await s.drag(swipe(90), { stepMs: 30 });
      await sleep(900);
      await s.clickOn(view('Cor'), 'Cor');
      await sleep(1800);
      rec.cue('Tabs open the data, contouring, review and DVH panels');
      await s.clickOn(tab('data'), 'Data');
      await sleep(2000);
      await s.clickOn(tab('dvh'), 'DVH');
      await sleep(2600);
    },
  },
  {
    id: 'review',
    async setup(s, ctx) {
      // 簽核要 approver：換成 oncologist 的 session（同一個 Chrome，換 cookie 重新載入）
      await signInAs(s, ctx, 'oncologist');
      await openCase(s, ctx, PANCREAS);
      await showDose(s, false);
      await setLayout(s, '1×1 axial');
      await goToSlice(s, 'Axial', CANAL.first + 3);
      const p = await locateVoxel(s, 'Axial', CANAL.voxel);
      await s.moveTo(p.x, p.y, 200);
      await holding(s, 'Control_L', () => s.wheel(-6, { delay: 60 }));
      await sleep(800);
      for (const task of ['Review', 'Export']) {
        await s.evaluate(`(() => { const b = ${s.button(task)}; if (b?.getAttribute('aria-pressed') === 'true') b.click(); return true; })()`);
      }
      await sleep(600);
      await s.moveTo(p.x + 420, p.y - 260, 300);
    },
    async run(s, rec) {
      const REVIEW = `document.querySelector('.review-panel')`;
      rec.cue('Review: an approver signs off structures, with a note in the audit trail');
      await s.clickOn(s.button('Review'), 'Review');
      await s.waitFor(`!!${REVIEW}`, 'Review 面板');
      await sleep(900);
      await s.clickOn(`[...${REVIEW}.querySelectorAll('li')].find((li) => li.innerText.includes('SpinalCord'))?.querySelector('input')`, 'SpinalCord 勾選');
      await sleep(500);
      await s.clickOn(`${REVIEW}.querySelector('.review-actions input')`, '備註');
      await s.type('Checked on all slices', { delay: 55 });
      await sleep(400);
      await s.clickOn(`${REVIEW}.querySelector('.review-actions button.ok')`, 'Approve');
      await s.waitFor(`!!${REVIEW}.querySelector('.review-group.status-approved')`, '簽核完成', 20000);
      await sleep(1800);
      rec.cue('Export an RTSTRUCT adapted to the TPS (here the Varian Eclipse profile)');
      await s.clickOn(s.button('Export'), 'Export');
      await sleep(1200);
      await s.clickOn(`[...document.querySelectorAll('.right-sidebar button')].find((b) => b.textContent.trim().startsWith('Generate and'))`, 'Generate');
      await s.waitFor(`[...document.querySelectorAll('.right-sidebar a, .right-sidebar button')].some((b) => b.textContent.includes('Download'))`, '匯出完成', 60000);
      await sleep(2800);
    },
  },
  {
    id: 'dose',
    async setup(s, ctx) {
      const open = await s.evaluate(`location.hash.includes('viewer') && document.body.innerText.includes('Eclipse Doses')`);
      if (!open) await openCase(s, ctx, PANCREAS);
      await setLayout(s, '2×2');
      // 勾畫那一幕留下的：ROI 編輯面板、軸向格放大 → 收起來、各格 Fit（Fit 不換切片）
      await s.evaluate(`(() => { const b = ${s.button('ROI editing')}; if (b?.getAttribute('aria-pressed') === 'true') b.click(); return true; })()`);
      for (const c of ['Axial', 'Coronal', 'Sagittal']) await s.evaluate(`(${s.button('Fit', cell(c))})?.click(); true`);
      await sleep(800);
      // 劑量列的設定（門檻在裡面）預設收起來
      await s.evaluate(`(() => { const r = document.querySelector('.dose-row'); if (r && r.dataset.expanded !== 'true') r.querySelector('button.row-more')?.click(); return true; })()`);
      await sleep(600);
      // colorwash 門檻調到 20 Gy：低劑量區不要蓋滿整張影像
      const ok = await s.evaluate(`(() => {
        const label = [...document.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith('Threshold') && l.querySelector('input[type=number]'));
        const input = label?.querySelector('input[type=number]');
        if (!input) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '20');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      if (!ok) throw new Error('找不到劑量的 Threshold 欄位');
      // 前幾幕把劑量藏起來了；錄影時在劑量列勾回來
      await showDose(s, false);
      await sleep(1500);
    },
    async run(s, rec) {
      rec.cue('Dose as colorwash and isodose lines, with a legend in every view');
      await s.clickOn(`document.querySelector('.dose-row label.visibility input')`, '顯示劑量');
      await sleep(900);
      const axial = await s.box(cell('Axial'));
      await s.moveTo(axial.x, axial.y - 10);
      await sleep(1800);
      rec.cue('Jump to the maximum dose');
      await s.clickOn(s.button('Go to Dmax'), 'Go to Dmax');
      await sleep(2200);
      rec.cue('Dose-volume histograms with D98, D95, D50, D2 and V(ref)');
      await chooseLayout(s, 'Dose review (axial + coronal + DVH)');
      await s.waitFor(`[...document.querySelectorAll('.viewport-cell')].some((c) => c.innerText.includes('Stomach_duo_planCT'))`, 'DVH 格', 60000);
      await sleep(2500);
      const row = `[...document.querySelectorAll('.viewport-cell tr')].find((r) => r.innerText.trim().startsWith('ROI'))`;
      await s.clickOn(row, 'DVH ROI 列');
      await sleep(2500);
    },
  },
  {
    id: 'fusion',
    async setup(s, ctx) {
      await openCase(s, ctx, { patient: 'CCTH-A06', study: 'PET2', images: ['CT 2.5MM STD', 'FDG 3D SUV'] });
      await setLayout(s, '2×2');
      // PET 先藏起來，錄影時再勾
      await s.evaluate(`(() => { const c = (${PET_ROW})?.querySelector('input[type=checkbox]'); if (c?.checked) c.click(); return true; })()`);
      await sleep(1500);
    },
    async run(s, rec) {
      rec.cue('PET and CT in one space');
      await s.clickOn(`(${PET_ROW}).querySelector('input[type=checkbox]')`, 'PET 顯示');
      await sleep(1500);
      await s.clickOn(`(${PET_ROW}).querySelector('button.row-more')`, 'PET 設定');
      await sleep(600);
      await chooseOption(s, `(${PET_ROW}).querySelector('.colormap select')`, 'warm');
      await sleep(1200);
      rec.cue('PET is read out in SUV');
      const axial = await s.box(cell('Axial'));
      await s.moveTo(axial.x - 70 * s.scale / 1.25, axial.y + 46 * s.scale / 1.25, 700);
      await sleep(2600);
    },
  },
];

/** 成片的順序（各幕在上面依寫的時間排，這裡排成看的順序）。 */
const ORDER = ['library', 'viewer', 'contour', 'dose', 'fusion', '4d', 'plan', '3d', 'plugin', 'review', 'phone'];
SCENES.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

/** 探路與 dry run 用（量位置、試選擇器）；錄影本身只用 SCENES。 */
export const helpers = { rowWith, cell, SEARCH, freshLibrary, openCase, waitViewer, holding, chooseOption, chooseLayout, setLayout, showDose, sliceOf, goToSlice, readIjk, locateVoxel, typeInto, setRange, setCellContent, shiftClick, onlyStructures, PET_ROW, PANCREAS, CANAL, LUNG4D, PROTEAS, BEV_CELL, signInAs, ensureUser };
