#!/usr/bin/env node
/**
 * 手機檢視器、觸控編輯 ROI、手機簽核 —— Android 手機 412×915 觸控模擬。
 *
 *   版面：一格影像佔畫面大部分、沒有桌面工具列與側欄；方位切換（軸／冠／矢）；一指換切片；分頁 → 抽屜（資料、更多）；
 *      手機沒有的功能在「更多」裡說明；橫拿：標頭收起、抽屜在右半邊
 *   編輯：ROI 分頁新建結構 →「編輯對象」選上 → 收起抽屜 → 工具列選筆刷、調半徑 → 一指畫一筆（畫的時候有放大鏡）→
 *      復原／重做；圈選：點三個頂點 →「完成」收口（undo +1）；點兩下也能收口
 *   簽核：簽核分頁 → 勾結構 → 核可 → 事件寫著「（在手機上）」
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-phone-viewer.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR]
 *   node scripts/verify-phone-viewer.mjs --url http://<dev>/#/library --readonly true   # 開發環境：只驗版面與看，不新建、不畫、不簽核
 */
import { checklist, launch, openSynth4d, parseArgs, sleep } from './lib/cdp.mjs';

const args = parseArgs();
const b = await launch({ url: args.url ?? 'http://127.0.0.1:5183/#/library', outDir: args['out-dir'] ?? null, port: Number(args.port ?? 9365) });
const c = checklist();
const NAME = 'PhoneV19';
const readonly = args.readonly === 'true';

await openSynth4d(b);
const d = await b.device('phone');
await b.send('Page.navigate', { url: `${b.origin}/?pv=1#/viewer` });
await b.waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 1 && !!document.querySelector('.phone-tabbar')`, '手機檢視器', 120000);
await sleep(2500);

// ── 版面 ──
const g = await b.evaluate(`(() => {
  const cells = [...document.querySelectorAll('.viewport-cell')].filter((x) => x.getBoundingClientRect().width > 0);
  const r = cells[0]?.getBoundingClientRect();
  return { cells: cells.length, w: r?.width ?? 0, h: r?.height ?? 0, taskbar: !!document.querySelector('.task-bar'), sidebar: !!document.querySelector('.sidebar'), scrollW: document.documentElement.scrollWidth, tabs: [...document.querySelectorAll('.phone-tabbar button')].map((x) => x.dataset.tab) };
})()`);
c.check('一次一格', g.cells === 1, `${g.cells} 格`);
c.check('影像格佔畫面大部分（寬滿、高 ≥ 50%）', g.w >= d.width - 4 && g.h >= d.height * 0.5, `${Math.round(g.w)}×${Math.round(g.h)}`);
c.check('沒有桌面工具列與側欄', !g.taskbar && !g.sidebar);
c.check('不橫向溢出', g.scrollW <= d.width + 1, String(g.scrollW));
c.check('分頁：資料、ROI、簽核、DVH、計畫、更多', ['data', 'roi', 'review', 'dvh', 'more'].every((x) => g.tabs.includes(x)), g.tabs.join(','));

const label = () => b.evaluate(`document.querySelector('.viewport-cell .viewport-label')?.textContent.trim() ?? ''`);
const slice = () => b.evaluate(`document.querySelector('.viewport-cell .viewport-slice')?.textContent.trim() ?? ''`);
await b.clickButton(`document.querySelector('.phone-views')`, '冠');
await sleep(1200);
c.check('方位切換 → 冠狀', (await label()) === '冠狀', await label());
await b.clickButton(`document.querySelector('.phone-views')`, '軸');
await sleep(1200);
c.check('方位切回軸向', (await label()) === '軸向', await label());
const host = await b.centerOf(`document.querySelector('.viewport-cell .viewport-canvas-host')`);
const s0 = await slice();
await b.touch.drag([[host.x, host.y - 50], [host.x, host.y - 10], [host.x, host.y + 30], [host.x, host.y + 70]], { hold: 30 });
c.check('一指拖曳換切片', (await slice()) !== s0, `${s0} → ${await slice()}`);

// 調窗：用真的觸控點按鈕（不是 element.click()），而且是在影像上拖曳之後點 —— 實機上發生過：拖完影像去點「調窗」關掉，
// 那一下被 Chrome 當成停住慣性滑動吞掉，調窗其實沒關，之後一指拖曳一直在調窗、換不了切片
const wlBtn = `[...document.querySelectorAll('.phone-viewbar .touch-controls button')].find((x) => x.textContent.trim() === '調窗')`;
const tapWl = async () => {
  const p = await b.centerOf(wlBtn);
  await b.touch.tap(p.x, p.y);
  await sleep(400);
  return b.evaluate(`${wlBtn}.getAttribute('aria-pressed') === 'true'`);
};
const dragUp = () => b.touch.drag([[host.x, host.y + 40], [host.x, host.y], [host.x, host.y - 40]], { hold: 30 });
await dragUp();
c.check('拖曳影像後，點「調窗」→ 打開', (await tapWl()) === true);
const sw = await slice();
await dragUp();
c.check('調窗開著：一指拖曳不換切片', (await slice()) === sw, `${sw} → ${await slice()}`);
c.check('調窗模式拖曳後，點「調窗」→ 關掉', (await tapWl()) === false);
const sw2 = await slice();
await dragUp();
c.check('關掉調窗後一指拖曳又能換切片', (await slice()) !== sw2, `${sw2} → ${await slice()}`);

const tab = async (name) => {
  await b.evaluate(`document.querySelector('.phone-tabbar button[data-tab="${name}"]').click(); true`);
  await sleep(700);
};
await tab('data');
c.check('「資料」→ 抽屜放資料面板', await b.evaluate(`!!document.querySelector('.phone-sheet[data-tab="data"] [data-panel-id="core.data"]')`));
await tab('data');
c.check('再按一次 → 抽屜收起', await b.evaluate(`!document.querySelector('.phone-sheet[data-tab="data"]')`));
await tab('more');
const moreText = await b.evaluate(`document.querySelector('.phone-more')?.textContent ?? ''`);
c.check('「更多」列出手機上沒有的功能', moreText.includes('電腦或平板') && moreText.includes('量測') && moreText.includes('匯出'), moreText.slice(0, 60));
c.check('「更多」有病例（資料庫…／關閉病例）', moreText.includes('資料庫…'));
await b.shot('phone-viewer-more.png');
await tab('more');

if (!readonly) {
// ── 編輯 ──
await tab('roi');
c.check('「ROI」→ 抽屜放 ROI 編輯、有「編輯對象」', await b.evaluate(`!!document.querySelector('.phone-sheet [data-panel-id="roi.panel"]') && !!document.querySelector('.phone-structure-picker select')`));
await b.evaluate(`[...document.querySelectorAll('.phone-sheet .roi-panel button')].find((x) => x.textContent.trim() === '新建').click(); true`);
await b.waitFor(`!!document.querySelector('.roi-create .roi-name')`, '新建欄位');
await b.evaluate(`(() => { const i = document.querySelector('.roi-create .roi-name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(NAME)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
// 名稱寫進去、「建立」可以按了才按（太快按到的是停用的按鈕，什麼都不會建 —— 偶發失敗的原因）
await b.waitFor(`!![...document.querySelectorAll('.roi-create button')].find((x) => x.textContent.trim() === '建立' && !x.disabled)`, '「建立」可以按', 10000);
await b.evaluate(`[...document.querySelectorAll('.roi-create button')].find((x) => x.textContent.trim() === '建立').click(); true`);
await b.waitFor(`[...document.querySelectorAll('.phone-structure-picker option')].some((o) => o.selected && o.textContent.includes(${JSON.stringify(NAME)}))`, '新結構成為編輯對象', 30000);
c.check('新建 → 自動成為編輯對象', true);
await b.evaluate(`[...document.querySelectorAll('.phone-sheet-header button')].find((x) => x.textContent.includes('收起')).click(); true`);
await sleep(400);
c.check('收起抽屜後 ROI 工具列還在', await b.evaluate(`!!document.querySelector('.phone-toolrow .toolbar')`));
const toolBtn = (name) => `[...document.querySelectorAll('.phone-toolrow .toolbar button')].find((x) => x.textContent.includes(${JSON.stringify(name)}) && !(${JSON.stringify(name)} === '筆刷' && x.textContent.includes('閾值')))`;
await b.waitFor(`${toolBtn('筆刷')} && !${toolBtn('筆刷')}.disabled`, '筆刷可以用', 30000);
await b.evaluate(`${toolBtn('筆刷')}.click(); true`);
await sleep(300);
c.check('選筆刷 → 工具列出現半徑', await b.evaluate(`!!document.querySelector('.phone-radius input')`));
await b.evaluate(`(() => { const i = document.querySelector('.phone-radius input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '8'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await sleep(200);
c.check('半徑滑桿 → 8.0 mm', (await b.evaluate(`document.querySelector('.phone-radius span')?.textContent ?? ''`)).includes('8.0'));
const depth = async () => Number(((await b.evaluate(`document.querySelector('.phone-toolrow .edit-controls')?.textContent ?? ''`)).match(/(\d+)\s*筆/) ?? [])[1] ?? -1);
const d0 = await depth();
// 手勢中途看放大鏡
const path = [[host.x - 40, host.y], [host.x - 20, host.y + 4], [host.x, host.y + 8], [host.x + 20, host.y + 8], [host.x + 40, host.y + 4]];
await b.touch.raw('touchStart', [path[0]]);
await sleep(150);
for (const p of path.slice(1)) {
  await b.touch.raw('touchMove', [p]);
  await sleep(20);
}
const loupe = await b.evaluate(`(() => { const l = document.querySelector('.viewport-cell .touch-loupe'); if (!l) return null; const r = l.getBoundingClientRect(); return { shown: getComputedStyle(l).display !== 'none', w: r.width }; })()`);
await b.touch.raw('touchEnd', []);
await sleep(500);
c.check('手指畫的時候有放大鏡', loupe?.shown === true && loupe.w > 100, JSON.stringify(loupe));
c.check('放開後放大鏡收起', await b.evaluate(`(() => { const l = document.querySelector('.viewport-cell .touch-loupe'); return !l || getComputedStyle(l).display === 'none'; })()`));
const d1 = await depth();
c.check('一指畫一筆（undo +1）', d1 === d0 + 1, `${d0} → ${d1}`);
await b.clickButton(`document.querySelector('.phone-toolrow')`, '復原');
await sleep(400);
c.check('工具列「復原」', (await depth()) === d0, `undo ${await depth()}`);
await b.clickButton(`document.querySelector('.phone-toolrow')`, '重做');
await sleep(400);
c.check('工具列「重做」', (await depth()) === d1, `undo ${await depth()}`);

// 圈選：點三個頂點 →「完成」
await b.evaluate(`${toolBtn('圈選')}.click(); true`);
await sleep(300);
c.check('選圈選 →「完成／取消」出現在影像上方', await b.evaluate(`[...document.querySelectorAll('.phone-viewbar .touch-controls button')].some((x) => x.textContent.trim() === '完成')`));
for (const [x, y] of [[host.x - 50, host.y - 60], [host.x + 50, host.y - 60], [host.x, host.y - 10]]) {
  await b.touch.tap(x, y);
  await sleep(450); // 分開成兩次點擊，不要被當成點兩下
}
await b.clickButton(`document.querySelector('.phone-viewbar .touch-controls')`, '完成');
await sleep(600);
const d2 = await depth();
c.check('圈選三個頂點 →「完成」收口（undo +1）', d2 === d1 + 1, `${d1} → ${d2}`);
// 點兩下收口（第二下直接接著送，CI 的機器慢也落在 350 ms 內）
for (const [x, y] of [[host.x - 40, host.y + 50], [host.x + 40, host.y + 50]]) {
  await b.touch.tap(x, y);
  await sleep(450);
}
for (let i = 0; i < 2; i += 1) {
  await b.touch.raw('touchStart', [[host.x, host.y + 100]]);
  await b.touch.raw('touchEnd', []);
  await sleep(40);
}
await sleep(700);
c.check('圈選點兩下收口（undo +1）', (await depth()) === d2 + 1, `${d2} → ${await depth()}`);
await b.shot('phone-viewer-edit.png');

// ── 簽核 ──
await tab('review');
c.check('「簽核」→ 抽屜放簽核面板', await b.evaluate(`!!document.querySelector('.phone-sheet [data-panel-id="review.panel"]')`));
c.check('ROI 工具列跟著收起（簽核與 ROI 編輯互斥）', await b.evaluate(`!document.querySelector('.phone-toolrow')`));
const ok = await b.evaluate(`(() => { const li = [...document.querySelectorAll('.phone-sheet .review-panel label, .phone-sheet .review-panel li')].find((x) => x.textContent.includes(${JSON.stringify(NAME)}) && x.querySelector('input[type=checkbox]')); if (!li) return false; li.querySelector('input[type=checkbox]').click(); return true; })()`);
c.check('勾得到新結構', ok);
await sleep(300);
await b.evaluate(`[...document.querySelectorAll('.phone-sheet .review-actions button')].find((x) => x.textContent.startsWith('核可')).click(); true`);
await b.waitFor(`(document.querySelector('.phone-sheet .review-events')?.textContent ?? '').includes('（在手機上）')`, '簽核事件寫著在手機上', 20000).then(
  () => c.check('核可 → 事件寫著「（在手機上）」', true),
  () => c.check('核可 → 事件寫著「（在手機上）」', false),
);
await b.shot('phone-viewer-review.png');
// 重新開啟（之後才刪得掉）
await b.evaluate(`(() => { const li = [...document.querySelectorAll('.phone-sheet .review-panel label, .phone-sheet .review-panel li')].find((x) => x.textContent.includes(${JSON.stringify(NAME)}) && x.querySelector('input[type=checkbox]')); if (li && !li.querySelector('input').checked) li.querySelector('input').click(); return true; })()`);
await sleep(200);
await b.evaluate(`[...document.querySelectorAll('.phone-sheet .review-actions button')].find((x) => x.textContent.startsWith('重新開啟'))?.click(); true`);
await sleep(1500);
await tab('review');
}

// ── 橫拿 ──
await b.device('phone-landscape');
await sleep(1500);
const land = await b.evaluate(`(() => { const h = document.querySelector('.app-phone .app-header'); const cell = document.querySelector('.viewport-cell').getBoundingClientRect(); return { header: h ? getComputedStyle(h).display : 'none', cellH: cell.height, cellW: cell.width }; })()`);
c.check('橫拿：標頭收起', land.header === 'none');
c.check('橫拿：影像格夠高（≥ 150 px）', land.cellH >= 150, `${Math.round(land.cellW)}×${Math.round(land.cellH)}`);
await tab('data');
const sheet = await b.evaluate(`(() => { const r = document.querySelector('.phone-sheet[data-tab="data"]').getBoundingClientRect(); return { left: r.left, w: r.width }; })()`);
c.check('橫拿：抽屜在右半邊', sheet.left > 300 && sheet.w < 600, `${Math.round(sheet.left)} / ${Math.round(sheet.w)}`);
await b.shot('phone-viewer-landscape.png');
await tab('data');

// 左上品牌選單 → 資料庫（手機實測過：標頭 overflow: hidden 把下拉整個裁掉，進了檢視器回不去）
await b.device('phone');
await sleep(1200);
const brand = await b.centerOf(`document.querySelector('.app-header .brand-button')`);
await b.touch.tap(brand.x, brand.y);
await sleep(500);
const menu = await b.evaluate(`(() => { const m = document.querySelector('.brand-dropdown'); if (!m) return { ok: false, why: '沒有下拉' }; const r = m.getBoundingClientRect(); const a = [...m.querySelectorAll('a')].find((x) => x.textContent.includes('資料庫')); const ar = a.getBoundingClientRect(); const hit = document.elementFromPoint(ar.left + ar.width / 2, ar.top + ar.height / 2); return { ok: r.left >= 0 && r.right <= innerWidth && ar.top >= 0 && a.contains(hit), x: ar.left + ar.width / 2, y: ar.top + ar.height / 2, why: JSON.stringify([r.left, r.top, r.width].map(Math.round)) }; })()`);
c.check('左上選單在畫面內、「資料庫」點得到', menu.ok, menu.why);
if (menu.ok) {
  await b.touch.tap(menu.x, menu.y);
  await b.waitFor(`location.hash.includes('library')`, '回到資料庫頁', 10000).then(
    () => c.check('左上選單 →「資料庫」回到資料庫頁', true),
    () => c.check('左上選單 →「資料庫」回到資料庫頁', false),
  );
}

// 收尾：刪掉測試結構（唯讀模式什麼都沒建）
if (!readonly) await b.evaluate(`(async () => { const r = await fetch('/api/v1/sessions/current').then((x) => x.json()); const list = await fetch('/api/v1/studies/' + encodeURIComponent(r.studyId) + '/structures').then((x) => x.json()); const rows = Array.isArray(list) ? list : list.structures ?? []; for (const s of rows.filter((x) => x.name === ${JSON.stringify(NAME)})) await fetch('/api/v1/structures/' + s.structure_id, { method: 'DELETE' }); return true; })()`).catch(() => undefined);
c.check('沒有頁面例外', b.errors.length === 0, b.errors.slice(0, 2).join(' | '));
const failed = c.report();
b.close();
process.exit(failed === 0 ? 0 : 1);
