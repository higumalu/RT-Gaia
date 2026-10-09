#!/usr/bin/env node
/**
 * 錄 demo 時查到的介面問題 —— headless Chrome ＋ CDP（`scripts/lib/cdp.mjs`），英文介面，`data/demo/` 的真實病例：
 *
 *   Pancreas-CT-CB_014（1×1 軸向）：
 *     • Fit 不換切片（以前跳回中間那張）
 *     • Shift＋點移動十字線後把這一格換成冠狀：冠狀切面穿過十字線（以前回到體積中心）
 *     • 這個病例第一次建結構：清單直接歸在「…'s structure set」（以前先放進「Other (no source structure set)」要重新整理）
 *     • 複製結構的預設名稱跟介面語言（「… copy」，以前英文介面也存成「… 複本」）
 *     • 簽核面板的結構集名稱依介面語言（以前「physicist 的結構集」）
 *   Pancreas（2×2，轉一下 3D）→ 換開 113_HM10395 的 4D 組：3D 格不是全黑（以前沿用上一個病例的 3D 相機）
 *   RPRO29（計畫）：BEV 的射束選單有焦點時按 ↓ 換的是射束，不是控制點
 *   資料頁：RPRO29 那一列是「1 image」（以前「1 images」）
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-demo-ui-fixes.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR] [--token <rtgaia_session>]
 * 退出碼：任一項失敗 → 1。
 */
import { checklist, launch, parseArgs, rowWith, sleep } from './lib/cdp.mjs';

const args = parseArgs();
const url = new URL(args.url ?? 'http://127.0.0.1:5183/#/library');
url.searchParams.set('lang', 'en');
const b = await launch({ url: url.toString(), outDir: args['out-dir'] ?? null, port: Number(args.port ?? 9366), token: args.token ?? process.env.TOKEN ?? null });
const c = checklist();
const { evaluate, send, waitFor } = b;

await send('Page.addScriptToEvaluateOnNewDocument', {
  source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.lang', 'en'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}",
});
await send('Page.navigate', { url: url.toString() });

const cell = (label) => `[...document.querySelectorAll('.viewport-cell')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(label)}))`;
const sliceOf = (label) => evaluate(`Number((${cell(label)})?.innerText.match(/(\\d+) \\/ \\d+/)?.[1])`);
const button = (text, scope = 'document') => `[...(${scope}).querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && x.getBoundingClientRect().width > 0)`;
const click = (expr) => evaluate(`(() => { const e = ${expr}; if (!e) return false; e.click(); return true; })()`);
const setSelect = (expr, value) =>
  evaluate(`(() => { const s = ${expr}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const setInput = (expr, value) =>
  evaluate(`(() => { const i = ${expr}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
const center = (expr) => evaluate(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
const ijkAt = async (x, y) => {
  await mouse('mouseMoved', x, y, { button: 'none' });
  await sleep(300);
  const m = (await evaluate(`document.querySelector('.probe-ijk')?.textContent ?? ''`)).match(/\((\d+), (\d+), (\d+)\)/);
  return m ? { i: Number(m[1]), j: Number(m[2]), k: Number(m[3]) } : null;
};
const wheel = async (x, y, notches) => {
  for (let n = 0; n < Math.abs(notches); n += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: notches > 0 ? 100 : -100 });
    await sleep(80);
  }
};

/** 資料頁 → 病人 → study → 勾影像（或 4D 組）→（勾 RT）→ 開啟。 */
async function openCase({ patient, study, image = null, temporal = null, rt = null }) {
  await send('Page.navigate', { url: `${url.origin}/#/library` });
  await waitFor(`!!${rowWith('patient', patient)}`, `資料頁有 ${patient}`, 60000);
  await click(button('Clear'));
  await sleep(300);
  if (!(await evaluate(`!!${rowWith('study', study)}`))) await click(rowWith('patient', patient));
  await waitFor(`!!${rowWith('study', study)}`, `study ${study}`);
  const first = temporal ? rowWith('temporal', temporal) : rowWith('image', image);
  if (!(await evaluate(`!!${first}`))) await click(rowWith('study', study));
  await waitFor(`!!${first}`, `${temporal ?? image}`);
  await click(`${first}.querySelector('input[type=checkbox]')`);
  await sleep(600);
  if (rt) {
    await setInput(`document.querySelector('input[placeholder^="Search patient ID"]')`, patient);
    await waitFor(`!!${rowWith('rt', rt)}`, `RT ${rt}`);
    await click(`(() => { const c = ${rowWith('rt', rt)}.querySelector('input[type=checkbox]'); return c.checked ? null : c; })()`);
    await sleep(600);
  }
  await waitFor(`document.querySelector('.selection-summary')?.textContent.includes('Primary image')`, '選取有主要影像', 20000);
  await click(button('Open'));
  await waitFor(`location.hash.includes('viewer') && document.querySelectorAll('.viewport-cell canvas, .viewport-cell .render3d-img').length >= 1`, `${patient} 開起來`, 180000);
  await waitFor(`!document.querySelector('.mask-loading')`, '結構載入完', 120000);
  await sleep(1500);
}
async function setLayout(label) {
  await evaluate(`(() => { const s = document.querySelector('.layout-picker select'); const o = [...s.options].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(800);
  await click(button('Reset layout'));
  await sleep(1200);
}
const render3dMax = () =>
  evaluate(`(async () => {
    const img = document.querySelector('.render3d-img');
    if (!img) return -1;
    if (!img.complete || !img.naturalWidth) await new Promise((r) => { img.onload = r; setTimeout(r, 5000); });
    const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, cv.width, cv.height).data; let max = 0;
    for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i] + d[i + 1] + d[i + 2]);
    return max;
  })()`);

// ── 資料頁：單數 ──────────────────────────────────────────────────────────────
await waitFor(`!!${rowWith('patient', 'RPRO29')}`, '資料頁', 60000);
const rpro = await evaluate(`${rowWith('patient', 'RPRO29')}.innerText.replace(/\\s+/g, ' ')`);
c.check('資料頁：「1 image」不是「1 images」', /\b1 image\b/.test(rpro) && !/\b1 images\b/.test(rpro), rpro.slice(0, 80));

// ── Pancreas：Fit、換方位、第一個結構、複製名稱、簽核面板 ─────────────────────
const PANCREAS = { patient: 'Pancreas-CT-CB_014', study: 'UPPER GI', image: 'CTDI' };
await openCase(PANCREAS);
await setLayout('1×1 axial');
const ax = await center(cell('Axial'));
await wheel(ax.x, ax.y, 9);
await sleep(600);
const before = await sliceOf('Axial');
await click(button('Fit', cell('Axial')));
await sleep(800);
c.check('Fit 不換切片', (await sliceOf('Axial')) === before, `${before} → ${await sliceOf('Axial')}`);

// Shift＋點（十字線工具）偏離中心的一點 → 換成冠狀 → 冠狀切面穿過那一點
const target = { x: ax.x + ax.w * 0.18, y: ax.y - ax.h * 0.12 };
const ijk = await ijkAt(target.x, target.y);
await mouse('mousePressed', target.x, target.y, { modifiers: 8 });
await mouse('mouseReleased', target.x, target.y, { modifiers: 8 });
await sleep(600);
await setSelect(`(${cell('Axial')}).querySelector('select.cell-picker')`, 'vp:coronal');
await sleep(1500);
const cor = await sliceOf('Coronal');
c.check('換成冠狀：切面穿過十字線（不是回到中心）', ijk !== null && Math.abs(cor - (ijk.j + 1)) <= 1, `j=${ijk?.j} → Coronal ${cor}`);
await setSelect(`(${cell('Coronal')}).querySelector('select.cell-picker')`, 'vp:axial');
await sleep(1200);

// ROI 編輯：建一個結構 → 清單直接歸在自己的結構集
await click(button('ROI editing'));
await waitFor(`!!document.querySelector('.roi-panel')`, 'ROI editing 面板');
if (!(await evaluate(`!!document.querySelector('.roi-create')`))) await click(button('New', "document.querySelector('.roi-panel')"));
await waitFor(`!!document.querySelector('.roi-create input.roi-name')`, '新建列');
await setInput(`document.querySelector('.roi-create input.roi-name')`, 'FirstStructure');
await click(button('Create', "document.querySelector('.roi-create')"));
await waitFor(`document.body.innerText.includes('FirstStructure')`, '新結構出現', 20000);
const heads = [];
for (let n = 0; n < 8; n += 1) {
  heads.push(await evaluate(`[...document.querySelectorAll('[class*="set-header"]')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim()).join(' | ')`));
  await sleep(250);
}
c.check(
  '第一個結構直接歸在自己的結構集（沒有「Other (no source structure set)」）',
  heads.every((h) => !h.includes('Other (no source structure set)')) && heads[heads.length - 1].includes("'s structure set"),
  heads[heads.length - 1].slice(0, 120),
);

// 複製：預設名稱跟介面語言
await click(button('Copy', "document.querySelector('.roi-panel')"));
await waitFor(`document.body.innerText.includes('FirstStructure copy')`, '複本', 20000).catch(() => undefined);
const names = await evaluate(`[...document.querySelectorAll('li > span.name')].map((e) => e.textContent.trim())`);
c.check('複製的預設名稱是「… copy」', names.includes('FirstStructure copy') && !names.some((n) => n.includes('複本')), names.filter((n) => n.startsWith('FirstStructure')).join(', '));

// 簽核面板：結構集名稱依介面語言
await click(button('Review'));
await waitFor(`!!document.querySelector('.review-panel')`, 'Review 面板');
await sleep(800);
const review = await evaluate(`document.querySelector('.review-panel').innerText`);
c.check('簽核面板的結構集名稱是英文', review.includes("'s structure set") && !review.includes('的結構集'), '');

// ── 3D 相機跟著病例 ───────────────────────────────────────────────────────────
await setLayout('2×2');
await sleep(3000);
const c3 = await center(`[...document.querySelectorAll('.viewport-cell')][3]`);
await mouse('mousePressed', c3.x, c3.y);
for (let n = 1; n <= 12; n += 1) {
  await mouse('mouseMoved', c3.x + n * 12, c3.y + n * 3, { buttons: 1 });
  await sleep(40);
}
await mouse('mouseReleased', c3.x + 144, c3.y + 36);
await sleep(3000);
await openCase({ patient: '113_HM10395', study: '1999-11-26', temporal: 'CT4D' });
await setLayout('2×2');
await sleep(5000);
const bright = await render3dMax();
c.check('換病例後 3D 格不是全黑（不沿用上一個病例的 3D 相機）', bright > 0, `max ${bright}`);

// ── BEV：選單上的方向鍵 ───────────────────────────────────────────────────────
await openCase({ patient: 'RPRO29', study: '(no description)', image: '512×512×355', rt: 'AP1MTFINAL' });
await setLayout('1×1 axial');
await setSelect(`[...document.querySelectorAll('.viewport-cell')][0].querySelector('select.cell-picker')`, 'panel:plan.bev');
await waitFor(`!![...document.querySelectorAll('.viewport-cell')].find((x) => x.innerText.trim().startsWith('BEV'))`, 'BEV 格', 30000);
await sleep(1500);
const bev = `[...document.querySelectorAll('.viewport-cell')].find((x) => x.innerText.trim().startsWith('BEV'))`;
const cpText = () => evaluate(`(${bev}).innerText.match(/CP \\d+ \\/ \\d+/)?.[0] ?? ''`);
const cp0 = await cpText();
await evaluate(`(${bev}).querySelector('select').focus(); true`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
await sleep(1200);
const beam = await evaluate(`(${bev}).querySelector('select').value`);
c.check('BEV 射束選單有焦點：↓ 換射束、不換控制點', beam === '2' && (await cpText()) === cp0, `beam ${beam}, ${cp0} → ${await cpText()}`);

await b.shot('demo-ui-end.png');
if (b.errors.length) console.log('頁面錯誤：', b.errors.slice(0, 5));
const failed = c.report();
b.close();
process.exit(failed === 0 ? 0 : 1);
