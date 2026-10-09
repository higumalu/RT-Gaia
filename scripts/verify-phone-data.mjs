#!/usr/bin/env node
/**
 * 手機資料頁 —— Android 手機（412×915、觸控）與橫拿（915×412）。
 *
 *   * 版面：data-form=phone；不橫向溢出；搜尋欄全寬、篩選預設收起（按「篩選…」才出現）；沒有「匯入…」
 *   * 「本次載入」是底部摘要條（不蓋住清單；點開才看到各類序列）
 *   * 搜尋 → 點病人 → study 列有「開啟」→ 點了直接進檢視器（影像出來）
 *   * 手動勾影像（4D 組）→ 摘要條的數字變、底部「開啟」可按
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-phone-data.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR]
 */
import { checklist, launch, parseArgs, rowWith, sleep } from './lib/cdp.mjs';

const args = parseArgs();
const b = await launch({ url: args.url ?? 'http://127.0.0.1:5183/#/library', outDir: args['out-dir'] ?? null, port: Number(args.port ?? 9363) });
const c = checklist();

for (const dev of ['phone', 'phone-landscape']) {
  const d = await b.device(dev);
  await b.send('Page.navigate', { url: `${b.origin}/?d=${dev}#/library` });
  await b.waitFor(`!!document.querySelector('.catalog-tree tr[data-kind="patient"]')`, `${dev} 資料頁`, 60000);
  await sleep(800);
  const tag = `${dev} ${d.width}×${d.height}`;
  c.check(`${tag}：data-form=phone`, (await b.evaluate(`document.documentElement.dataset.form`)) === 'phone');
  const g = await b.evaluate(`(() => {
    const W = innerWidth, H = innerHeight;
    const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const x = e.getBoundingClientRect(); return { l: x.left, t: x.top, w: x.width, h: x.height, b: x.bottom }; };
    return { W, H, scrollW: document.documentElement.scrollWidth, search: r('.library-search label.grow input'), date: r('.library-search input[type=date]'), cart: r('.library-cart'), main: r('.library-main'), importBtn: [...document.querySelectorAll('.library-header button')].some((x) => x.textContent.includes('匯入')) };
  })()`);
  c.check(`${tag}：不橫向溢出`, g.scrollW <= g.W + 1, `${g.scrollW} / ${g.W}`);
  c.check(`${tag}：搜尋欄夠寬`, g.search && g.search.w >= g.W * 0.55, g.search ? `${Math.round(g.search.w)} px` : 'none');
  c.check(`${tag}：篩選預設收起`, !g.date || g.date.w === 0);
  c.check(`${tag}：沒有「匯入…」`, !g.importBtn);
  c.check(`${tag}：本次載入是底部摘要條（高 ≤ 80、貼底）`, g.cart && g.cart.h <= 80 && Math.abs(g.cart.b - g.H) <= 2, g.cart ? `${Math.round(g.cart.h)} px @ ${Math.round(g.cart.t)}` : 'none');
  await b.shot(`phone-data-${dev}.png`);
}

await b.device('phone');
await b.send('Page.navigate', { url: `${b.origin}/?d=phone2#/library` });
await b.waitFor(`!!document.querySelector('.catalog-tree tr[data-kind="patient"]')`, '手機資料頁', 60000);
await sleep(500);
// 篩選展開／收起
await b.clickButton(`document.querySelector('.library-search')`, '篩選…');
await sleep(200);
c.check('按「篩選…」→ 日期欄出現', await b.evaluate(`(document.querySelector('.library-search input[type=date]')?.getBoundingClientRect().width ?? 0) > 0`));
await b.clickButton(`document.querySelector('.library-search')`, '收起篩選');
// 搜尋 → 病人
await b.evaluate(`(() => { const i = document.querySelector('.library-search label.grow input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'SYN4D-CT1'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await b.waitFor(`!!${rowWith('study', 'synth4d')}`, '搜尋命中 SYN4D-CT1 的 study（自動展開）', 30000);
// 手動勾：展開 study、勾一張影像 → 摘要條數字變
const handle0 = await b.evaluate(`document.querySelector('.cart-handle')?.textContent ?? ''`);
await b.evaluate(`${rowWith('study', 'synth4d')}.click(); true`);
await sleep(300);
if (!(await b.evaluate(`!!document.querySelector('.catalog-tree tr[data-kind="temporal"], .catalog-tree tr[data-kind="image"]')`))) {
  await b.evaluate(`${rowWith('study', 'synth4d')}.click(); true`);
}
// SYN4D-CT1 的影像都在 4D 組裡 → 勾組那一列（跟勾單張影像同一條路：帶進 RT）
const pick = `document.querySelector('.catalog-tree tr[data-kind="temporal"] input[type=checkbox], .catalog-tree tr[data-kind="image"] input[type=checkbox]')`;
await b.waitFor(`!!${pick}`, 'study 底下的影像列', 30000);
await b.evaluate(`${pick}.click(); true`);
await b.waitFor(`document.querySelector('.cart-handle')?.textContent !== ${JSON.stringify(handle0)}`, '摘要條數字變了', 20000);
c.check('勾影像 → 摘要條的數字變', true, `${handle0.trim()} → ${(await b.evaluate(`document.querySelector('.cart-handle')?.textContent ?? ''`)).trim()}`);
c.check('摘要條上的「開啟」可以按', await b.evaluate(`!![...document.querySelectorAll('.library-cart .cart-actions button')].find((x) => x.textContent.trim() === '開啟' && !x.disabled)`));
// 點開摘要條 → 看得到各類序列；再收起
await b.clickButton(`document.querySelector('.library-cart')`, (await b.evaluate(`document.querySelector('.cart-handle').textContent.trim()`)));
await sleep(300);
const opened = await b.evaluate(`(() => { const r = document.querySelector('.library-cart').getBoundingClientRect(); return { h: r.height, text: document.querySelector('.library-cart').textContent }; })()`);
c.check('點摘要條 → 展開看到各類序列', opened.h > 120 && opened.text.includes('結構集'), `${Math.round(opened.h)} px`);
await b.shot('phone-data-cart-open.png');
await b.evaluate(`document.querySelector('.cart-handle').click(); true`);
await b.evaluate(`[...document.querySelectorAll('.library-cart .cart-actions button')].find((x) => x.textContent.trim() === '清空')?.click(); true`);
// 一鍵開啟
c.check('study 列有「開啟」', await b.evaluate(`!!${rowWith('study', 'synth4d')}?.querySelector('.quick-open')`));
const qo = await b.centerOf(`${rowWith('study', 'synth4d')}.querySelector('.quick-open')`);
c.check('「開啟」按鈕夠大（≥ 32 px 高）', qo && qo.h >= 32, qo ? `${Math.round(qo.w)}×${Math.round(qo.h)}` : 'none');
await b.touch.tap(qo.x, qo.y);
await b.waitFor(`location.hash.includes('viewer') && document.querySelectorAll('.viewport-cell canvas').length >= 1`, '一鍵開啟 → 檢視器有影像', 180000);
c.check('一鍵開啟 → 進檢視器、影像出來', true);
await sleep(2000);
await b.shot('phone-data-quick-open-viewer.png');

c.check('沒有頁面例外', b.errors.length === 0, b.errors.slice(0, 2).join(' | '));
const failed = c.report();
b.close();
process.exit(failed === 0 ? 0 : 1);
