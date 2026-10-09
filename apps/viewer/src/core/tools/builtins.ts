/**
 * 第一期工具集的註冊。
 *
 * ## 第一版的實作狀態（誠實記錄）
 *
 * 這裡註冊的是**工具的宣告**：id、標籤、游標、以及「這個工具在哪種 viewport
 * 可用」。這部分是真的在用：`Toolbar` 由 `listTools(vp)` 產生，`appliesTo`
 * 的過濾（僅 MPR／僅 3D）也真的在運作。
 *
 * ✅ **三個筆刷類工具（brush／eraser／threshold-brush）已經走這條接縫**：
 * `ViewerHost` 只做 `getTool(id).activate(ctx)` ＋ 轉發指標事件，它**不認識
 * 「筆刷」這兩個字**。
 *
 * 在此之前：九個 `activate()` 全都交還一個什麼都不做的 instance，**而且沒有人
 * 呼叫它** —— 能用的三個編輯工具寫死在 `ViewerHost.handleToolCommand()` 的一個
 * `switch` 裡。型別是最終形狀、註冊表存在，但**沒有承重**：加一個新工具要改
 * `ViewerHost`，不是註冊一個 plugin。
 *
 * ✅ 九個工具全部接上：量測四個（`measure.ts`）、圈選（`scissors.ts`）、導航（Shift＋左鍵）
 * —— 每一個都只是換掉 `activate`，`ViewerHost` 一行都沒動，接縫確實承重。
 *
 * 🔴 **`activate()` 一律先檢查 `ctx.isEditable()`**：替代表示為唯讀，
 * 工具啟動前必須拒絕，不得靜默寫進一個沒有在畫面上的 mask。這段檢查現在就
 * 是對的，不是等有了筆刷才補。
 */

import { DEFAULT_BRUSH, DEFAULT_THRESHOLD_HU, rasterizeBrush, type BrushSpec } from '../edit/brush';
import { ContractViolation } from '../geometry';
import { measureTool } from './measure';
import { scissorsTool } from './scissors';
import { hasTool, registerTool, type ToolContext, type ToolInstance, type ToolPlugin } from './registry';
import { msg, t } from '../i18n';

/** 需要一個可編輯的目標結構才能啟動的工具。 */
const EDITING_TOOL_IDS = new Set(['brush', 'eraser', 'threshold-brush', 'scissors']);

/** 這個工具會改結構（presence 的「正在編輯」看它）。 */
export function isEditingTool(toolId: string | null | undefined): boolean {
  return !!toolId && EDITING_TOOL_IDS.has(toolId);
}

export interface ToolActivation {
  toolId: string;
  structureId: string | null;
  viewportId: string;
}

/** 供測試與除錯：記錄每次啟動（筆刷類工具會推一筆）。 */
export const activationLog: ToolActivation[] = [];

/**
 * 三個筆刷類工具的實際行為。
 *
 * 🔴 **這段程式碼原本寫死在 `ViewerHost.handleToolCommand()` 的一個 switch 裡**，
 * 而註冊的九個工具 `activate()` 全都交還一個什麼都不做的 instance、**而且沒有
 * 人呼叫它**。也就是說外掛接縫存在、型別是最終形狀，但沒有承重：
 * 當時要加一個新工具，得改 `ViewerHost`，不是註冊一個 plugin。
 *
 * 現在筆刷走的是同一條 `activate() → onPointerDown/Move/Up` 的路，
 * 因此那條接縫是被自己的內建工具壓過的。
 */
/** 筆刷兩個指標事件之間最多補幾點。 */
export const BRUSH_MAX_STEPS = 64;

function brushTool(toolId: string, mode: 'paint' | 'erase' | 'threshold'): ToolPlugin['activate'] {
  return (ctx) => {
    requireEditableTarget(toolId, ctx);
    activationLog.push({
      toolId,
      structureId: ctx.activeStructureId(),
      viewportId: ctx.viewport.viewportId,
    });

    let drawing = false;
    let warned = false;

    const dab = (x: number, y: number): void => {
      const structureId = ctx.activeStructureId();
      if (structureId === null) return;
      const layer = ctx.layers().find((l) => l.kind === 'mask' && l.contentRef === structureId);
      if (layer === undefined) return;
      const frameIndex = ctx.frameOf?.(layer) ?? (layer.temporalGroupId ? 0 : null);
      // 這個結構只在某幾幀、這一格（鎖住的相位或游標）不是其中之一 → 畫不進去；以前什麼都不說
      if (frameIndex !== null && layer.frames !== undefined && !layer.frames.includes(frameIndex)) {
        if (!warned) ctx.notify?.(t('「{name}」不在這一幀（第 {n} 幀），筆刷沒有作用；換到它有的相位，或在 ROI 面板「複製這一幀到其他相位」', { name: layer.label, n: frameIndex + 1 }));
        warned = true;
        return;
      }

      const brush = readBrush(ctx.params);
      const patch = rasterizeBrush({
        // 結構所屬 FoR 的 MaskGrid，不是 primary 的
        maskGrid: ctx.maskGridFor(layer.frameOfReferenceUid),
        frameGroup: ctx.frameGroup(layer.frameOfReferenceUid),
        centerPrimaryWorld: ctx.canvasToWorld(x, y),
        // 🔴 `shape: 'disc'` 需要平面法線才知道「當前平面」是哪一個。少了它
        // disc 分支的 `selfNormal` 是 null，於是**靜默退化成 sphere** ——
        // 使用者選了「只作用當前平面」卻畫出跨切面的球，毫無錯誤。
        planeNormal: ctx.camera.viewPlaneNormal,
        brush: {
          ...brush,
          erase: mode === 'erase',
          huRange: mode === 'threshold' ? (brush.huRange ?? DEFAULT_THRESHOLD_HU) : null,
        },
        sampleHu: (ijk) => ctx.sampleImageHu(ijk),
      });
      if (patch === null) return;
      ctx.applyPatch({ structureId, frameIndex, patch });
    };

    /**
     * 上一點到這一點之間補點 —— 指標事件之間隔得遠（手指快速滑動、滑鼠甩快）時，
     * 以前只在事件那一點蓋章，一筆變成一串分開的圓點（手機實測 8 mm 筆刷畫出 5 個點）。
     * 間距取半徑的一半（相鄰兩個圓重疊一半，邊緣是平的）；一段最多 64 點（極小半徑 ＋ 極長一段時不卡住）。
     */
    let last: { x: number; y: number } | null = null;
    const dabTo = (x: number, y: number): void => {
      if (last === null) {
        dab(x, y);
        last = { x, y };
        return;
      }
      const from = last;
      const w0 = ctx.canvasToWorld(from.x, from.y);
      const w1 = ctx.canvasToWorld(x, y);
      const mm = Math.hypot(w1[0] - w0[0], w1[1] - w0[1], w1[2] - w0[2]);
      const spacing = Math.max(readBrush(ctx.params).radiusMm * 0.5, 0.25);
      const steps = Math.min(BRUSH_MAX_STEPS, Math.max(1, Math.ceil(mm / spacing)));
      for (let i = 1; i <= steps; i += 1) dab(from.x + ((x - from.x) * i) / steps, from.y + ((y - from.y) * i) / steps);
      last = { x, y };
    };

    return {
      onPointerDown(x, y) {
        drawing = true;
        warned = false;
        last = null;
        dabTo(x, y);
      },
      onPointerMove(x, y) {
        if (drawing) dabTo(x, y);
      },
      onPointerUp() {
        if (!drawing) return;
        drawing = false;
        // 一次拖曳 = 一筆 undo，也只送一次
        ctx.endStroke(toolId);
      },
      deactivate() {
        // 🔴 切換工具時**必須收筆**，否則那一筆永遠不會被推進 undo、
        // 也永遠不會送到後端 —— 而畫面上它已經在了。
        if (drawing) {
          drawing = false;
          ctx.endStroke(toolId);
        }
      },
    };
  };
}

/**
 * 十字線導航：**Shift＋左鍵**點下就讓其他兩格跳到穿過該點的切面，拖曳中跟著走。
 * 裸左鍵不動作 —— 直接左鍵容易不小心點到。本格的切面不變，十字線移到點下。
 */
function navigateTool(ctx: ToolContext): ToolInstance {
  let down = false;
  return {
    onPointerDown(x, y, modifiers) {
      if (modifiers?.shift !== true) return;
      down = true;
      ctx.setCrosshair(ctx.canvasToWorld(x, y));
    },
    onPointerMove(x, y) {
      if (down) ctx.setCrosshair(ctx.canvasToWorld(x, y));
    },
    onPointerUp() {
      down = false;
    },
    deactivate() {
      down = false;
    },
  };
}

/** `ToolContext.params` 裡的筆刷設定。缺欄位就用預設值。 */
function readBrush(params: Record<string, unknown>): BrushSpec {
  const raw = params['brush'];
  if (raw === null || typeof raw !== 'object') return { ...DEFAULT_BRUSH };
  return { ...DEFAULT_BRUSH, ...(raw as Partial<BrushSpec>) };
}

/** 🔴 替代表示為唯讀，工具啟動前必須拒絕。 */
function requireEditableTarget(toolId: string, ctx: ToolContext): void {
  if (!EDITING_TOOL_IDS.has(toolId)) return;
  const structureId = ctx.activeStructureId();
  if (structureId === null) {
    throw new ContractViolation('TL4', t('編輯工具需要先選一個結構'), { toolId });
  }
  if (!ctx.isEditable(structureId)) {
    throw new ContractViolation('TL5', t('這個結構目前顯示的是替代表示（唯讀），不得編輯'), {
      toolId,
      structureId,
    });
  }
}

const PLUGINS: ToolPlugin[] = [
  {
    id: 'navigate',
    hotkey: 'C',
    label: msg('十字線'),
    icon: '✛',
    cursor: 'crosshair',
    activate: navigateTool,
  },
  {
    id: 'brush',
    hotkey: 'B',
    requiresMode: 'roi',
    label: msg('筆刷'),
    icon: '●',
    cursor: 'none',
    // 筆刷支援在斜面上作用，但 3D viewport 沒有可下筆的平面
    appliesTo: (vp) => !vp.is3D,
    activate: brushTool('brush', 'paint'),
  },
  {
    id: 'eraser',
    hotkey: 'E',
    requiresMode: 'roi',
    label: msg('橡皮擦'),
    icon: '○',
    cursor: 'none',
    appliesTo: (vp) => !vp.is3D,
    activate: brushTool('eraser', 'erase'),
  },
  {
    id: 'threshold-brush',
    hotkey: 'T',
    requiresMode: 'roi',
    label: msg('閾值筆刷'),
    icon: '◐',
    cursor: 'none',
    appliesTo: (vp) => !vp.is3D,
    activate: brushTool('threshold-brush', 'threshold'),
  },
  {
    id: 'scissors',
    hotkey: 'S',
    requiresMode: 'roi',
    label: msg('圈選'),
    icon: '✂',
    cursor: 'crosshair',
    appliesTo: (vp) => !vp.is3D,
    activate: scissorsTool,
  },
  {
    id: 'measure-distance',
    hotkey: 'D',
    requiresMode: 'measure',
    label: msg('距離'),
    icon: '↔',
    cursor: 'crosshair',
    // 3D 歐氏距離與平面無關，因此 3D viewport 也可用
    activate: measureTool('measure-distance'),
  },
  {
    id: 'measure-area',
    hotkey: 'A',
    requiresMode: 'measure',
    label: msg('面積'),
    icon: '▱',
    cursor: 'crosshair',
    // 平面型量測必須綁 viewReference，3D 裡沒有「當前平面」
    appliesTo: (vp) => !vp.is3D,
    activate: measureTool('measure-area'),
  },
  {
    id: 'measure-roi3d',
    hotkey: 'R',
    requiresMode: 'measure',
    label: msg('體積 ROI'),
    icon: '▣',
    cursor: 'crosshair',
    activate: measureTool('measure-roi3d'),
  },
  {
    id: 'measure-point',
    hotkey: 'P',
    requiresMode: 'measure',
    label: msg('標記點'),
    icon: '✚',
    cursor: 'crosshair',
    activate: measureTool('measure-point'),
  },
  {
    id: 'measure-angle',
    hotkey: 'G',
    requiresMode: 'measure',
    label: msg('角度'),
    icon: '∠',
    cursor: 'crosshair',
    appliesTo: (vp) => !vp.is3D,
    activate: measureTool('measure-angle'),
  },
  {
    id: 'measure-cobb',
    hotkey: 'O',
    requiresMode: 'measure',
    label: msg('Cobb 角'),
    icon: '∡',
    cursor: 'crosshair',
    // 兩條線投到畫的平面上量（平面型）；3D 裡沒有「當前平面」
    appliesTo: (vp) => !vp.is3D,
    activate: measureTool('measure-cobb'),
  },
  {
    id: 'measure-curve',
    hotkey: 'L',
    requiresMode: 'measure',
    label: msg('曲線長度'),
    icon: '∿',
    cursor: 'crosshair',
    appliesTo: (vp) => !vp.is3D,
    activate: measureTool('measure-curve'),
  },
];

/**
 * 註冊第一期工具集。
 *
 * ⚠️ **多邊形輪廓工具（spline、livewire、sculptor）刻意不在這裡**——
 * 它們不屬於第一期；若臨床調查顯示是必要規格，需重新評估改用 `@cornerstonejs/tools`。
 */
/**
 * 逐 id 冪等。
 *
 * 🔴 先前 `bootstrap` 用「註冊表是空的才註冊」當條件，而模組（例如對位拖曳）在 `App` 載入時
 * 就先註冊了自己的工具 → 內建九個全部被跳過，**工具面板在瀏覽器裡是空的**，而測試（各自 clearTools）
 * 看不出來。改成看 id。
 */
export function registerBuiltinTools(): void {
  for (const plugin of PLUGINS) if (!hasTool(plugin.id)) registerTool(plugin);
}

export const BUILTIN_TOOL_COUNT = PLUGINS.length;
