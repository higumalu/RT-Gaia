/**
 * 硬體分級。
 *
 * 🔴 **這是最容易在客戶現場才爆的問題**：feature detection 說「支援」，
 * 實際卻是 1 fps。
 */

import { describe, expect, it } from 'vitest';

import {
  arbitrate,
  budgetFor,
  capabilityToWire,
  detectCapability,
  hardCapabilityTier,
  imageBytesPerVoxel,
  initialYieldState,
  PROBE_BUDGET_MS,
  probeClientCapability,
  SOFTWARE_RENDERER_PATTERN,
  syntheticVolume,
  tierFromFps,
  timeboxedProbe,
  VISIBLE_STRUCTURE_LIMIT,
  yieldOnFailure,
  yieldOnSuccess,
  type ClientCapability,
} from '../src/core';

/** 假的 WebGL2 context —— 探針要能在 Node 下測，否則這一整套只能靠現場踩雷。 */
function fakeCanvas(options: {
  webgl2: boolean;
  renderer: string;
  max3d?: number;
  norm16?: boolean;
}): () => HTMLCanvasElement {
  return () =>
    ({
      getContext: (id: string) => {
        if (id !== 'webgl2' || !options.webgl2) return null;
        return {
          MAX_3D_TEXTURE_SIZE: 0x8073,
          getParameter: (p: number) => (p === 0x8073 ? (options.max3d ?? 2048) : options.renderer),
          getExtension: (name: string) => {
            if (name === 'EXT_texture_norm16') return options.norm16 === false ? null : {};
            if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: 0x9246 };
            if (name === 'WEBGL_lose_context') return { loseContext: () => {} };
            return null;
          },
        };
      },
    }) as unknown as HTMLCanvasElement;
}

describe('軟體渲染會謊報自己支援 WebGL2', () => {
  it.each(['SwiftShader', 'llvmpipe (LLVM 15)', 'Software Rasterizer', 'Microsoft Basic Render Driver'])(
    '%s 被判定為軟體渲染',
    (renderer) => {
      expect(SOFTWARE_RENDERER_PATTERN.test(renderer)).toBe(true);
    },
  );

  it.each(['NVIDIA RTX A2000/PCIe/SSE2', 'Intel(R) UHD Graphics 630', 'Apple M2'])(
    '%s 不是軟體渲染',
    (renderer) => {
      expect(SOFTWARE_RENDERER_PATTERN.test(renderer)).toBe(false);
    },
  );

  it('偵測到軟體渲染時**主動**改走 Tier C，不勉強跑 GPU 探針', async () => {
    let probeRan = false;
    const cap = await probeClientCapability(
      () => {
        probeRan = true;
      },
      { createCanvas: fakeCanvas({ webgl2: true, renderer: 'Google SwiftShader' }) },
    );
    expect(cap.tier).toBe('C');
    expect(cap.looksSoftware).toBe(true);
    // WebGL-on-SwiftShader 比直接走 CPU 更慢，探針本身就會花掉數秒
    expect(probeRan).toBe(false);
  });

  it('沒有 WebGL2 直接判 Tier C', async () => {
    const cap = await probeClientCapability(() => {}, {
      createCanvas: fakeCanvas({ webgl2: false, renderer: '' }),
    });
    expect(cap.tier).toBe('C');
    expect(cap.webgl2).toBe(false);
  });

  it('內顯（WebGL2 正常、探針中等）判 Tier B', async () => {
    let now = 0;
    const cap = await probeClientCapability(
      () => {
        now += 50; // 20 fps
      },
      {
        createCanvas: fakeCanvas({ webgl2: true, renderer: 'Intel(R) UHD Graphics 630' }),
        now: () => now,
      },
    );
    expect(cap.tier).toBe('B');
  });

  it('獨顯（探針 >= 30 fps）判 Tier A', async () => {
    let now = 0;
    const cap = await probeClientCapability(
      () => {
        now += 8; // 125 fps
      },
      {
        createCanvas: fakeCanvas({ webgl2: true, renderer: 'NVIDIA RTX A2000/PCIe/SSE2' }),
        now: () => now,
      },
    );
    expect(cap.tier).toBe('A');
    expect(cap.maxTexture3d).toBe(2048);
    expect(cap.hasNorm16).toBe(true);
  });
});

describe('探針是時間盒，不是幀數盒', () => {
  it('上限 250 ms', () => {
    expect(PROBE_BUDGET_MS).toBe(250);
  });

  it('軟體渲染在 250 ms 內完不成一幀 → fps < 10 → Tier C', async () => {
    let now = 0;
    const result = await timeboxedProbe(
      () => {
        now += 1000; // 一幀一秒
      },
      { now: () => now },
    );
    expect(result.frames).toBe(1);
    expect(tierFromFps(result.fps)).toBe('C');
  });

  it('不會因為裝置很快就跑上千幀', async () => {
    let now = 0;
    const result = await timeboxedProbe(
      () => {
        now += 0.01;
      },
      { now: () => now },
    );
    expect(result.frames).toBeLessThanOrEqual(240);
  });

  it('context 遺失時判 Tier C', async () => {
    let now = 0;
    const cap = await probeClientCapability(
      () => {
        now += 5;
        throw new Error('webglcontextlost');
      },
      {
        createCanvas: fakeCanvas({ webgl2: true, renderer: 'NVIDIA RTX A2000' }),
        now: () => now,
      },
    );
    expect(cap.tier).toBe('C');
  });
});

describe('合成 volume（雞蛋問題的解法）', () => {
  it('128³ 且不需要網路、不需要案例', () => {
    const volume = syntheticVolume(128);
    expect(volume.length).toBe(128 ** 3);
    // 漸層 ＋ 雜訊：值域要真的鋪開，否則 GPU 可能最佳化掉取樣
    const unique = new Set(volume.subarray(0, 4096));
    expect(unique.size).toBeGreaterThan(32);
  });

  it('確定性（同樣的 size 產生同樣的資料）', () => {
    expect(syntheticVolume(16)).toEqual(syntheticVolume(16));
  });
});

describe('裁決優先序：手動 > 後端 > 探針', () => {
  const base: ClientCapability = {
    webgl2: true,
    maxTexture3d: 2048,
    hasNorm16: true,
    rendererString: 'NVIDIA RTX A2000',
    looksSoftware: false,
    probeAllocMb: 2800,
    probeFps: 58,
    tier: 'A',
  };

  it('探針建議被採用（沒有其他來源時）', () => {
    expect(arbitrate({ capability: base }).assigned).toBe('A');
    expect(arbitrate({ capability: base }).source).toBe('probe');
  });

  it('🔴 後端只能下調，不能上調', () => {
    const downgraded = arbitrate({ capability: base, backendAssigned: 'B' });
    expect(downgraded.assigned).toBe('B');
    expect(downgraded.source).toBe('backend');

    const lowProbe: ClientCapability = { ...base, probeFps: 12, tier: 'B' };
    const attemptedUpgrade = arbitrate({ capability: lowProbe, backendAssigned: 'A' });
    expect(attemptedUpgrade.assigned).toBe('B');
  });

  it('手動覆寫最高，但不得超越硬性能力', () => {
    const manual = arbitrate({ capability: base, manualOverride: 'B' });
    expect(manual.assigned).toBe('B');
    expect(manual.source).toBe('manual');
    expect(manual.canRestore).toBe(true);

    const noWebgl: ClientCapability = { ...base, webgl2: false, tier: 'C' };
    expect(() => arbitrate({ capability: noWebgl, manualOverride: 'A' })).toThrowError(/TIER1/);
  });

  it('硬性能力上限的三個判定條件', () => {
    expect(hardCapabilityTier({ ...base, webgl2: false })).toBe('C');
    expect(hardCapabilityTier({ ...base, looksSoftware: true })).toBe('C');
    expect(hardCapabilityTier({ ...base, probeFps: 5 })).toBe('C');
    expect(hardCapabilityTier({ ...base, probeFps: 20 })).toBe('B');
    expect(hardCapabilityTier(base)).toBe('A');
  });

  it('診斷資訊完整（狀態列要能供院內 IT 排查）', () => {
    const state = arbitrate({ capability: base });
    expect(state.diagnostics).toMatchObject({
      webgl2: true,
      looksSoftware: false,
      rendererString: 'NVIDIA RTX A2000',
      hardCapabilityTier: 'A',
    });
    expect(state.reason).toContain('fps');
  });

  it('wire 形狀符合 client_capability 契約', () => {
    expect(capabilityToWire(base)).toEqual({
      webgl2: true,
      max_texture_3d: 2048,
      has_norm16: true,
      renderer_string: 'NVIDIA RTX A2000',
      looks_software: false,
      probe_alloc_mb: 2800,
      probe_fps: 58,
      tier: 'A',
    });
  });
});

describe('保守起點 ＋ 載入時退讓（不做「加大到失敗」）', () => {
  it('第一次失敗：配額對半、lod 降一級', () => {
    const next = yieldOnFailure(initialYieldState('A'));
    expect(next.quotaScale).toBe(0.5);
    expect(next.lodBias).toBe(1);
    expect(next.tier).toBe('A');
  });

  it('連續兩次失敗即降一個 Tier 並通知使用者', () => {
    const next = yieldOnFailure(yieldOnFailure(initialYieldState('A')));
    expect(next.tier).toBe('B');
    expect(next.downgraded).toBe(true);
    expect(next.quotaScale).toBe(1);
  });

  it('成功後清掉失敗計數（不會被歷史拖累）', () => {
    const afterOne = yieldOnFailure(initialYieldState('A'));
    const recovered = yieldOnSuccess(afterOne);
    expect(yieldOnFailure(recovered).tier).toBe('A');
  });
});

describe('記憶體配額（mask 改為 CPU 端解讀）', () => {
  it('三個 Tier 的總額符合預算表', () => {
    expect(budgetFor('A', 1).totalBytes).toBe(3_000_000_000);
    expect(budgetFor('B', 1).totalBytes).toBe(1_000_000_000);
    expect(budgetFor('C', 1).totalBytes).toBe(4_000_000_000);
  });

  it('雙影像時 image 配額提高、mask 配額降低', () => {
    expect(budgetFor('A', 2).imageBytes).toBeGreaterThan(budgetFor('A', 1).imageBytes);
    expect(budgetFor('A', 2).maskCpuBytes).toBeLessThan(budgetFor('A', 1).maskCpuBytes);
  });

  it('Tier C 的取捨方向與 A/B 相反：記憶體寬鬆', () => {
    expect(budgetFor('C', 1).maskCpuBytes).toBeGreaterThan(budgetFor('A', 1).maskCpuBytes);
    // 且 Tier C 沒有打包 texture（CPU 合成器不打包）
    expect(budgetFor('C', 1).maskFillVramBytes).toBe(0);
  });

  it('缺 EXT_texture_norm16 時 int16 以 float32 上傳（記憶體翻倍）', () => {
    expect(imageBytesPerVoxel({ tier: 'A', hasNorm16: true, dtype: 'int16' })).toBe(2);
    expect(imageBytesPerVoxel({ tier: 'A', hasNorm16: false, dtype: 'int16' })).toBe(4);
    // Tier C 沒有 texture，就是 int16 本身
    expect(imageBytesPerVoxel({ tier: 'C', hasNorm16: false, dtype: 'int16' })).toBe(2);
  });

  it('同時可見結構數上限：outline 50、fill 4', () => {
    expect(VISIBLE_STRUCTURE_LIMIT.outline).toBe(50);
    expect(VISIBLE_STRUCTURE_LIMIT.fill).toBe(4);
  });
});

describe('能力偵測不留下 context', () => {
  it('detectCapability 交還 destroy，且主渲染 context 不參與', () => {
    const detection = detectCapability({
      createCanvas: fakeCanvas({ webgl2: true, renderer: 'NVIDIA' }),
    });
    expect(detection.webgl2).toBe(true);
    expect(() => detection.destroy()).not.toThrow();
  });

  it('沒有 canvas（SSR／worker）時不會爆', () => {
    const detection = detectCapability({ createCanvas: () => null });
    expect(detection.webgl2).toBe(false);
    expect(detection.rendererString).toBe('no-canvas');
  });
});
