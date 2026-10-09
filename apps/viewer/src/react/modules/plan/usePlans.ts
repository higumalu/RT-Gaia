/** 病例的計畫：工具列與面板共用同一份抓取（`fetchPlans` 依 study 快取）。 */

import { useEffect, useState } from 'react';

import type { ViewerApi } from '../../../core';
import { fetchPlans, type PlanInfo } from './model';

export interface PlansState {
  readonly plans: readonly PlanInfo[];
  readonly loading: boolean;
  readonly error: string | null;
}

export function usePlans(api: Pick<ViewerApi, 'http'> & { state: Pick<ViewerApi['state'], 'studyId' | 'caseId'> }): PlansState {
  const studyId = api.state.studyId;
  const caseId = api.state.caseId;
  const [st, setSt] = useState<PlansState>({ plans: [], loading: studyId !== null, error: null });
  const { http } = api;
  useEffect(() => {
    if (studyId === null) {
      setSt({ plans: [], loading: false, error: null });
      return undefined;
    }
    let cancelled = false;
    setSt((s) => ({ ...s, loading: true, error: null }));
    fetchPlans(studyId, http.getJson.bind(http), `${studyId}#${caseId ?? ''}`).then(
      (r) => {
        if (!cancelled) setSt({ plans: r.plans, loading: false, error: null });
      },
      (e: unknown) => {
        if (!cancelled) setSt({ plans: [], loading: false, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [studyId, caseId, http]);
  return st;
}
