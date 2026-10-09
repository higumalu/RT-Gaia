#!/usr/bin/env node
/**
 * 簽核鎖定 —— headless Chrome ＋ CDP（`scripts/lib/cdp.mjs`），量測堆疊的合成病例 SYN4D-CT1：
 *
 *   ROI 編輯面板建一個結構 → 用 API 簽核
 *     • 面板顯示唯讀原因；顏色停用、名稱唯讀
 *     • 改名、改色（PATCH）→ 409 APPROVED_LOCKED（以前不擋，改得到已簽核的結構）
 *   重新開啟（under_review）→ 顏色、名稱恢復可改，改名成功
 *   最後刪掉這個結構（刪除已簽核的結構是允許的，這裡刪的是重新開啟後的）
 *
 *   uv run python -m rtgaia_testbe.fixtures.synth4d --out data/test_4d --only ct1
 *   scripts/perf/stack.sh start
 *   node scripts/verify-approved-lock.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR]
 * 退出碼：任一項失敗 → 1。
 */
import { checklist, launch, openSynth4d, parseArgs, sleep } from './lib/cdp.mjs';

const args = parseArgs();
const b = await launch({ url: args.url ?? 'http://127.0.0.1:5183/#/library', outDir: args['out-dir'] ?? null, port: Number(args.port ?? 9372) });
const c = checklist();
const { evaluate, waitFor } = b;
const NAME = 'LockCheck';

const button = (text, scope = 'document') => `[...(${scope}).querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && x.getBoundingClientRect().width > 0)`;
const click = (expr) => evaluate(`(() => { const e = ${expr}; if (!e) return false; e.click(); return true; })()`);
const setInput = (expr, value) =>
  evaluate(`(() => { const i = ${expr}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
/** 在頁面裡打 API（同源、帶 cookie）；回 { status, body }。 */
const api = (method, path, body) =>
  evaluate(`fetch('/api/v1' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async (r) => ({ status: r.status, body: await r.text() }))`);
const controls = () =>
  evaluate(`(() => {
    const row = document.querySelector('.roi-panel .roi-active');
    const color = row?.querySelector('input[type=color]');
    const name = row?.querySelector('input.roi-name');
    const warn = [...document.querySelectorAll('.roi-panel .roi-readonly .warning')].map((e) => e.textContent).join(' ');
    return { found: !!row, colorDisabled: !!color?.disabled, nameReadOnly: !!name?.readOnly, warn };
  })()`);

await openSynth4d(b);
const studyId = await evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.studyId)`);

// 先清掉上一次留下的
const leftovers = JSON.parse((await api('GET', `/studies/${encodeURIComponent(studyId)}/structures`)).body).filter((s) => s.name === NAME);
for (const s of leftovers) await api('DELETE', `/structures/${encodeURIComponent(s.structure_id)}`);

await click(button('ROI 編輯'));
await waitFor(`!!document.querySelector('.roi-panel')`, 'ROI 編輯面板');
if (!(await evaluate(`!!document.querySelector('.roi-create')`))) await click(button('新建', "document.querySelector('.roi-panel')"));
await waitFor(`!!document.querySelector('.roi-create input.roi-name')`, '新建列');
await setInput(`document.querySelector('.roi-create input.roi-name')`, NAME);
await click(button('建立', "document.querySelector('.roi-create')"));
await waitFor(`document.querySelector('.roi-panel .roi-active input.roi-name')?.value === ${JSON.stringify(NAME)}`, '新結構是編輯對象', 20000);
const created = JSON.parse((await api('GET', `/studies/${encodeURIComponent(studyId)}/structures`)).body).find((s) => s.name === NAME);
c.check('建立了結構', !!created, created?.structure_id ?? '');
const sid = created.structure_id;
const before = await controls();
c.check('簽核前：顏色、名稱可改', before.found && !before.colorDisabled && !before.nameReadOnly, JSON.stringify(before));

const reviewed = await api('POST', `/studies/${encodeURIComponent(studyId)}/review`, { structure_statuses: { [sid]: 'approved' } });
c.check('簽核成功', reviewed.status === 200, String(reviewed.status));
await waitFor(`(() => { const r = document.querySelector('.roi-panel .roi-active'); return !!r?.querySelector('input[type=color]')?.disabled; })()`, '面板收到簽核', 20000).catch(() => undefined);
const locked = await controls();
c.check('簽核後：顏色停用、名稱唯讀', locked.colorDisabled && locked.nameReadOnly, JSON.stringify(locked));
c.check('簽核後：面板顯示唯讀原因', /簽核/.test(locked.warn), locked.warn.slice(0, 60));
const rename = await api('PATCH', `/structures/${encodeURIComponent(sid)}`, { name: `${NAME} renamed` });
c.check('改名 → 409 APPROVED_LOCKED', rename.status === 409 && rename.body.includes('APPROVED_LOCKED'), `${rename.status} ${rename.body.slice(0, 80)}`);
const recolor = await api('PATCH', `/structures/${encodeURIComponent(sid)}`, { color_rgb: [1, 2, 3] });
c.check('改色 → 409 APPROVED_LOCKED', recolor.status === 409 && recolor.body.includes('APPROVED_LOCKED'), `${recolor.status}`);

const reopened = await api('POST', `/studies/${encodeURIComponent(studyId)}/review`, { structure_statuses: { [sid]: 'under_review' } });
c.check('重新開啟成功', reopened.status === 200, String(reopened.status));
await waitFor(`(() => { const r = document.querySelector('.roi-panel .roi-active'); return r?.querySelector('input[type=color]')?.disabled === false; })()`, '面板收到重新開啟', 20000).catch(() => undefined);
const open = await controls();
c.check('重新開啟後：顏色、名稱可改', !open.colorDisabled && !open.nameReadOnly, JSON.stringify(open));
const renamed = await api('PATCH', `/structures/${encodeURIComponent(sid)}`, { name: `${NAME} renamed` });
c.check('重新開啟後改名成功', renamed.status === 200, String(renamed.status));

const removed = await api('DELETE', `/structures/${encodeURIComponent(sid)}`);
c.check('清掉測試結構', removed.status === 204, String(removed.status));
await sleep(300);
c.check('沒有頁面例外', b.errors.length === 0, b.errors.slice(0, 2).join(' | '));
await b.shot('approved-lock.png');
const failed = c.report();
b.close();
process.exit(failed ? 1 : 0);
