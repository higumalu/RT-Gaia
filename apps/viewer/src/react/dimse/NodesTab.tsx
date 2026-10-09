/**
 * 管理頁「DICOM 節點」分頁 —— 節點表、新增／編輯抽屜、C-ECHO 測試、偵測 supports。
 * 純邏輯在 `model.ts`，fetch 在 `dimseApi.ts`。
 */

import { useCallback, useEffect, useState } from 'react';

import { dimseApi, type DicomNode, type DimseStatus, type NodeInput, type ProbeResult, type RemoteJob } from './dimseApi';
import { CAPABILITIES, CAPABILITY_LABEL, EMPTY_NODE_INPUT, nodeBody, nodeProblems, nodeToInput, rolesLabel, supportsLabel, TS_PRESET_LABEL, TS_PRESETS, tsPresetOf, type TsPreset } from './model';
import { joinClauses, t } from '../../core/i18n';

type FindTest = NonNullable<ProbeResult['find_test']>;
type Drawer = { kind: 'closed' } | { kind: 'new'; input: NodeInput } | { kind: 'edit'; node: DicomNode; input: NodeInput; findTest?: FindTest | null };

export function NodesTab(props: { onOpenService: () => void }): React.JSX.Element {
  const [nodes, setNodes] = useState<DicomNode[] | null>(null);
  const [status, setStatus] = useState<DimseStatus | null>(null);
  const [imports, setImports] = useState<RemoteJob[]>([]);
  const [sends, setSends] = useState<RemoteJob[]>([]);
  const [drawer, setDrawer] = useState<Drawer>({ kind: 'closed' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [echoResult, setEchoResult] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    const fail = (e: unknown): void => setError(e instanceof Error ? e.message : String(e));
    dimseApi.nodes().then(setNodes, fail);
    dimseApi.status().then(setStatus, () => undefined);
    dimseApi.jobs('import', 100).then(setImports, () => undefined);
    dimseApi.jobs('send', 100).then(setSends, () => undefined);
  }, []);
  useEffect(load, [load]);

  const ourAet = status?.our_ae_title ?? '';

  const run = async (id: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const echo = (n: DicomNode): Promise<void> =>
    run(n.node_id, async () => {
      setEchoResult((m) => ({ ...m, [n.node_id]: t('ECHO 中…') }));
      try {
        const r = await dimseApi.echo(n.node_id);
        setEchoResult((m) => ({ ...m, [n.node_id]: r.ok ? `✓ ${r.latency_ms ?? '?'} ms` : t('✗ {p0}', { p0: r.error ?? t('失敗') }) }));
      } catch (e) {
        setEchoResult((m) => ({ ...m, [n.node_id]: `✗ ${e instanceof Error ? e.message : String(e)}` }));
        throw e;
      }
    });

  const save = (d: Drawer): Promise<void> => {
    if (d.kind === 'closed') return Promise.resolve();
    return run('save', async () => {
      const body = nodeBody(d.input);
      if (d.kind === 'new') await dimseApi.createNode(body);
      else await dimseApi.updateNode(d.node.node_id, body);
      setDrawer({ kind: 'closed' });
    });
  };

  const remove = (n: DicomNode): void => {
    if (!window.confirm(t('刪除節點「{name}」（{ae_title}）？', { name: n.name, ae_title: n.ae_title }))) return;
    void run(n.node_id, () => dimseApi.deleteNode(n.node_id));
  };

  const activity = (n: DicomNode): string => {
    const got = imports.filter((j) => (j as { detail?: { node_id?: string; calling_aet?: string } }).detail?.node_id === n.node_id || (j as { detail?: { calling_aet?: string } }).detail?.calling_aet === n.ae_title);
    const sent = sends.filter((j) => j.node?.ae_title === n.ae_title);
    const parts: string[] = [];
    if (got.length) parts.push(t('收到 {length} 批', { length: got.length }));
    if (sent.length) parts.push(t('送出 {length} 次{p1}', { length: sent.length, p1: sent[0]?.status === 'failed' ? t('（最近失敗）') : '' }));
    return parts.join(' · ') || '—';
  };

  return (
    <div className="dimse-nodes">
      <div className="dimse-ours">
        {status ? (
          <>
            {t('我方：AE')} <strong>{status.our_ae_title}</strong> · port {status.scp_port} ·{' '}
            {status.scp?.running ? <span className="ok">{t('接收中 ✓')}</span> : status.scp_enabled ? <span className="error-text">{t('接收端未啟動{p0}', { p0: status.scp_error ? t('：{scp_error}', { scp_error: status.scp_error }) : '' })}</span> : <span className="muted">{t('接收端關閉')}</span>}
          </>
        ) : (
          <span className="muted">…</span>
        )}
        <button type="button" className="linkish" onClick={props.onOpenService}>
          {t('→ 服務設定')}
        </button>
        <button type="button" className="primary" onClick={() => setDrawer({ kind: 'new', input: { ...EMPTY_NODE_INPUT } })}>
          {t('＋ 新增節點')}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {nodes === null ? (
        <p className="muted">{t('載入中…')}</p>
      ) : nodes.length === 0 ? (
        <p className="muted">{t('還沒有節點。新增一個 PACS／TPS：填它的 AE Title、IP、port，勾它扮演的角色。')}</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t('名稱')}</th>
              <th>AE Title</th>
              <th>{t('主機')}</th>
              <th>Port</th>
              <th>{t('角色')}</th>
              <th>{t('支援')}</th>
              <th>{t('最近 ECHO')}</th>
              <th>{t('活動')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.node_id}>
                <td title={n.description}>{n.name}</td>
                <td>
                  <code>{n.ae_title}</code>
                </td>
                <td className="muted">{n.host || '—'}</td>
                <td className="muted">{n.port || '—'}</td>
                <td>{rolesLabel(n)}</td>
                <td className="muted">{supportsLabel(n.supports)}</td>
                <td
                  className={busy === n.node_id ? 'muted' : n.last_echo_ok === true ? 'ok' : n.last_echo_ok === false ? 'error-text' : 'muted'}
                  title={n.last_echo_at ? t('最近一次：{p0}', { p0: new Date(n.last_echo_at).toLocaleString() }) : ''}
                >
                  {echoResult[n.node_id] ?? (n.last_echo_at ? `${n.last_echo_ok ? '✓' : '✗'} ${new Date(n.last_echo_at).toLocaleTimeString()}` : '—')}
                </td>
                <td className="muted">{activity(n)}</td>
                <td className="actions">
                  <button type="button" disabled={!n.roles.send || busy !== null} onClick={() => void echo(n)}>
                    ECHO
                  </button>
                  <button type="button" onClick={() => setDrawer({ kind: 'edit', node: n, input: nodeToInput(n, ourAet) })}>
                    {t('編輯')}
                  </button>
                  <button type="button" onClick={() => remove(n)}>
                    {t('刪')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {drawer.kind !== 'closed' && (
        <NodeDrawer
          drawer={drawer}
          ourAet={ourAet}
          busy={busy !== null}
          onChange={(input) => setDrawer({ ...drawer, input })}
          onClose={() => setDrawer({ kind: 'closed' })}
          onSave={() => void save(drawer)}
          onProbe={
            drawer.kind === 'edit'
              ? () =>
                  run('probe', async () => {
                    const r = await dimseApi.probe(drawer.node.node_id);
                    if (!r.ok) throw new Error(r.error ?? t('偵測失敗'));
                    setDrawer((d) => (d.kind === 'edit' ? { ...d, input: { ...d.input, supports: r.supports }, findTest: r.find_test ?? null } : d));
                  })
              : null
          }
        />
      )}
    </div>
  );
}

function NodeDrawer(props: {
  drawer: Exclude<Drawer, { kind: 'closed' }>;
  ourAet: string;
  busy: boolean;
  onChange: (input: NodeInput) => void;
  onClose: () => void;
  onSave: () => void;
  onProbe: (() => Promise<void>) | null;
}): React.JSX.Element {
  const { input } = props.drawer;
  const set = (patch: Partial<NodeInput>): void => props.onChange({ ...input, ...patch });
  const problems = nodeProblems(input);
  const touched = input.ae_title !== '' || input.host !== '';
  return (
    <aside className="node-drawer">
      <header>
        <h3>{props.drawer.kind === 'new' ? t('新增節點') : t('編輯 {name}', { name: props.drawer.node.name })}</h3>
        <button type="button" onClick={props.onClose} aria-label={t('關閉')}>
          ×
        </button>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (problems.length === 0 && !props.busy) props.onSave();
        }}
      >
        <label>
          {t('名稱')}
          <input value={input.name} placeholder="Eclipse TPS" onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label>
          AE Title <span className="muted">{t('（≤ 16，ASCII）')}</span>
          <input value={input.ae_title} placeholder="VMSDBD" onChange={(e) => set({ ae_title: e.target.value.toUpperCase() })} />
        </label>
        <fieldset className="roles">
          <legend>{t('角色')}</legend>
          <label>
            <input type="checkbox" checked={input.roles.send} onChange={(e) => set({ roles: { ...input.roles, send: e.target.checked } })} />
            {t('可送出（我方 → 它：ECHO／查詢／拉回／C-STORE）')}
          </label>
          <label>
            <input type="checkbox" checked={input.roles.receive} onChange={(e) => set({ roles: { ...input.roles, receive: e.target.checked } })} />
            {t('可接收（它 → 我方：允許它對我方 SCP 送 C-STORE）')}
          </label>
        </fieldset>
        <div className="row">
          <label>
            {t('主機／IP')}{input.roles.send ? '' : <span className="muted">{t('（只接收可留空）')}</span>}
            <input value={input.host} placeholder="192.0.2.30" onChange={(e) => set({ host: e.target.value })} />
          </label>
          <label>
            Port
            <input type="number" min={1} max={65535} value={input.port} onChange={(e) => set({ port: e.target.value === '' ? '' : Number(e.target.value) })} />
          </label>
        </div>
        {input.roles.receive && (
          <label>
            {t('只接受來自這個 IP')} <span className="muted">{t('（選配；空＝只認 AE Title）')}</span>
            <input value={input.inbound_ip} placeholder="198.51.100.11" onChange={(e) => set({ inbound_ip: e.target.value })} />
          </label>
        )}
        {input.roles.send && (
          <fieldset className="supports">
            <legend>
              {t('支援的服務')}
              {props.onProbe && (
                <button type="button" className="linkish" disabled={props.busy} onClick={() => void props.onProbe?.()}>
                  {t('用 C-ECHO 偵測')}
                </button>
              )}
            </legend>
            {CAPABILITIES.map((c) => (
              <label key={c}>
                <input type="checkbox" checked={input.supports[c] === true} onChange={(e) => set({ supports: { ...input.supports, [c]: e.target.checked } })} />
                {t(CAPABILITY_LABEL[c])}
              </label>
            ))}
            {props.drawer.kind === 'new' && <p className="muted small">{t('存檔後可在編輯裡「用 C-ECHO 偵測」自動填。')}</p>}
            {props.drawer.kind === 'edit' && props.drawer.findTest !== undefined && props.drawer.findTest !== null && (
              <p className={`small ${props.drawer.findTest.ok ? 'ok' : 'error-text'}`} data-find-test={props.drawer.findTest.ok ? 'ok' : 'fail'}>
                {props.drawer.findTest.ok ? t('C-FIND 實測：成功（查詢回 {status}）', { status: props.drawer.findTest.status ?? '' }) : t('C-FIND 實測：失敗 —— {error}', { error: props.drawer.findTest.error ?? '' })}
              </p>
            )}
          </fieldset>
        )}
        {input.roles.send && (
          <details>
            <summary className="muted">{t('進階：AE Title 覆寫、PDU、Transfer Syntax')}</summary>
            <label>
              {t('C-MOVE 目的地 AE Title')} <span className="muted">{t('（對方登錄我方時用的名字；空＝{p0}）', { p0: props.ourAet || t('全域') })}</span>
              <input value={input.move_destination_aet} onChange={(e) => set({ move_destination_aet: e.target.value.toUpperCase() })} />
            </label>
            <label>
              {t('我方呼叫用 AE Title')} <span className="muted">{t('（空＝{p0}）', { p0: props.ourAet || t('全域') })}</span>
              <input value={input.our_calling_aet} onChange={(e) => set({ our_calling_aet: e.target.value.toUpperCase() })} />
            </label>
            <label>
              {t('最大 PDU（bytes）')} <span className="muted">{t('（空＝預設 16382；有些舊系統要小一點）')}</span>
              <input type="number" min={4096} step={1024} value={input.max_pdu} placeholder="16382" onChange={(e) => set({ max_pdu: e.target.value === '' ? '' : Number(e.target.value) })} />
            </label>
            <label>
              {t('Transfer Syntax')}
              <select
                value={tsPresetOf(input.transfer_syntaxes)}
                onChange={(e) => {
                  const k = e.target.value as TsPreset;
                  if (k !== 'custom') set({ transfer_syntaxes: [...TS_PRESETS[k]] });
                }}
              >
                {(Object.keys(TS_PRESET_LABEL) as TsPreset[]).map((k) => (
                  <option key={k} value={k} disabled={k === 'custom' && tsPresetOf(input.transfer_syntaxes) !== 'custom'}>
                    {t(TS_PRESET_LABEL[k])}
                  </option>
                ))}
              </select>
            </label>
          </details>
        )}
        <label>
          {t('說明')}
          <input value={input.description} onChange={(e) => set({ description: e.target.value })} />
        </label>
        {touched && problems.length > 0 && <p className="warning">{joinClauses(problems)}</p>}
        <div className="buttons">
          <button type="button" onClick={props.onClose}>
            {t('取消')}
          </button>
          <button type="submit" className="primary" disabled={props.busy || problems.length > 0}>
            {t('儲存')}
          </button>
        </div>
      </form>
    </aside>
  );
}
