/**
 * BEV 的 DRR：抓、解碼、快取 —— 計畫面板的 BEV 與 3D 格的小 BEV 共用。
 *
 * * 同一個請求（射束、CP、大小、對比、結構）只抓一次（記憶體裡留最近 48 張）。
 * * 停下來：200 ms 後抓全尺寸（256）。播放中：抓小張（128），一次只跑一個請求，跑完再抓「現在」的 CP ——
 *   伺服器算得多快，背景就跟多快，不會排一長串過期的請求。
 * * 新的一張到之前沿用上一張（不閃爍）。
 */

import { useEffect, useRef, useState } from 'react';

import type { ViewerApi } from '../../../core';
import { DRR_SIZE, DRR_SIZE_SMALL, drrPath, type DrrPreset, type DrrResponse } from './model';

export interface LoadedDrr {
  readonly image: HTMLImageElement;
  readonly resp: DrrResponse;
}

const CACHE_MAX = 48;
const cache = new Map<string, Promise<LoadedDrr>>();

function load(path: string, getJson: <T>(p: string) => Promise<T>): Promise<LoadedDrr> {
  let p = cache.get(path);
  if (p === undefined) {
    p = getJson<DrrResponse>(path).then(
      (resp) =>
        new Promise<LoadedDrr>((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve({ image, resp });
          image.onerror = () => reject(new Error('DRR image decode failed'));
          image.src = `data:image/png;base64,${resp.png_base64}`;
        }),
    );
    p.catch(() => cache.delete(path));
    cache.set(path, p);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  return p;
}

export interface BevDrrArgs {
  readonly studyId: string;
  readonly planId: string;
  readonly beam: number;
  readonly cp: number;
  readonly halfMm: number;
  readonly preset: DrrPreset;
  readonly wc: number;
  readonly ww: number;
  readonly structureIds: readonly string[];
  /** 播放中（小張、一次一個請求）。 */
  readonly playing: boolean;
  /** 強制小張（3D 格的小 BEV）。 */
  readonly small?: boolean;
}

export function useBevDrr(http: Pick<ViewerApi['http'], 'getJson'>, args: BevDrrArgs | null): { drr: LoadedDrr | null; error: string | null } {
  const [drr, setDrr] = useState<LoadedDrr | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const pending = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const path =
    args === null
      ? null
      : drrPath(args.studyId, args.planId, args.beam, {
          cp: args.cp,
          halfMm: args.halfMm,
          preset: args.preset,
          wc: args.wc,
          ww: args.ww,
          structureIds: args.structureIds,
          size: args.small || args.playing ? DRR_SIZE_SMALL : DRR_SIZE,
        });
  const playing = args?.playing ?? false;
  const getJson = http.getJson.bind(http);
  const getJsonRef = useRef(getJson);
  getJsonRef.current = getJson;

  useEffect(() => {
    if (path === null) return undefined;
    const start = (p: string): void => {
      inFlight.current = true;
      load(p, getJsonRef.current).then(
        (d) => {
          if (!alive.current) return;
          setDrr(d);
          setError(null);
        },
        (e: unknown) => {
          if (alive.current) setError(e instanceof Error ? e.message : String(e));
        },
      ).finally(() => {
        inFlight.current = false;
        const next = pending.current;
        pending.current = null;
        if (next !== null && next !== p && alive.current) start(next);
      });
    };
    if (playing) {
      if (inFlight.current) pending.current = path;
      else start(path);
      return undefined;
    }
    const timer = setTimeout(() => {
      if (inFlight.current) pending.current = path;
      else start(path);
    }, 200);
    return () => clearTimeout(timer);
  }, [path, playing]);
  return { drr: args === null ? null : drr, error: args === null ? null : error };
}
