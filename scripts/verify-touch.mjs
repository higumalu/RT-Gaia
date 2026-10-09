#!/usr/bin/env node
/**
 * 觸控手勢與觸控筆 —— headless Chrome 模擬 Android 平板（800×1280、觸控），送真的觸控事件。
 *
 *   * 版面判斷：`<html data-form="tablet" data-pointer="coarse">`；觸控按鈕（調窗）出現
 *   * 一指拖曳 → 換切片；雙指張開 → 放大；點一下 → 讀數；長按 → 十字線移過去（別格的切片跟著換）
 *   * 「調窗」開著：一指拖曳改調窗（畫面變、切片不變）
 *   * 筆刷：一指拖曳畫一筆（undo 1 筆）；雙指（第二隻慢 40 ms 到）不畫、只縮放
 *   * 觸控筆畫一筆 → 手指不再畫（拖曳變換切片）、出現「手指畫」；打開後手指又能畫；筆壓著時手掌的觸控全部忽略
 *   * 新建結構時體素晚到（mask 請求延遲 1.5 秒）→ 照樣自動成為編輯對象（CI 抓到過）
 *   * 長按按鈕看說明，放開不算點擊
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-touch.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR]
 */
import { checklist, launch, openSynth4d, parseArgs, sleep } from './lib/cdp.mjs';

const args = parseArgs();
const b = await launch({ url: args.url ?? 'http://127.0.0.1:5183/#/library', outDir: args['out-dir'] ?? null, port: Number(args.port ?? 9361) });
const c = checklist();

await openSynth4d(b);
await b.device('tablet');
await b.send('Page.navigate', { url: `${b.origin}/?touch=1#/viewer` });
await b.waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3`, '平板上病例開起來', 120000);
await sleep(2500);

const form = await b.evaluate(`[document.documentElement.dataset.form, document.documentElement.dataset.pointer]`);
c.check('平板版面：data-form=tablet、pointer coarse', form[0] === 'tablet' && form[1] === 'coarse', form.join(' '));
c.check('觸控按鈕「調窗」在工具列', await b.evaluate(`!![...document.querySelectorAll('.task-bar .touch-controls button')].find((x) => x.textContent.trim() === '調窗')`));

const cell = (label) => `[...document.querySelectorAll('.viewport-cell')].find((c) => c.querySelector('.viewport-label')?.textContent.trim() === ${JSON.stringify(label)})`;
const sliceOf = (label) => b.evaluate(`${cell(label)}?.querySelector('.viewport-slice')?.textContent.trim() ?? ''`);
const zoomOf = (label) => b.evaluate(`${cell(label)}?.querySelector('.zoom-factor')?.textContent.trim() ?? ''`);
const sumOf = (label) => b.evaluate(`(() => { const cv = ${cell(label)}?.querySelector('canvas'); const x = cv?.getContext('2d'); if (!x) return -1; const d = x.getImageData(0, 0, cv.width, cv.height).data; let s = 0; for (let i = 0; i < d.length; i += 16) s += d[i]; return s; })()`);
const undoText = () => b.evaluate(`document.querySelector('.edit-controls')?.textContent ?? ''`);
const undoDepth = async () => Number((await undoText()).match(/(\d+)\s*筆/)?.[1] ?? -1);
const ax = await b.centerOf(`${cell('軸向')}.querySelector('.viewport-canvas-host')`);
c.check('軸向格有大小', ax && ax.w > 150 && ax.h > 150, ax ? `${Math.round(ax.w)}×${Math.round(ax.h)}` : 'none');

// 一指拖曳 → 換切片
const s0 = await sliceOf('軸向');
await b.touch.drag([[ax.x, ax.y - 60], [ax.x, ax.y - 20], [ax.x, ax.y + 20], [ax.x, ax.y + 60]], { hold: 30 });
const s1 = await sliceOf('軸向');
c.check('一指拖曳 → 換切片', s0 !== s1 && s1 !== '', `${s0} → ${s1}`);

// 雙指張開 → 放大
const z0 = await zoomOf('軸向');
await b.touch.multi([
  [[ax.x - 30, ax.y], [ax.x - 60, ax.y], [ax.x - 90, ax.y]],
  [[ax.x + 30, ax.y], [ax.x + 60, ax.y], [ax.x + 90, ax.y]],
]);
const z1 = await zoomOf('軸向');
c.check('雙指張開 → 放大', parseFloat(z1) > parseFloat(z0), `${z0} → ${z1}`);
c.check('雙指不換切片', (await sliceOf('軸向')) === s1);

// 點一下 → 讀數
await b.touch.tap(ax.x + 10, ax.y + 10);
const probe = await b.evaluate(`document.querySelector('.probe-world')?.textContent.trim() ?? ''`);
c.check('點一下 → 讀數', probe !== '' && probe !== 'N/A', probe);

// 長按 → 十字線移過去（冠狀格的切片跟著換）
const co0 = await sliceOf('冠狀');
await b.touch.longPress(ax.x + 5, ax.y - ax.h * 0.3);
const co1 = await sliceOf('冠狀');
c.check('長按 → 十字線移到那裡（冠狀格切片換了）', co0 !== co1, `${co0} → ${co1}`);

// 調窗：一指拖曳改調窗寬窗位
await b.clickButton(`document.querySelector('.task-bar .touch-controls')`, '調窗');
await sleep(200);
c.check('「調窗」按下去是開著', await b.evaluate(`[...document.querySelectorAll('.touch-controls button')].find((x) => x.textContent.trim() === '調窗')?.getAttribute('aria-pressed') === 'true'`));
const w0 = await sumOf('軸向');
const sl0 = await sliceOf('軸向');
await b.touch.drag([[ax.x - 60, ax.y], [ax.x - 20, ax.y + 10], [ax.x + 40, ax.y + 30], [ax.x + 90, ax.y + 40]], { hold: 30 });
await sleep(600);
const w1 = await sumOf('軸向');
c.check('調窗開著：拖曳改變畫面亮度', w0 !== w1, `${w0} → ${w1}`);
c.check('調窗開著：切片不變', (await sliceOf('軸向')) === sl0);
await b.clickButton(`document.querySelector('.task-bar .touch-controls')`, '調窗');

// 筆刷：先建一個結構
await b.clickButton(`document.querySelector('.task-bar')`, 'ROI 編輯');
await b.waitFor(`!!document.querySelector('.roi-panel')`, 'ROI 編輯面板');
await b.evaluate(`[...document.querySelectorAll('.roi-panel button')].find((x) => x.textContent.trim() === '新建').click(); true`);
await b.waitFor(`!!document.querySelector('.roi-create .roi-name')`, '新建欄位');
await b.evaluate(`(() => { const i = document.querySelector('.roi-create .roi-name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'TouchV19'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
// 名稱寫進去、「建立」可以按了才按（太快按到的是停用的按鈕，什麼都不會建 —— 偶發失敗的原因）
await b.waitFor(`!![...document.querySelectorAll('.roi-create button')].find((x) => x.textContent.trim() === '建立' && !x.disabled)`, '「建立」可以按', 10000);
// 體素比「設成編輯對象」晚到（CI 上實際發生：新結構一直不是編輯對象、筆刷停用 30 秒）→ 故意把 mask 請求延遲 1.5 秒
b.on('Fetch.requestPaused', (p) => setTimeout(() => b.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}), 1500));
await b.send('Fetch.enable', { patterns: [{ urlPattern: '*/mask*', requestStage: 'Request' }] });
await b.evaluate(`[...document.querySelectorAll('.roi-create button')].find((x) => x.textContent.trim() === '建立').click(); true`);
// 作用中結構的名稱欄是 TouchV19（以前比對整個面板的文字，會誤中底下「新建 TouchV19」的狀態列 —— CI 上作用中其實沒設成功）
await b.waitFor(`document.querySelector('.roi-active .roi-name')?.value === 'TouchV19'`, '新結構建好、成為編輯對象', 30000);
c.check('體素晚到 1.5 秒：新結構照樣自動成為編輯對象', true);
await b.send('Fetch.disable');
// 新結構的體素到了才能畫（之前筆刷停用、說明「…尚未載入」）
const brushBtn = `[...document.querySelectorAll('.task-bar .toolbar button')].find((x) => x.textContent.includes('筆刷') && !x.textContent.includes('閾值'))`;
await b.waitFor(`${brushBtn} && !${brushBtn}.disabled`, '筆刷可以用', 30000);
await b.evaluate(`${brushBtn}.click(); true`);
await sleep(300);
c.check('筆刷選上了', await b.evaluate(`${brushBtn}.getAttribute('aria-pressed') === 'true'`));
const d0 = await undoDepth();
await b.touch.drag([[ax.x - 40, ax.y], [ax.x - 20, ax.y], [ax.x, ax.y], [ax.x + 20, ax.y], [ax.x + 40, ax.y]]);
await sleep(400);
const d1 = await undoDepth();
c.check('筆刷：一指拖曳畫一筆（undo +1）', d1 === d0 + 1, `${d0} → ${d1}`);

// 雙指（第二隻慢 40 ms）不畫、只縮放
const z2 = await zoomOf('軸向');
await b.touch.staggered([[ax.x - 30, ax.y + 40], [ax.x - 70, ax.y + 40]], [[ax.x + 30, ax.y + 40], [ax.x + 70, ax.y + 40]], { lag: 40 });
await sleep(300);
c.check('選了筆刷時雙指：不畫', (await undoDepth()) === d1, `undo ${await undoDepth()}`);
c.check('選了筆刷時雙指：照樣縮放', (await zoomOf('軸向')) !== z2, `${z2} → ${await zoomOf('軸向')}`);

// 觸控筆畫一筆 → 手指不再畫
await b.pen.drag([[ax.x - 40, ax.y - 30], [ax.x - 10, ax.y - 30], [ax.x + 20, ax.y - 30], [ax.x + 40, ax.y - 30]]);
await sleep(400);
const d2 = await undoDepth();
c.check('觸控筆畫一筆（undo +1）', d2 === d1 + 1, `${d1} → ${d2}`);
const fingerBtn = `[...document.querySelectorAll('.touch-controls button')].find((x) => x.textContent.trim() === '手指畫')`;
c.check('用過觸控筆 → 出現「手指畫」而且是關的', await b.evaluate(`${fingerBtn}?.getAttribute('aria-pressed') === 'false'`));
const s2 = await sliceOf('軸向');
await b.touch.drag([[ax.x, ax.y - 60], [ax.x, ax.y - 20], [ax.x, ax.y + 20], [ax.x, ax.y + 60]]);
await sleep(300);
c.check('用過觸控筆 → 手指拖曳不畫', (await undoDepth()) === d2, `undo ${await undoDepth()}`);
c.check('用過觸控筆 → 手指拖曳換切片', (await sliceOf('軸向')) !== s2, `${s2} → ${await sliceOf('軸向')}`);
await b.evaluate(`${fingerBtn}.click(); true`);
await sleep(200);
await b.touch.drag([[ax.x - 40, ax.y + 20], [ax.x, ax.y + 20], [ax.x + 40, ax.y + 20]]);
await sleep(400);
c.check('「手指畫」打開 → 手指又能畫', (await undoDepth()) === d2 + 1, `undo ${await undoDepth()}`);

// 手掌：筆壓著的時候，手指（手掌）的觸控一律忽略 —— 不畫、不換切片
await b.evaluate(`${fingerBtn}.click(); true`); // 手指畫先關回去，看的是「換切片」有沒有被忽略
await sleep(200);
const s3 = await sliceOf('軸向');
const d3 = await undoDepth();
await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ax.x + 60, y: ax.y + 60, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
// 往上拖（切片在第 1 張，往下拖本來就不會動 —— 那樣測不出什麼）
await b.touch.drag([[ax.x - 30, ax.y + 60], [ax.x - 30, ax.y + 20], [ax.x - 30, ax.y - 20], [ax.x - 30, ax.y - 60]]);
await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ax.x + 60, y: ax.y + 60, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
await sleep(400);
c.check('手掌：筆壓著時手指拖曳不換切片', (await sliceOf('軸向')) === s3, `${s3} → ${await sliceOf('軸向')}`);
// 筆點的那一下可能落在體積外（前面縮放平移過，CI 上就是）→ 筆自己最多 +1；手指若也畫了會再多
const d4 = await undoDepth();
c.check('手掌：筆壓著時手指不畫（最多只有筆點的那一下）', d4 === d3 || d4 === d3 + 1, `${d3} → ${d4}`);
// 對照：筆放開之後同樣往上拖 → 會換切片（證明上面那一下真的是被忽略，不是拖不動）
await b.touch.drag([[ax.x - 30, ax.y + 60], [ax.x - 30, ax.y + 20], [ax.x - 30, ax.y - 20], [ax.x - 30, ax.y - 60]]);
await sleep(300);
c.check('對照：筆放開後同樣往上拖會換切片', (await sliceOf('軸向')) !== s3, `${s3} → ${await sliceOf('軸向')}`);

// 長按按鈕看說明、不算點擊
const btn = await b.centerOf(`[...document.querySelectorAll('.touch-controls button')].find((x) => x.textContent.trim() === '調窗')`);
await b.touch.longPress(btn.x, btn.y, 800);
const tip = await b.evaluate(`document.querySelector('.touch-title')?.textContent ?? ''`);
c.check('長按按鈕 → 顯示說明', tip.includes('一指拖曳'), tip.slice(0, 30));
await sleep(500);
c.check('長按放開不算點擊（調窗仍是關的）', await b.evaluate(`[...document.querySelectorAll('.touch-controls button')].find((x) => x.textContent.trim() === '調窗')?.getAttribute('aria-pressed') === 'false'`));

await b.shot('touch-v19-tablet.png');
// 收尾：刪掉測試結構（量測堆疊的資料不留垃圾）
await b.evaluate(`(async () => { const r = await fetch('/api/v1/sessions/current').then((x) => x.json()); const list = await fetch('/api/v1/studies/' + encodeURIComponent(r.studyId) + '/structures').then((x) => x.json()); const rows = Array.isArray(list) ? list : list.structures ?? []; for (const s of rows.filter((x) => x.name === 'TouchV19')) await fetch('/api/v1/structures/' + s.structure_id, { method: 'DELETE' }); return true; })()`).catch(() => undefined);
c.check('沒有頁面例外', b.errors.length === 0, b.errors.slice(0, 2).join(' | '));
const failed = c.report();
b.close();
process.exit(failed === 0 ? 0 : 1);
