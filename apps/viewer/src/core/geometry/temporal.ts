/**
 * `TemporalGroup` —— 時間／相位軸。
 *
 * > 🔴 **時間軸不是「將來要擴充的缺口」，而是核心空間定義的一部分。**
 *
 * ## 前端型別比後端多兩個欄位
 *
 * `cursor` 與 `playback` **只存在於前端**（游標與播放狀態是前端狀態，
 * 不需端點）。後端的 `TemporalGroup` 沒有它們，因此 wire 上也不該出現——
 * 送過去會被忽略，讀回來時要補上本地預設值。
 */

import { require_ } from './errors';
import { t } from '../i18n';

export type TemporalKind = 'cyclic' | 'series' | 'stream';

export interface PlaybackState {
  playing: boolean;
  fps: number;
  loop: boolean;
}

export interface TemporalGroup {
  readonly temporalGroupId: string;
  readonly kind: TemporalKind;
  /** `stream` 為 null（長度無上限，只有視窗常駐）。 */
  readonly frameCount: number | null;
  /** T2/T3 的實際時間戳（秒）。 */
  readonly frameTimes?: Float64Array;
  /** T4 參數軸用（"b_value" / "echo_time" / …）；4D 另有 "phase"／"amplitude"（4DCT）。 */
  readonly axisLabel: string;
  /** 每一幀的名字（「40%」「In 75%」「b 500」「TE 4.8 ms」）。 */
  readonly frameLabels?: readonly string[];
  /** 參數軸的單位（"ms"、"s/mm²"）。 */
  readonly unit?: string;
  /** 🔴 前端狀態：目前相位／時間點。 */
  cursor: number;
  /** 🔴 前端狀態。 */
  playback: PlaybackState;
}

export const DEFAULT_PLAYBACK: PlaybackState = { playing: false, fps: 10, loop: true };

export function createTemporalGroup(tg: TemporalGroup): TemporalGroup {
  require_(tg.temporalGroupId.length > 0, 'T2', t('temporalGroupId 必填'));
  if (tg.kind === 'stream') {
    require_(tg.frameCount === null, 'T3', t('kind=stream 的 frameCount 必須為 null'), {
      frameCount: tg.frameCount,
    });
  } else {
    require_(
      typeof tg.frameCount === 'number' && Number.isInteger(tg.frameCount) && tg.frameCount >= 1,
      'T3',
      t('kind=cyclic/series 必須有 frameCount >= 1'),
      { frameCount: tg.frameCount },
    );
  }
  if (tg.frameTimes && tg.frameCount !== null) {
    require_(tg.frameTimes.length === tg.frameCount, 'T4', t('frameTimes 長度必須等於 frameCount'));
  }
  return tg;
}

export function validateFrameIndex(tg: TemporalGroup, frameIndex: number | null): void {
  require_(frameIndex !== null, 'T6', t('屬於 TemporalGroup 的物件必須指定 frameIndex'), {
    temporalGroupId: tg.temporalGroupId,
  });
  require_(Number.isInteger(frameIndex) && frameIndex! >= 0, 'T6', t('frameIndex 必須是非負整數'), {
    frameIndex,
  });
  if (tg.frameCount !== null) {
    require_(frameIndex! < tg.frameCount, 'T6', t('frameIndex 超出 frameCount'), {
      frameIndex,
      frameCount: tg.frameCount,
    });
  }
}

/**
 * 相位游標前進。
 *
 * `cyclic` 迴繞、`series` 到底停住、`stream` 無上限（視窗由後端端點供給）。
 * **相位游標屬於「時間群組」，不是全域**：一顆 4DCT 的 10 個相位、
 * 它的 DVF、它各相位的輪廓共用同一個游標；一段 8 Hz 的 cine MR 不能跟它同步。
 */
export function advanceCursor(tg: TemporalGroup, delta = 1): number {
  const next = tg.cursor + delta;
  if (tg.frameCount === null) return Math.max(0, next);
  if (tg.kind === 'cyclic' || tg.playback.loop) {
    return ((next % tg.frameCount) + tg.frameCount) % tg.frameCount;
  }
  return Math.min(Math.max(0, next), tg.frameCount - 1);
}

/**
 * 播放中該用哪個品質狀態。
 *
 * **播放與靜止是兩種品質狀態**：播放中一律低解析度，暫停後補到全解析度。
 */
export function playbackQuality(tg: TemporalGroup): 'interactive' | 'final' {
  return tg.playback.playing ? 'interactive' : 'final';
}

/**
 * 播放範圍 `[from, to]`（含兩端，順序不拘）內前進 `delta` 格。游標在範圍外 → 跳進範圍（往前走到開頭、往後走到結尾）；
 * 出界時循環就繞回、不循環就停在邊上並回報 `stop`（播放該停了）。
 */
export function stepInRange(args: { cursor: number; delta: number; from: number; to: number; loop: boolean }): { frame: number; stop: boolean } {
  const from = Math.min(args.from, args.to);
  const to = Math.max(args.from, args.to);
  const span = to - from + 1;
  if (args.cursor < from || args.cursor > to) return { frame: args.delta >= 0 ? from : to, stop: false };
  const next = args.cursor + args.delta;
  if (next >= from && next <= to) return { frame: next, stop: false };
  if (args.loop) return { frame: from + ((((next - from) % span) + span) % span), stop: false };
  return { frame: Math.min(to, Math.max(from, next)), stop: true };
}
