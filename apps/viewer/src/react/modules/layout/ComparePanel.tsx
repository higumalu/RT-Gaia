/**
 * 並排比較面板 —— 只在 `compare-*` 版面下出現。左格看哪組、右格看哪組、方位。
 *
 * 做法：把「這格不看的那幾組」的 layer 設成該格額外隱藏（`setViewportHiddenLayers`）；
 * 被選的那組影像若全域隱藏就先打開（全域隱藏的 layer 沒有常駐資料）。
 * 離開版面時把兩格的隱藏清單清掉。
 */

import { useEffect, useMemo, useState } from "react";

import type { FrameGroup, OrthoOrientation } from "../../../core";
import type { ViewerPanelProps } from "../../panels/types";
import {
  COMPARE_LEFT,
  COMPARE_RIGHT,
  compareLayoutId,
  compareOrientationOf,
  defaultCompareSides,
  hiddenLayersForCell,
} from "./model";
import { t } from '../../../core/i18n';

function groupTitle(fg: FrameGroup, api: ViewerPanelProps["api"]): string {
  const image = api.state.layers.find(
    (l) =>
      l.kind === "image" && l.frameOfReferenceUid === fg.frameOfReferenceUid,
  );
  const date = image?.seriesMeta?.["series_date"];
  const d =
    typeof date === "string" && date.length >= 8
      ? ` ${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
      : "";
  return t('{p0}{d}{p2}', { p0: image?.modality ?? fg.seriesId, d, p2: fg.role === "primary" ? t('（primary）') : "" });
}

export function ComparePanel({ api }: ViewerPanelProps): React.JSX.Element {
  const { frameGroups, layers, layoutId } = api.state;
  const [defaultLeft, defaultRight] = useMemo(
    () => defaultCompareSides(frameGroups),
    [frameGroups],
  );
  const [left, setLeft] = useState<string | null>(null);
  const [right, setRight] = useState<string | null>(null);
  const leftFor = left ?? defaultLeft;
  const rightFor = right ?? defaultRight;
  const { setViewportHiddenLayers, setVisible } = api.commands;
  const orientation = compareOrientationOf(layoutId);

  // 每格隱藏清單跟著選擇走；被選的那組至少要有一張影像可見
  const leftHidden = useMemo(
    () => (leftFor ? hiddenLayersForCell(layers, leftFor) : []),
    [layers, leftFor],
  );
  const rightHidden = useMemo(
    () => (rightFor ? hiddenLayersForCell(layers, rightFor) : []),
    [layers, rightFor],
  );
  const leftKey = leftHidden.join("|");
  const rightKey = rightHidden.join("|");
  useEffect(() => {
    setViewportHiddenLayers(COMPARE_LEFT, leftHidden);
    setViewportHiddenLayers(COMPARE_RIGHT, rightHidden);
    for (const uid of [leftFor, rightFor]) {
      if (uid === null) continue;
      const images = layers.filter(
        (l) => l.kind === "image" && l.frameOfReferenceUid === uid,
      );
      if (images.length > 0 && !images.some((l) => l.visible))
        setVisible(images[0]!.layerId, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    leftKey,
    rightKey,
    leftFor,
    rightFor,
    setViewportHiddenLayers,
    setVisible,
  ]);

  // 離開並排版面：清掉兩格的覆寫
  useEffect(
    () => () => {
      setViewportHiddenLayers(COMPARE_LEFT, []);
      setViewportHiddenLayers(COMPARE_RIGHT, []);
    },
    [setViewportHiddenLayers],
  );

  const sideSelect = (value: string | null, onChange: (v: string) => void) => (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      {frameGroups.map((fg) => (
        <option key={fg.frameOfReferenceUid} value={fg.frameOfReferenceUid}>
          {groupTitle(fg, api)}
        </option>
      ))}
    </select>
  );

  return (
    <div className="slab-panel compare-panel">
      <header className="slab-header">{t('並排比較')}</header>
      <p className="muted hint" style={{ padding: "4px 10px", margin: 0 }}>
        {t('兩格相機連動（捲動、pan、zoom、旋轉任一格另一格跟著）；每格只看一組座標系的影像、劑量、結構。')}
      </p>
      <div className="slab-row">
        <label>
          {t('左格')} {sideSelect(leftFor, setLeft)}
        </label>
      </div>
      <div className="slab-row">
        <label>
          {t('右格')} {sideSelect(rightFor, setRight)}
        </label>
      </div>
      <div className="slab-row">
        <span className="muted">{t('方位')}</span>
        <span className="slab-presets">
          {(["axial", "coronal", "sagittal"] as const).map(
            (o: OrthoOrientation) => (
              <button
                key={o}
                type="button"
                aria-pressed={orientation === o}
                onClick={() => api.commands.setLayout(compareLayoutId(o))}
              >
                {o === "axial" ? t('軸向') : o === "coronal" ? t('冠狀') : t('矢狀')}
              </button>
            ),
          )}
        </span>
        <button
          type="button"
          className="reset"
          title={t('左右互換')}
          onClick={() => {
            setLeft(rightFor);
            setRight(leftFor);
          }}
        >
          {t('⇄ 互換')}
        </button>
      </div>
    </div>
  );
}
