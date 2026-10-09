/**
 * nnU-Net plugin 面板的純邏輯（examples/plugin-nnunet/ui/src/model.ts）。
 * 面板本身要等宿主的執行期載入才能在頁面上跑；邏輯先在這裡釘住。
 */
import { defaultImageSeries, filterLabels, imageChoices, jobLine, modeChangeAction, sortedLabels, structuresParam, toggle, validateRemote } from '../../../examples/plugin-nnunet/ui/src/model';

const labels = {
  '3': { name: 'spleen', color: [1, 2, 3] as const, tg263: 'Spleen' },
  '1': { name: 'liver', color: [4, 5, 6] as const, tg263: 'Liver' },
  '2': { name: 'aorta', color: [7, 8, 9] as const, tg263: 'A_Aorta' },
};

describe('nnunet ui model', () => {
  it('sorts by name and filters by name or TG-263', () => {
    const rows = sortedLabels(labels);
    expect(rows.map((r) => r.info.name)).toEqual(['aorta', 'liver', 'spleen']);
    expect(filterLabels(rows, 'SPL').map((r) => r.value)).toEqual(['3']);
    expect(filterLabels(rows, 'a_ao').map((r) => r.value)).toEqual(['2']);
    expect(filterLabels(rows, '  ')).toHaveLength(3);
  });

  it('empty or full selection means "all" (empty structures param)', () => {
    let sel = new Set<string>();
    expect(structuresParam(sel, 3)).toEqual([]);
    sel = toggle(sel, 'liver');
    expect(structuresParam(sel, 3)).toEqual(['liver']);
    sel = toggle(toggle(sel, 'aorta'), 'spleen');
    expect(structuresParam(sel, 3)).toEqual([]);
    expect(toggle(sel, 'liver').has('liver')).toBe(false);
  });

  it('validates remote url and port', () => {
    expect(validateRemote('http://gpu-box', '8710')).toBeNull();
    expect(validateRemote('gpu-box', '8710')).toMatch(/http/);
    expect(validateRemote('http://gpu-box', '70000')).toMatch(/port/);
    expect(validateRemote('http://gpu-box', '8710.5')).toMatch(/port/);
  });

  it('switching to remote shows the form first; local saves immediately', () => {
    expect(modeChangeAction('remote')).toBe('show-form');
    expect(modeChangeAction('local')).toBe('patch-now');
  });

  it('renders job lines', () => {
    expect(jobLine(null)).toBe('尚未執行');
    expect(jobLine({ status: 'running', percent: 42.4, phase: 'inference' })).toBe('執行中 42%（inference）');
    expect(jobLine({ status: 'failed', error: 'B3' })).toBe('失敗：B3');
  });
});

describe('選擇要推論的影像', () => {
  const img = (layerId: string, series: string, modality: string, date: string, desc: string, visible = true) => ({
    layerId,
    kind: 'image',
    contentRef: series,
    visible,
    label: layerId,
    modality,
    seriesMeta: { series_date: date, series_description: desc },
  });
  const layers = [
    img('ct', '1.2.ct', 'CT', '20260612', 'Pelvis 3.0'),
    img('cb1', '1.2.cb17', 'CBCT', '20260617', 'ART_Pelvic', false),
    img('cb2', '1.2.cb18', 'CBCT', '20260618', 'ART_Pelvic', false),
    { layerId: 'dose', kind: 'dose', contentRef: '1.2.dose', visible: true, label: 'dose' },
  ];

  it('每個影像 layer 一項（劑量不算），名稱＝模態 日期 描述、送的是序列 id', () => {
    expect(imageChoices(layers)).toEqual([
      { layerId: 'ct', seriesId: '1.2.ct', label: 'CT 2026-06-12 Pelvis 3.0' },
      { layerId: 'cb1', seriesId: '1.2.cb17', label: 'CBCT 2026-06-17 ART_Pelvic' },
      { layerId: 'cb2', seriesId: '1.2.cb18', label: 'CBCT 2026-06-18 ART_Pelvic' },
    ]);
  });

  it('同名才補序列 UID 尾碼', () => {
    const dup = [img('a', 'x.111111', 'CBCT', '20260617', 'ART'), img('b', 'x.222222', 'CBCT', '20260617', 'ART')];
    expect(imageChoices(dup).map((c) => c.label)).toEqual(['CBCT 2026-06-17 ART …111111', 'CBCT 2026-06-17 ART …222222']);
  });

  it('預設：作用中的影像 → 第一個顯示中的 → 第一個', () => {
    const choices = imageChoices(layers);
    expect(defaultImageSeries(choices, layers, 'cb2')).toBe('1.2.cb18');
    expect(defaultImageSeries(choices, layers, null)).toBe('1.2.ct');
    const allHidden = layers.map((l) => ({ ...l, visible: false }));
    expect(defaultImageSeries(imageChoices(allHidden), allHidden, 'dose')).toBe('1.2.ct');
    expect(defaultImageSeries([], [], null)).toBeNull();
  });
});

