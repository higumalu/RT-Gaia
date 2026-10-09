#!/usr/bin/env node
/**
 * 用 id 定位的端點只找自己的 session —— headless Chrome ＋ CDP（`scripts/lib/cdp.mjs`），量測堆疊的合成病例：
 *
 *   檢視器開 SYN4D-CT1（session 1）；同一個人用 API 再開 SYN4D-CT2 的一張 CT（session 2，另一個 study）
 *   兩個病例各有一個 id 相同的結構（ROI 面板新建一個，另一個病例用同一個 id 建）
 *     • 檢視器的結構請求都帶 X-RTGaia-Session ＝ 自己的 session
 *     • 在 ROI 面板改名 → 只有 SYN4D-CT1 的改了（以前打到最近開的 SYN4D-CT2）
 *     • 不帶標頭的請求 → 409 AMBIGUOUS_SESSION（不猜）
 *   最後刪掉兩個結構、釋放 session 2
 *
 *   uv run python -m rtgaia_testbe.fixtures.synth4d --out data/test_4d --only ct1,ct2
 *   scripts/perf/stack.sh start
 *   node scripts/verify-session-scoping.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR]
 * 退出碼：任一項失敗 → 1。
 */
import { checklist, launch, openSynth4d, parseArgs, sleep } from './lib/cdp.mjs';

const args = parseArgs();
const b = await launch({ url: args.url ?? 'http://127.0.0.1:5183/#/library', outDir: args['out-dir'] ?? null, port: Number(args.port ?? 9373) });
const c = checklist();
const { evaluate, waitFor } = b;
const NAME = 'ScopeCheck';
const HEADER = 'x-rtgaia-session';

const button = (text, scope = 'document') => `[...(${scope}).querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && x.getBoundingClientRect().width > 0)`;
const click = (expr) => evaluate(`(() => { const e = ${expr}; if (!e) return false; e.click(); return true; })()`);
const setInput = (expr, value) =>
  evaluate(`(() => { const i = ${expr}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
/** 在頁面裡打 API（同源、帶 cookie）；`session` 給了才帶標頭。回 { status, body }。 */
const api = (method, path, body, session) =>
  evaluate(`fetch('/api/v1' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json'${session ? `, 'X-RTGaia-Session': ${JSON.stringify(session)}` : ''} }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async (r) => ({ status: r.status, body: await r.text() }))`);
const json = async (...a) => JSON.parse((await api(...a)).body);
const nameIn = async (studyId, sid) => (await json('GET', `/studies/${encodeURIComponent(studyId)}/structures`)).find((s) => s.structure_id === sid)?.name ?? null;

// headless 的頁面沒有視窗焦點：不開這個，focus／blur 事件不會觸發（ROI 面板的改名在離開欄位時才送）
await b.send('Emulation.setFocusEmulationEnabled', { enabled: true });
await openSynth4d(b);
const current = await json('GET', '/sessions/current');
const [sid1, studyA] = [current.sessionId, current.studyId];

// 檢視器發出的結構請求：記下標頭
const seen = [];
await b.send('Network.enable');
b.on('Network.requestWillBeSent', (p) => {
  if (p.request.url.includes('/api/v1/structures/')) {
    const headers = Object.fromEntries(Object.entries(p.request.headers).map(([k, v]) => [k.toLowerCase(), v]));
    seen.push({ method: p.request.method, url: p.request.url, session: headers[HEADER] ?? null });
  }
});

// ROI 面板新建一個結構（session 1 的病例）
await click(button('ROI 編輯'));
await waitFor(`!!document.querySelector('.roi-panel')`, 'ROI 編輯面板');
if (!(await evaluate(`!!document.querySelector('.roi-create')`))) await click(button('新建', "document.querySelector('.roi-panel')"));
await waitFor(`!!document.querySelector('.roi-create input.roi-name')`, '新建列');
await setInput(`document.querySelector('.roi-create input.roi-name')`, NAME);
await click(button('建立', "document.querySelector('.roi-create')"));
await waitFor(`document.querySelector('.roi-panel .roi-active input.roi-name')?.value === ${JSON.stringify(NAME)}`, '新結構是編輯對象', 20000);
const created = (await json('GET', `/studies/${encodeURIComponent(studyA)}/structures`)).find((s) => s.name === NAME);
c.check('SYN4D-CT1 建了結構', !!created, created?.structure_id ?? '');
const sid = created.structure_id;

// 同一個人再開另一個病例（另一個 study），用同一個 id 建結構
const ct2 = await json('GET', '/library/series?patient_id=SYN4D-CT2');
const ct = ct2.patients[0].studies.flatMap((s) => s.series).find((s) => s.modality === 'CT');
const opened = await api('POST', '/sessions', { primary_series_uid: ct.series_instance_uid, image_series_uids: [ct.series_instance_uid], structure_set_uids: [], dose_uids: [], registration_uids: [], plan_uids: [] });
c.check('同一個人開了第二個病例', opened.status === 201, `${opened.status} ${opened.body.slice(0, 80)}`);
const { session_id: sid2, study_id: studyB } = JSON.parse(opened.body);
c.check('第二個病例是另一個 study', studyB !== studyA && sid2 !== sid1, `${studyA.slice(-8)} / ${studyB.slice(-8)}`);
const other = await api('POST', `/studies/${encodeURIComponent(studyB)}/structures`, { name: `${NAME} other`, structure_id: sid });
c.check('第二個病例用同一個 id 建了結構', other.status === 201 || other.status === 200, `${other.status} ${other.body.slice(0, 80)}`);

// 在 ROI 面板改名
const renamed = `${NAME} renamed`;
// 跟使用者一樣：先點進欄位、打字、離開欄位（onBlur 才送出；沒 focus 的欄位 blur() 什麼都不會發生）
await evaluate(`document.querySelector('.roi-panel .roi-active input.roi-name').focus(); true`);
await setInput(`document.querySelector('.roi-panel .roi-active input.roi-name')`, renamed);
await sleep(200);
await evaluate(`document.querySelector('.roi-panel .roi-active input.roi-name').blur(); true`);
await waitFor(`fetch('/api/v1/studies/${encodeURIComponent(studyA)}/structures').then((r) => r.json()).then((l) => l.some((s) => s.name === ${JSON.stringify(renamed)}))`, '改名生效', 20000).catch(() => undefined);
c.check('改名只改到檢視器的病例', (await nameIn(studyA, sid)) === renamed, String(await nameIn(studyA, sid)));
c.check('另一個病例的同 id 結構沒被改', (await nameIn(studyB, sid)) === `${NAME} other`, String(await nameIn(studyB, sid)));
const patch = seen.find((r) => r.method === 'PATCH' && r.url.includes(`/structures/${encodeURIComponent(sid)}`));
c.check('檢視器的改名請求帶自己的 session', patch?.session === sid1, JSON.stringify(patch ?? null).slice(0, 120));
c.check('檢視器的結構請求都帶標頭', seen.length > 0 && seen.every((r) => r.session === sid1), `${seen.length} 個請求`);

// 不帶標頭：兩個病例都有這個 id → 不猜
const bare = await api('PATCH', `/structures/${encodeURIComponent(sid)}`, { name: 'which one' });
c.check('不帶標頭 → 409 AMBIGUOUS_SESSION', bare.status === 409 && bare.body.includes('AMBIGUOUS_SESSION'), `${bare.status} ${bare.body.slice(0, 80)}`);

const d1 = await api('DELETE', `/structures/${encodeURIComponent(sid)}`, undefined, sid1);
const d2 = await api('DELETE', `/structures/${encodeURIComponent(sid)}`, undefined, sid2);
c.check('清掉兩個測試結構', d1.status === 204 && d2.status === 204, `${d1.status} ${d2.status}`);
const rel = await api('POST', `/sessions/${encodeURIComponent(sid2)}/release`, {});
c.check('釋放第二個 session', rel.status === 200, String(rel.status));
await sleep(300);
c.check('沒有頁面例外', b.errors.length === 0, b.errors.slice(0, 2).join(' | '));
await b.shot('session-scoping.png');
const failed = c.report();
b.close();
process.exit(failed ? 1 : 0);
