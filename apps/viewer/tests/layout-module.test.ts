/**
 * 版面與並排比較：版面表、相機連動群、每格隱藏清單、模組面板可見性。
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  cameraLinkGroups,
  clearLayouts,
  clearModules,
  clearPanels,
  DEFAULT_LAYOUT_ID,
  getLayout,
  listLayouts,
  listPanels,
  registerBuiltinLayouts,
  registerLayout,
  type Layer,
  type PanelVisibilityState,
} from "../src/core";
import {
  COMPARE_LEFT,
  COMPARE_RIGHT,
  compareLayoutId,
  compareOrientationOf,
  defaultCompareSides,
  hiddenLayersForCell,
  isCompareLayout,
  registerLayoutModule,
  resetLayoutModuleRegistration,
} from "../src/react/modules/layout";
import {
  registerCoreUi,
  resetCoreUiRegistration,
} from "../src/react/panels/builtins";

const state = (layoutId: string): PanelVisibilityState => ({
  tier: "C",
  selectedLayerIds: [],
  hasTemporalLayer: false,
  hasSecondarySeries: true,
  hasDoseLayer: false,
  layoutId,
  modes: [],
});

beforeEach(() => {
  clearLayouts();
  clearPanels();
  clearModules();
  resetCoreUiRegistration();
  resetLayoutModuleRegistration();
  registerBuiltinLayouts();
  registerCoreUi();
  registerLayoutModule();
});

describe("版面表", () => {
  it("核心三個版面 ＋ 模組三個並排；找不到退回預設；1＋3 的大格佔三列", () => {
    expect(listLayouts().map((l) => l.id)).toEqual([
      "2x2",
      "1x1",
      "1+3",
      "compare-axial",
      "compare-coronal",
      "compare-sagittal",
    ]);
    expect(getLayout("nope").id).toBe(DEFAULT_LAYOUT_ID);
    const big = getLayout("1+3").cells[0]!;
    expect(big.cellId).toBe("axial");
    expect(big.gridArea).toBe("1 / 1 / 4 / 2");
    expect(getLayout("2x2").cells.map((c) => c.cellId)).toEqual([
      "axial",
      "coronal",
      "sagittal",
      "volume3d",
    ]);
  });

  it("同一版面內 viewportId 不得重複（LY3）", () => {
    expect(() =>
      registerLayout({
        id: "dup",
        label: "dup",
        gridTemplateColumns: "1fr",
        gridTemplateRows: "1fr",
        cells: [
          { cellId: "a", content: { kind: "viewport", orientation: "axial" } },
          { cellId: "a", content: { kind: "viewport", orientation: "axial" } },
        ],
      }),
    ).toThrow(/LY3/);
  });

  it("並排版面：兩格同方位、同一個相機連動群；2×2 沒有連動", () => {
    const c = getLayout(compareLayoutId("coronal"));
    expect(c.cells.map((x) => (x.content.kind === "viewport" ? x.content.orientation : null))).toEqual(["coronal", "coronal"]);
    expect(cameraLinkGroups(c)).toEqual({
      compare: [COMPARE_LEFT, COMPARE_RIGHT],
    });
    expect(cameraLinkGroups(getLayout("2x2"))).toEqual({});
    expect(isCompareLayout("compare-axial")).toBe(true);
    expect(isCompareLayout("2x2")).toBe(false);
    expect(compareOrientationOf("compare-sagittal")).toBe("sagittal");
    expect(compareOrientationOf("compare-weird")).toBe("axial");
  });

  it("重複註冊冪等", () => {
    const n = listLayouts().length;
    expect(() => registerLayoutModule()).not.toThrow();
    expect(listLayouts()).toHaveLength(n);
  });
});

describe("並排比較的純邏輯", () => {
  const layer = (layerId: string, kind: string, uid: string): Layer =>
    ({
      layerId,
      kind,
      frameOfReferenceUid: uid,
      contentRef: layerId,
      label: layerId,
      groupId: null,
      visible: true,
      opacity: 1,
      order: 0,
    });
  const layers = [
    layer("ct", "image", "A"),
    layer("cbct", "image", "B"),
    layer("dose-b", "dose", "B"),
    layer("ptv-a", "mask", "A"),
    layer("m", "measurement", "A"),
  ];

  it("這格只看一組：其餘 FoR 的影像／劑量／結構藏起來，量測不動", () => {
    expect(hiddenLayersForCell(layers, "A")).toEqual(["cbct", "dose-b"]);
    expect(hiddenLayersForCell(layers, "B")).toEqual(["ct", "ptv-a"]);
  });

  it("預設左 primary、右第一個次要；沒有次要就兩邊都是 primary", () => {
    expect(
      defaultCompareSides([
        { frameOfReferenceUid: "A", role: "primary" },
        { frameOfReferenceUid: "B", role: "secondary" },
      ]),
    ).toEqual(["A", "B"]);
    expect(
      defaultCompareSides([{ frameOfReferenceUid: "A", role: "primary" }]),
    ).toEqual(["A", "A"]);
    expect(defaultCompareSides([])).toEqual([null, null]);
  });
});

describe("版面模組的面板", () => {
  it("工具列選單永遠在（案例與工具之間）；比較面板只在 compare-* 版面下", () => {
    const toolbar = listPanels("toolbar", state("2x2")).map((p) => p.id);
    expect(toolbar.indexOf("layout.picker")).toBeGreaterThan(
      toolbar.indexOf("core.case-picker"),
    );
    expect(toolbar.indexOf("layout.picker")).toBeLessThan(
      toolbar.indexOf("core.tools"),
    );
    expect(listPanels("right-sidebar", state("2x2")).map((p) => p.id)).toEqual(
      [],
    );
    expect(
      listPanels("right-sidebar", state("compare-axial")).map((p) => p.id),
    ).toEqual(["layout.compare"]);
  });
});
