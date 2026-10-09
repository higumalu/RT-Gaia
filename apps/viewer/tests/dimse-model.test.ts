/** DIMSE 設定頁與遠端查詢的純邏輯（`src/react/dimse/model.ts`）。 */

import { describe, expect, it } from 'vitest';

import type { DicomNode, DimseSettings } from '../src/react/dimse/dimseApi';
import {
  aetProblem,
  EXPLICIT_LE,
  IMPLICIT_LE,
  pageOf,
  pduProblem,
  TS_PRESETS,
  tsPresetOf,
  describeSendTarget,
  EMPTY_NODE_INPUT,
  EMPTY_REMOTE_QUERY,
  hasRemoteQuery,
  ipProblem,
  needsRestart,
  nodeBody,
  nodeProblems,
  nodeToInput,
  peerSyncWarnings,
  queryableNodes,
  retrieveBody,
  retrieveMethod,
  rolesLabel,
  sendBody,
  settingsPatch,
  settingsProblems,
  sortSeries,
  storeTargets,
  studyQuery,
  summarizeRetrieve,
  summarizeSend,
  supportsLabel,
  toRemoteSeries,
  toRemoteStudy,
} from '../src/react/dimse/model';

const node = (over: Partial<DicomNode>): DicomNode => ({
  node_id: 'n1',
  name: 'PACS',
  ae_title: 'ORTHANC',
  host: '192.0.2.40',
  port: 4242,
  our_calling_aet: 'RTGAIA',
  move_destination_aet: 'RTGAIA',
  tls: false,
  supports: {},
  roles: { send: true, receive: false },
  inbound_ip: null,
  description: '',
  created_by: 'admin',
  created_at: '2026-09-14T00:00:00+00:00',
  last_echo_at: null,
  last_echo_ok: null,
  ...over,
});

const settings: DimseSettings = {
  ae_title: 'RTGAIA',
  scp_enabled: true,
  scp_port: 11112,
  scp_host: '0.0.0.0',
  accept_unknown_callers: false,
  unsupported_sop_policy: 'store',
  idle_seconds: 5,
  acse_timeout: 15,
  dimse_timeout: 60,
  network_timeout: 60,
  connect_timeout: 5,
};

describe('節點表單', () => {
  it('AE Title／port／IP 規則與後端一致', () => {
    expect(aetProblem('RTGAIA')).toBeNull();
    expect(aetProblem('')).toMatch(/必填/);
    expect(aetProblem('THIS_IS_WAY_TOO_LONG_AET')).toMatch(/16/);
    expect(aetProblem('有中文')).toMatch(/ASCII/);
    expect(aetProblem('A B')).toMatch(/ASCII/);
    expect(ipProblem('')).toBeNull();
    expect(ipProblem('192.0.2.30')).toBeNull();
    expect(ipProblem('192.0.2.300')).toMatch(/IPv4/);
    expect(ipProblem('pacs.local')).toMatch(/IPv4/);
  });
  it('可送出要 host／port；只接收可以沒有；至少一個角色', () => {
    expect(nodeProblems({ ...EMPTY_NODE_INPUT, ae_title: 'X', host: '10.0.0.1', port: 104 })).toEqual([]);
    expect(nodeProblems({ ...EMPTY_NODE_INPUT, ae_title: 'X' })).toEqual(['可送出的節點要有主機／IP']);
    expect(nodeProblems({ ...EMPTY_NODE_INPUT, ae_title: 'X', host: 'h', port: '' })).toEqual(['Port 必填']);
    expect(nodeProblems({ ...EMPTY_NODE_INPUT, ae_title: 'X', roles: { send: false, receive: true }, port: '' })).toEqual([]);
    expect(nodeProblems({ ...EMPTY_NODE_INPUT, ae_title: 'X', roles: { send: false, receive: true }, port: '', inbound_ip: 'nope' })).toEqual(['只接受 IPv4 位址（如 192.0.2.30）']);
    expect(nodeProblems({ ...EMPTY_NODE_INPUT, ae_title: 'X', roles: { send: false, receive: false } })).toContain('至少勾一個角色（可送出／可接收）');
    expect(nodeProblems({ ...EMPTY_NODE_INPUT, ae_title: 'X', host: 'h', move_destination_aet: 'WAY_TOO_LONG_AE_TITLE_X' })).toEqual(['C-MOVE 目的地 AE Title：AE Title 最多 16 個字元']);
  });
  it('body：名稱缺省用 AE Title、空選配不送、只接收的 port 為 0', () => {
    expect(nodeBody({ ...EMPTY_NODE_INPUT, ae_title: ' vmsdbd ', host: ' 192.0.2.30 ', port: 104 })).toEqual({
      name: 'vmsdbd',
      ae_title: 'vmsdbd',
      host: '192.0.2.30',
      port: 104,
      roles: { send: true, receive: true },
      inbound_ip: null,
      supports: {},
      description: '',
      our_calling_aet: null,
      move_destination_aet: null,
      max_pdu: 0,
      transfer_syntaxes: [],
    });
    const recv = nodeBody({ ...EMPTY_NODE_INPUT, ae_title: 'TB1', roles: { send: false, receive: true }, port: '', inbound_ip: '198.51.100.11' });
    expect(recv.port).toBe(0);
    expect(recv.inbound_ip).toBe('198.51.100.11');
    // 沒勾接收就不送 inbound_ip
    expect(nodeBody({ ...EMPTY_NODE_INPUT, ae_title: 'X', host: 'h', roles: { send: true, receive: false }, inbound_ip: '1.1.1.1' }).inbound_ip).toBeNull();
  });
  it('PDU 驗證、Transfer Syntax 預設組、分頁', () => {
    expect(pduProblem('')).toBeNull();
    expect(pduProblem(0)).toBeNull();
    expect(pduProblem(16384)).toBeNull();
    expect(pduProblem(1000)).toMatch(/4096/);
    expect(nodeProblems({ ...EMPTY_NODE_INPUT, ae_title: 'A', host: 'h', max_pdu: 99 })).toHaveLength(1);
    expect(tsPresetOf([])).toBe('default');
    expect(tsPresetOf([IMPLICIT_LE])).toBe('implicit');
    expect(tsPresetOf([EXPLICIT_LE, IMPLICIT_LE])).toBe('explicit+implicit');
    expect(tsPresetOf([IMPLICIT_LE, EXPLICIT_LE])).toBe('custom');
    expect(nodeBody({ ...EMPTY_NODE_INPUT, ae_title: 'A', host: 'h', max_pdu: 8192, transfer_syntaxes: [...TS_PRESETS.implicit] })).toMatchObject({ max_pdu: 8192, transfer_syntaxes: [IMPLICIT_LE] });
    expect(nodeToInput(node({ max_pdu: 0, transfer_syntaxes: [IMPLICIT_LE] }), 'RTGAIA')).toMatchObject({ max_pdu: '', transfer_syntaxes: [IMPLICIT_LE] });
    const rows = Array.from({ length: 53 }, (_, i) => i);
    expect(pageOf(rows, 0, 25)).toMatchObject({ page: 0, pages: 3, from: 1, to: 25 });
    expect(pageOf(rows, 2, 25)).toMatchObject({ items: [50, 51, 52], from: 51, to: 53 });
    expect(pageOf(rows, 9, 25).page).toBe(2);
    expect(pageOf([], 0, 25)).toMatchObject({ pages: 1, from: 0, to: 0, items: [] });
  });
  it('節點 → 表單：與全域相同的 AET 留空', () => {
    const input = nodeToInput(node({ our_calling_aet: 'RTGAIA', move_destination_aet: 'GAIA_ALT', inbound_ip: null }), 'RTGAIA');
    expect(input.our_calling_aet).toBe('');
    expect(input.move_destination_aet).toBe('GAIA_ALT');
    expect(input.inbound_ip).toBe('');
    expect(nodeToInput(node({ port: 0 }), 'RTGAIA').port).toBe('');
  });
  it('表格文案', () => {
    expect(rolesLabel(node({ roles: { send: true, receive: true } }))).toBe('送出 接收');
    expect(rolesLabel(node({ roles: { send: false, receive: false } }))).toBe('—');
    expect(supportsLabel({})).toBe('未偵測');
    expect(supportsLabel({ echo: true, find: false, store: true })).toBe('echo store');
    expect(supportsLabel({ echo: false })).toBe('—');
  });
});

describe('節點用途', () => {
  const pacs = node({ node_id: 'pacs', supports: { find: true, move: true, get: true } });
  const tps = node({ node_id: 'tps', supports: { echo: true, store: true, find: false } });
  const cbct = node({ node_id: 'cbct', host: '', port: 0, roles: { send: false, receive: true } });
  it('可查詢＝可送出且 find 沒標不支援；送出目標同理', () => {
    expect(queryableNodes([pacs, tps, cbct]).map((n) => n.node_id)).toEqual(['pacs']);
    expect(storeTargets([pacs, tps, cbct]).map((n) => n.node_id)).toEqual(['pacs', 'tps']);
  });
  it('拉回方法：明確支援 get 才 get', () => {
    expect(retrieveMethod(pacs)).toBe('get');
    expect(retrieveMethod(tps)).toBe('move');
    expect(retrieveMethod(node({ supports: {} }))).toBe('move');
  });
});

describe('服務設定', () => {
  it('patch 只含有改的；重啟判定；對方同步警告', () => {
    const after = { ...settings, ae_title: 'GAIA2', idle_seconds: 8 };
    expect(settingsPatch(settings, after)).toEqual({ ae_title: 'GAIA2', idle_seconds: 8 });
    expect(needsRestart({ ae_title: 'GAIA2' })).toBe(true);
    expect(needsRestart({ idle_seconds: 8, unsupported_sop_policy: 'reject' })).toBe(false);
    const w = peerSyncWarnings(settings, { ...after, scp_port: 104 });
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/RTGAIA 改為 GAIA2/);
    expect(w[1]).toMatch(/11112 改為 104/);
    expect(peerSyncWarnings({ ...settings, accept_unknown_callers: true }, settings)[0]).toMatch(/只有「可接收」節點/);
    expect(peerSyncWarnings(settings, settings)).toEqual([]);
  });
  it('驗證與後端同一套', () => {
    expect(settingsProblems(settings)).toEqual([]);
    expect(settingsProblems({ ...settings, ae_title: '' })).toEqual(['AE Title 必填']);
    expect(settingsProblems({ ...settings, scp_port: 70000 })).toEqual(['接收端 Port 必須在 1–65535']);
    expect(settingsProblems({ ...settings, idle_seconds: 1 })).toEqual(['閒置秒數必須在 3–60']);
    expect(settingsProblems({ ...settings, acse_timeout: 0 })).toEqual(['ACSE 逾時（秒） 必須在 1–3600']);
    expect(settingsProblems({ ...settings, scp_host: ' ' })).toHaveLength(1);
    expect(settingsProblems({ ...settings, connect_timeout: 0 })).toEqual(['TCP 連線逾時（秒） 必須在 1–60']);
  });
});

describe('遠端查詢', () => {
  it('查詢鍵：PatientID 尾端萬用字元、姓名前後、日期範圍、空的不送', () => {
    expect(studyQuery(EMPTY_REMOTE_QUERY)).toEqual({});
    expect(hasRemoteQuery(EMPTY_REMOTE_QUERY)).toBe(false);
    expect(studyQuery({ ...EMPTY_REMOTE_QUERY, patientId: 'P00', patientName: 'wang', modality: 'ct' })).toEqual({
      PatientID: 'P00*',
      PatientName: '*wang*',
      ModalitiesInStudy: 'CT',
    });
    expect(studyQuery({ ...EMPTY_REMOTE_QUERY, patientId: 'P*1' })['PatientID']).toBe('P*1');
    expect(studyQuery({ ...EMPTY_REMOTE_QUERY, dateFrom: '20260101', dateTo: '20260131' })['StudyDate']).toBe('20260101-20260131');
    expect(studyQuery({ ...EMPTY_REMOTE_QUERY, dateFrom: '20260101' })['StudyDate']).toBe('20260101-');
    expect(studyQuery({ ...EMPTY_REMOTE_QUERY, dateTo: '20260131' })['StudyDate']).toBe('-20260131');
  });
  it('C-FIND 列 → study／series；多值與 ^ 姓名', () => {
    const s = toRemoteStudy({
      StudyInstanceUID: '1.2.3',
      PatientID: 'P1',
      PatientName: 'Wang^Da^Ming',
      StudyDate: '20260601',
      StudyDescription: 'Pelvis',
      ModalitiesInStudy: ['CT', 'RTSTRUCT'],
      NumberOfStudyRelatedInstances: '187',
    });
    expect(s).toEqual({ studyUid: '1.2.3', patientId: 'P1', patientName: 'Wang Da Ming', date: '20260601', description: 'Pelvis', modalities: ['CT', 'RTSTRUCT'], seriesCount: null, instanceCount: 187 });
    expect(toRemoteStudy({ StudyInstanceUID: '1', ModalitiesInStudy: 'CT\\MR' }).modalities).toEqual(['CT', 'MR']);
    expect(toRemoteStudy({ StudyInstanceUID: '1', ModalitiesInStudy: null }).modalities).toEqual([]);
    const x = toRemoteSeries({ SeriesInstanceUID: '1.2.3.4', StudyInstanceUID: '1.2.3', Modality: 'RTDOSE', SeriesNumber: '3', NumberOfSeriesRelatedInstances: '1' });
    expect(x.modality).toBe('RTDOSE');
    expect(x.instanceCount).toBe(1);
  });
  it('series 排序：影像 → RS → PLAN → DOSE → REG，再依 number', () => {
    const mk = (m: string, n: string, uid: string) => ({ seriesUid: uid, studyUid: 's', modality: m, description: '', number: n, instanceCount: null });
    const sorted = sortSeries([mk('REG', '1', 'e'), mk('RTDOSE', '1', 'd'), mk('CT', '2', 'b'), mk('CT', '1', 'a'), mk('RTSTRUCT', '1', 'c'), mk('RTPLAN', '1', 'p')]);
    expect(sorted.map((s) => s.seriesUid)).toEqual(['a', 'b', 'c', 'p', 'd', 'e']);
  });
  it('retrieve body 與摘要', () => {
    expect(retrieveBody(new Set(['s1']), new Set(), 'get')).toEqual({ method: 'get', study_uids: ['s1'] });
    expect(retrieveBody(new Set(), new Set(['x', 'y']), 'move')).toEqual({ method: 'move', series_uids: ['x', 'y'] });
    expect(summarizeRetrieve({ method: 'get', received: 5, import: { counts: { accepted: 4, duplicate_same: 1 } } })).toBe('收到 5 · 接受 4 · 重複 1');
    expect(summarizeRetrieve({ method: 'move', completed: 187 })).toBe('對方已送 187 個（由接收端匯入）');
    expect(summarizeRetrieve({ error: 'boom' })).toBe('boom');
    expect(summarizeSend({ sent: 3, total: 4, failed: [{}] })).toBe('送出 3 / 4 · 失敗 1');
    expect(summarizeSend({ sent: 1 })).toBe('送出 1');
    expect(summarizeSend({ sent: 187, total: 187, series_count: 5 })).toBe('送出 187 / 187 · 5 個序列');
  });
});

describe('資料頁送到節點', () => {
  it('病人／study／序列 → body；描述', () => {
    expect(sendBody({ level: 'patient', id: 'P1', label: '病人 P1' })).toEqual({ patient_ids: ['P1'] });
    expect(sendBody({ level: 'study', id: '1.2', label: 'x' })).toEqual({ study_uids: ['1.2'] });
    expect(sendBody({ level: 'series', id: '1.2.3', label: 'x' })).toEqual({ series_uids: ['1.2.3'] });
    expect(describeSendTarget({ level: 'study', id: '1', label: 'x', seriesCount: 5 })).toBe('整個 study（5 個序列）');
    expect(describeSendTarget({ level: 'series', id: '1', label: 'x', instanceCount: 187 })).toBe('這個序列（187 檔）');
    expect(describeSendTarget({ level: 'patient', id: '1', label: 'x' })).toBe('整個病人');
  });
});
