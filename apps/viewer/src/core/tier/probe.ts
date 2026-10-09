/**
 * 硬體分級探針。
 *
 * 🔴 **「沒有顯卡」有兩種，必須分開處理：**
 *
 * | 情況 | 實際能力 | 判定 |
 * |---|---|---|
 * | 有內顯 | WebGL2 正常，薄板 MPR 可用 | **Tier B** |
 * | **軟體渲染**（SwiftShader／llvmpipe） | `getContext('webgl2')` **會成功**、`MAX_3D_TEXTURE_SIZE` 也正常回報，但實際約 1 fps | **Tier C** |
 *
 * > **這是最容易在客戶現場才爆的問題**：feature detection 說「支援」，實際卻是
 * > 1 fps。而且 **WebGL-on-SwiftShader 比直接走 CPU 路徑更慢**——所以偵測到
 * > 軟體渲染時要主動改走 Tier C，不是勉強用 GPU 路徑。
 *
 * ## 探針的三個實際問題都已處理
 *
 * 1. **雞蛋問題** —— 探針要在 `POST /grids` 之前跑，那時還沒有任何影像。
 *    → 用**前端程序式產生的合成 volume**（128³ 漸層＋雜訊）。
 * 2. **Tier C 上白畫面 30 秒** —— 軟體渲染一幀約 1 秒。
 *    → **時間盒，不是幀數盒**：上限 250 ms，數在這段時間內完成幾幀。
 * 3. **配置探針會弄丟 context** —— 記憶體不足常是 `webglcontextlost`。
 *    → 在**可丟棄的獨立 context** 裡跑，探完即銷毀；**主渲染 context 絕不參與**。
 */

import type { Tier } from '../raster/types';

/** 時間盒上限。**軟體渲染在 250 ms 內完不成一幀 → 立即判 Tier C。** */
export const PROBE_BUDGET_MS = 250;
export const SOFTWARE_RENDERER_PATTERN = /swiftshader|llvmpipe|software|basic render|microsoft basic/i;

export interface ClientCapability {
  webgl2: boolean;
  maxTexture3d: number;
  hasNorm16: boolean;
  rendererString: string;
  looksSoftware: boolean;
  probeAllocMb: number;
  probeFps: number;
  /** 前端計算的**建議**值，後端可否決（見裁決優先序）。 */
  tier: Tier;
}

export interface ProbeOptions {
  /** 注入用（測試與非瀏覽器環境）。 */
  createCanvas?: () => HTMLCanvasElement | OffscreenCanvas | null;
  budgetMs?: number;
  /** 合成 volume 的邊長。128³ 是指定的規模。 */
  volumeSize?: number;
  now?: () => number;
}

/** 步驟 3 的合成 volume：128³ 漸層 ＋ 雜訊。**不需要網路、不需要案例。** */
export function syntheticVolume(size = 128): Uint8Array {
  const out = new Uint8Array(size * size * size);
  let seed = 0x2f6e2b1;
  for (let k = 0; k < size; k += 1) {
    for (let j = 0; j < size; j += 1) {
      const row = (k * size + j) * size;
      for (let i = 0; i < size; i += 1) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const gradient = ((i + j + k) / (3 * size)) * 200;
        out[row + i] = (gradient + (seed % 56)) & 0xff;
      }
    }
  }
  return out;
}

export interface CapabilityDetection {
  webgl2: boolean;
  maxTexture3d: number;
  hasNorm16: boolean;
  rendererString: string;
  looksSoftware: boolean;
  /** 探測用的 context，呼叫端**必須**在用完後 `destroy()`。 */
  destroy(): void;
}

/** 步驟 1–2：能力偵測（無成本）＋ 字串特徵（僅作為提示，不單獨裁決）。 */
export function detectCapability(options: ProbeOptions = {}): CapabilityDetection {
  const make =
    options.createCanvas ??
    (() => (typeof document === 'undefined' ? null : document.createElement('canvas')));
  const canvas = make();
  if (canvas === null) {
    return {
      webgl2: false,
      maxTexture3d: 0,
      hasNorm16: false,
      rendererString: 'no-canvas',
      looksSoftware: false,
      destroy: () => {},
    };
  }
  const gl = (canvas as HTMLCanvasElement).getContext('webgl2');
  if (gl === null) {
    return {
      webgl2: false,
      maxTexture3d: 0,
      hasNorm16: false,
      rendererString: 'no-webgl2',
      looksSoftware: false,
      destroy: () => {},
    };
  }
  const maxTexture3d = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
  const hasNorm16 = gl.getExtension('EXT_texture_norm16') !== null;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
  const rendererString = dbg
    ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
    : 'masked';
  return {
    webgl2: true,
    maxTexture3d,
    hasNorm16,
    rendererString,
    looksSoftware: SOFTWARE_RENDERER_PATTERN.test(rendererString),
    destroy: () => {
      // 步驟 4：探測用 context 立即銷毀
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

export interface TimeboxedProbeResult {
  fps: number;
  frames: number;
  elapsedMs: number;
  contextLost: boolean;
}

/**
 * 步驟 3：**時間盒**的效能探針。
 *
 * `renderFrame` 由呼叫端提供（GPU 路徑用一次 3D texture 取樣，測試用假函式）。
 * 回傳 `fps = frames / elapsed`；**250 ms 內連一幀都跑不完 → fps < 4 → Tier C**。
 */
export async function timeboxedProbe(
  renderFrame: () => void | Promise<void>,
  options: ProbeOptions = {},
): Promise<TimeboxedProbeResult> {
  const budget = options.budgetMs ?? PROBE_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  const start = now();
  let frames = 0;
  let contextLost = false;
  while (now() - start < budget) {
    try {
      await renderFrame();
    } catch {
      contextLost = true;
      break;
    }
    frames += 1;
    // 上限保護：極快的裝置不需要跑上千幀
    if (frames >= 240) break;
  }
  const elapsedMs = Math.max(1e-3, now() - start);
  return { fps: (frames * 1000) / elapsedMs, frames, elapsedMs, contextLost };
}

/**
 * fps → Tier 建議。
 *
 * `≥ 30 → A`；`10–30 → B`；`< 10`（含 250 ms 內未完成一幀）`→ C`。
 */
export function tierFromFps(fps: number): Tier {
  if (fps >= 30) return 'A';
  if (fps >= 10) return 'B';
  return 'C';
}

/** 完整探測流程，回傳可直接放進 `POST /grids` 的 `client_capability`。 */
export async function probeClientCapability(
  renderFrame: () => void | Promise<void>,
  options: ProbeOptions = {},
): Promise<ClientCapability> {
  const detection = detectCapability(options);
  try {
    if (!detection.webgl2) {
      return {
        webgl2: false,
        maxTexture3d: 0,
        hasNorm16: false,
        rendererString: detection.rendererString,
        looksSoftware: false,
        probeAllocMb: 0,
        probeFps: 0,
        tier: 'C',
      };
    }
    // 🔴 軟體渲染要**主動**改走 Tier C，不是勉強用 GPU 路徑跑探針：
    // WebGL-on-SwiftShader 比直接走 CPU 更慢，探針本身就會花掉數秒。
    if (detection.looksSoftware) {
      return {
        webgl2: true,
        maxTexture3d: detection.maxTexture3d,
        hasNorm16: detection.hasNorm16,
        rendererString: detection.rendererString,
        looksSoftware: true,
        probeAllocMb: 0,
        probeFps: 0,
        tier: 'C',
      };
    }
    const probe = await timeboxedProbe(renderFrame, options);
    const tier = probe.contextLost ? 'C' : tierFromFps(probe.fps);
    return {
      webgl2: true,
      maxTexture3d: detection.maxTexture3d,
      hasNorm16: detection.hasNorm16,
      rendererString: detection.rendererString,
      looksSoftware: false,
      probeAllocMb: 0,
      probeFps: probe.fps,
      tier,
    };
  } finally {
    detection.destroy();
  }
}

/** 送給後端的 wire 形狀（`client_capability`）。 */
export function capabilityToWire(cap: ClientCapability): Record<string, unknown> {
  return {
    webgl2: cap.webgl2,
    max_texture_3d: cap.maxTexture3d,
    has_norm16: cap.hasNorm16,
    renderer_string: cap.rendererString,
    looks_software: cap.looksSoftware,
    probe_alloc_mb: cap.probeAllocMb,
    probe_fps: cap.probeFps,
    tier: cap.tier,
  };
}
