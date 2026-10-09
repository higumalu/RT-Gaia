/** 容量與完整性的 API 型別與呼叫。 */

import { call } from '../dimse/dimseApi';

export interface StorageVolume {
  readonly labels: readonly string[];
  /** 只有管理者拿得到。 */
  readonly path?: string;
  readonly total: number;
  readonly used: number;
  readonly free: number;
  readonly percent: number;
  readonly warn: boolean;
}

export interface StorageStatus {
  readonly checked_at: string;
  readonly threshold: number;
  readonly volumes: readonly StorageVolume[];
  readonly warn: boolean;
}

export interface IntegrityProblem {
  readonly path: string;
  readonly sop_instance_uid: string;
  readonly verify_status: 'missing' | 'mismatch';
  readonly verified_at: string | null;
  readonly detail: string;
}

export interface IntegritySummary {
  readonly total_files: number;
  readonly registered: number;
  readonly verified: number;
  readonly oldest_verified_at: string | null;
  readonly problems: readonly IntegrityProblem[];
  readonly batch: number;
  readonly last_run: { ran_at: string | null; checked: number; total_files: number; retired: number; problem_count: number } | null;
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const storageApi = {
  status: (): Promise<StorageStatus> => call('/storage/status'),
  integrity: (): Promise<IntegritySummary> => call('/storage/integrity'),
  runIntegrity: (batch?: number): Promise<{ checked: number; problems: IntegrityProblem[] }> => call('/storage/integrity/run', json('POST', batch ? { batch } : {})),
  rebaseline: (paths: readonly string[]): Promise<unknown> => call('/storage/integrity/rebaseline', json('POST', { paths })),
};
