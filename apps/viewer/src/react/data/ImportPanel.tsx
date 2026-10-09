/**
 * 匯入面板 —— 資料頁右側抽屜：拖曳資料夾／檔案／zip、伺服器目錄一鍵匯入、批次進度與結果、最近批次。
 *
 * 流程：選檔 → 本機前導檢查（`importModel.precheck`）→ 開批次 → 併行 6 上傳 → complete → 輪詢到結束 →
 * 顯示計數與需要人看的項目 → 通知資料頁刷新樹。純邏輯在 `importModel.ts`、fetch 在 `catalogApi.ts`。
 * 底下另有「從節點拉」（`RemotePull.tsx`：C-FIND → C-MOVE／C-GET）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { importApi } from './catalogApi';
import { RemotePull } from './RemotePull';
import {
  attention,
  formatBytesShort,
  isTerminal,
  precheck,
  runWithConcurrency,
  summarizeCounts,
  UPLOAD_CONCURRENCY,
  type Candidate,
  type ImportBatch,
  type Precheck,
} from './importModel';
import { joinList, t } from '../../core/i18n';

type Stage =
  | { kind: 'idle' }
  | { kind: 'prechecking'; total: number }
  | { kind: 'ready'; pre: Precheck; files: Map<string, File> }
  | { kind: 'uploading'; batchId: string; done: number; total: number; failed: number }
  | { kind: 'processing'; batch: ImportBatch }
  | { kind: 'finished'; batch: ImportBatch }
  | { kind: 'error'; message: string };

const POLL_MS = 800;

export function ImportPanel(props: { onClose: () => void; onImported: (batch?: ImportBatch) => void }): React.JSX.Element {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [recent, setRecent] = useState<ImportBatch[]>([]);
  const [serverPath, setServerPath] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const dirInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);

  const refreshRecent = useCallback(() => {
    void importApi.list().then(setRecent, () => undefined);
  }, []);
  useEffect(refreshRecent, [refreshRecent]);

  // 讓 <input> 可以選資料夾（React 的型別沒有 webkitdirectory）
  useEffect(() => {
    dirInput.current?.setAttribute('webkitdirectory', '');
    dirInput.current?.setAttribute('directory', '');
  }, []);

  const poll = useCallback(
    async (batchId: string): Promise<void> => {
      for (;;) {
        if (cancelled.current) return;
        const b = await importApi.get(batchId);
        if (isTerminal(b.status)) {
          setStage({ kind: 'finished', batch: b });
          refreshRecent();
          if (b.status === 'done') props.onImported(b);
          return;
        }
        setStage({ kind: 'processing', batch: b });
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    },
    [props, refreshRecent],
  );

  const accept = async (files: readonly { file: File; relativePath: string }[]): Promise<void> => {
    if (files.length === 0) return;
    setStage({ kind: 'prechecking', total: files.length });
    const map = new Map(files.map((f) => [f.relativePath, f.file]));
    const candidates: Candidate[] = files.map((f) => ({
      relativePath: f.relativePath,
      size: f.file.size,
      head: async () => new Uint8Array(await f.file.slice(0, 132).arrayBuffer()),
    }));
    try {
      const pre = await precheck(candidates);
      setStage({ kind: 'ready', pre, files: map });
    } catch (e) {
      setStage({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const start = async (pre: Precheck, files: Map<string, File>): Promise<void> => {
    cancelled.current = false;
    try {
      const batch = await importApi.open({ files: pre.upload.length, bytes: pre.bytes });
      setStage({ kind: 'uploading', batchId: batch.batch_id, done: 0, total: pre.upload.length, failed: 0 });
      let failed = 0;
      await runWithConcurrency(
        pre.upload,
        UPLOAD_CONCURRENCY,
        async (c) => {
          const file = files.get(c.relativePath);
          if (!file) throw new Error(t('找不到 {relativePath}', { relativePath: c.relativePath }));
          // 單檔失敗重試兩次（瀏覽器在大量小請求時偶爾會自己取消一個）
          for (let attempt = 0; ; attempt += 1) {
            try {
              return await importApi.putFile(batch.batch_id, c.relativePath, file);
            } catch (e) {
              if (attempt >= 2 || cancelled.current) throw e;
              await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
            }
          }
        },
        (done, total) =>
          setStage((s) => (s.kind === 'uploading' ? { ...s, done, total, failed } : s)),
      ).then((results) => {
        failed = results.filter((r) => r.status === 'rejected').length;
        setStage((s) => (s.kind === 'uploading' ? { ...s, failed } : s));
      });
      if (cancelled.current) {
        await importApi.discard(batch.batch_id);
        setStage({ kind: 'idle' });
        return;
      }
      const started = await importApi.complete(batch.batch_id);
      setStage({ kind: 'processing', batch: started });
      await poll(batch.batch_id);
    } catch (e) {
      setStage({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const startServerPath = async (): Promise<void> => {
    const path = serverPath.trim();
    if (!path) return;
    cancelled.current = false;
    try {
      const batch = await importApi.serverPath(path);
      setStage({ kind: 'processing', batch });
      await poll(batch.batch_id);
    } catch (e) {
      setStage({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    setDragOver(false);
    const files = await filesFromDataTransfer(e.dataTransfer);
    await accept(files);
  };

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const list = e.target.files;
    if (!list) return;
    const files = Array.from(list).map((file) => ({
      file,
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    }));
    e.target.value = '';
    await accept(files);
  };

  return (
    <aside className="import-panel">
      <header>
        <h3>{t('匯入 DICOM')}</h3>
        <button type="button" onClick={props.onClose} aria-label={t('關閉')}>
          ×
        </button>
      </header>

      {(stage.kind === 'idle' || stage.kind === 'error' || stage.kind === 'finished') && (
        <>
          <div
            className={`dropzone${dragOver ? ' over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => void onDrop(e)}
          >
            <p>{t('把資料夾、DICOM 檔或 zip 拖到這裡')}</p>
            <div className="buttons">
              <button type="button" onClick={() => dirInput.current?.click()}>
                {t('選資料夾…')}
              </button>
              <button type="button" onClick={() => fileInput.current?.click()}>
                {t('選檔案／zip…')}
              </button>
            </div>
            <input ref={dirInput} type="file" multiple hidden onChange={(e) => void onPick(e)} />
            <input ref={fileInput} type="file" multiple hidden accept=".dcm,.zip,application/dicom,application/zip" onChange={(e) => void onPick(e)} />
            <p className="muted">
              {t('本機只看每個檔的')} <code>DICM</code> {t('前導決定要不要上傳，不解標頭；zip 在伺服器端解。同一 SOP UID 不同內容會被拒絕，不覆寫。')}
            </p>
          </div>
          <form
            className="server-path"
            onSubmit={(e) => {
              e.preventDefault();
              void startServerPath();
            }}
          >
            <label>
              {t('伺服器上的目錄')}
              <input value={serverPath} placeholder="/mnt/export/2026-09/patient_x" onChange={(e) => setServerPath(e.target.value)} />
            </label>
            <button type="button" disabled={!serverPath.trim()} onClick={() => void startServerPath()}>
              {t('匯入（複製，不動原目錄）')}
            </button>
          </form>
          <RemotePull
            onImported={() => {
              refreshRecent();
              props.onImported();
            }}
          />
        </>
      )}

      {stage.kind === 'prechecking' && <p className="muted">{t('檢查 {total} 個檔案的 DICM 前導…', { total: stage.total })}</p>}

      {stage.kind === 'ready' && (
        <div className="import-ready">
          <p>
            {t('要上傳')} <strong>{stage.pre.upload.length}</strong> {t('個檔（{p0}）{p1}', { p0: formatBytesShort(stage.pre.bytes), p1: stage.pre.skipped.length > 0 ? t('，跳過 {length} 個非 DICOM', { length: stage.pre.skipped.length }) : '' })}
          </p>
          {stage.pre.skipped.length > 0 && (
            <details>
              <summary className="muted">{t('跳過的檔案')}</summary>
              <ul className="small">
                {stage.pre.skipped.slice(0, 50).map((s) => (
                  <li key={s.relativePath}>
                    {s.relativePath} <span className="muted">— {s.reason}</span>
                  </li>
                ))}
                {stage.pre.skipped.length > 50 && <li className="muted">{t('…還有 {p0} 個', { p0: stage.pre.skipped.length - 50 })}</li>}
              </ul>
            </details>
          )}
          <div className="buttons">
            <button type="button" onClick={() => setStage({ kind: 'idle' })}>
              {t('取消')}
            </button>
            <button type="button" className="primary" disabled={stage.pre.upload.length === 0} onClick={() => void start(stage.pre, stage.files)}>
              {t('開始上傳')}
            </button>
          </div>
        </div>
      )}

      {stage.kind === 'uploading' && (
        <div className="import-progress">
          <p>
            {t('上傳中{done} / {total}', { done: stage.done, total: stage.total })}
            {stage.failed > 0 ? <span className="error">{t('（{failed} 個失敗）', { failed: stage.failed })}</span> : null}
          </p>
          <progress value={stage.done} max={stage.total} />
          <button
            type="button"
            onClick={() => {
              cancelled.current = true;
            }}
          >
            {t('取消')}
          </button>
        </div>
      )}

      {stage.kind === 'processing' && (
        <div className="import-progress">
          <p>
            {t('伺服器處理中：{p0} {percent}%', { p0: phaseLabel(stage.batch.phase), percent: stage.batch.percent })}
          </p>
          <progress value={stage.batch.percent} max={100} />
          <p className="muted">{summarizeCounts(stage.batch.counts)}</p>
        </div>
      )}

      {stage.kind === 'finished' && <BatchResult batch={stage.batch} />}
      {stage.kind === 'error' && <p className="error">{stage.message}</p>}

      <section className="recent">
        <h4>{t('最近的批次')}</h4>
        {recent.length === 0 ? (
          <p className="muted">{t('（還沒有）')}</p>
        ) : (
          <ul className="small">
            {recent.slice(0, 10).map((b) => (
              <li key={b.batch_id}>
                <span className={`status ${b.status}`}>{statusLabel(b.status)}</span> {b.source === 'server_path' ? t('目錄') : t('上傳')} ·{' '}
                {formatTime(b.created_at)} · {summarizeCounts(b.counts)}
                {b.error ? <span className="error"> {b.error}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

function BatchResult(props: { batch: ImportBatch }): React.JSX.Element {
  const b = props.batch;
  const needs = attention(b.items ?? []);
  return (
    <div className={`import-result ${b.status}`}>
      <p>
        <strong>{statusLabel(b.status)}</strong> · {summarizeCounts(b.counts)}
        {b.touched_patient_ids.length > 0 ? t(' · 病人 {p0}', { p0: joinList(b.touched_patient_ids) }) : ''}
      </p>
      {b.error && <p className="error">{b.error}</p>}
      {(b.undecodable ?? []).length > 0 && (
        <div className="import-undecodable" role="alert">
          <p>
            <span className="badge undecodable">{t('無法解碼')}</span>{' '}
            {t('收下了 {n} 個序列，但壓縮格式目前無法解碼：檔案已存進資料庫，可以下載或轉送，但無法在檢視器開啟。', { n: (b.undecodable ?? []).length })}
          </p>
          <ul className="small">
            {(b.undecodable ?? []).map((u) => (
              <li key={u.series_instance_uid}>
                {u.modality} · {t('{count} 檔', { count: u.count })} · {u.transfer_syntax} <span className="muted uid">{u.series_instance_uid}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {needs.length > 0 && (
        <details open>
          <summary>{t('需要看一下的 {length} 個', { length: needs.length })}</summary>
          <ul className="small">
            {needs.slice(0, 100).map((it) => (
              <li key={it.relative_path}>
                <span className={`outcome ${it.outcome}`}>{it.outcome === 'rejected' ? t('拒絕') : t('同 UID 不同內容')}</span> {it.relative_path}{' '}
                <span className="muted">— {it.reason}</span>
              </li>
            ))}
            {needs.length > 100 && <li className="muted">{t('…還有 {p0} 個', { p0: needs.length - 100 })}</li>}
          </ul>
        </details>
      )}
    </div>
  );
}

function phaseLabel(phase: string): string {
  return { open: t('等待'), validate: t('驗證與去重'), index: t('重建索引'), done: t('完成'), failed: t('失敗') }[phase] ?? phase;
}

function statusLabel(status: string): string {
  return { open: t('開啟'), running: t('處理中'), done: t('完成'), failed: t('失敗'), discarded: t('已丟棄') }[status] ?? status;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** 拖進來的可能是資料夾（要遞迴列）或檔案。 */
async function filesFromDataTransfer(dt: DataTransfer): Promise<{ file: File; relativePath: string }[]> {
  const out: { file: File; relativePath: string }[] = [];
  const items = Array.from(dt.items ?? []);
  const entries = items
    .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e !== null);
  if (entries.length === 0) {
    for (const file of Array.from(dt.files ?? [])) out.push({ file, relativePath: file.name });
    return out;
  }
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, relativePath: `${prefix}${entry.name}` });
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const chunk = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (chunk.length === 0) break;
        for (const child of chunk) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}
