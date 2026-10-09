/**
 * 功能導覽：幾步 coach marks，以 `data-tour` 或 class 選取目標。
 * 純資料＋純函式；`TourOverlay` 只負責畫。完成狀態存 localStorage（不是病人資料）。
 */

import { msg } from '../../core/i18n';

export const TOUR_STORAGE_KEY = 'rtgaia.tour.v1';

export interface TourStep {
  readonly id: string;
  /** 依序嘗試的選取器；第一個找得到的就是目標。都找不到 → 這一步跳過。 */
  readonly targets: readonly string[];
  readonly title: string;
  readonly body: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  { id: 'case', targets: ['.bar-group-case'], title: msg('病例'), body: msg('這裡看目前載入的病例、切換病例、回資料庫重新勾選，或「關閉病例」釋放記憶體。') },
  { id: 'task', targets: ['.bar-group-task'], title: msg('任務'), body: msg('ROI 編輯、對位、量測、簽核、匯出 —— 同時只開一個任務，它的設定在右欄。') },
  { id: 'tool', targets: ['.bar-group-tool'], title: msg('工具'), body: msg('十字線、筆刷、橡皮擦、量測工具；每個工具有字母快捷鍵（滑鼠移到按鈕上會顯示）。Ctrl+Z 復原。') },
  { id: 'view', targets: ['.bar-group-view', '.bar-group-layout'], title: msg('檢視與版面'), body: msg('MPR／DVH／3D 開關與版面（1×1、2×2…）。每格右上角的選單可以換這一格顯示什麼。') },
  { id: 'left', targets: ['[data-tour="left-sidebar"]', '.sidebar-left'], title: msg('資料與結構'), body: msg('影像、劑量、結構依影像分組。勾選顯示、調透明度；結構集可以新增、改名、刪除；「全顯示」會分批載入。') },
  { id: 'viewports', targets: ['[data-tour="viewports"]', '.viewport-area', '.app-body'], title: msg('影像格'), body: msg('滾輪換切片、Ctrl+滾輪縮放、中鍵平移、右鍵拖曳調 WW/WL；左鍵是作用中的工具。左下角的讀數跟著游標。') },
  { id: 'plugins', targets: ['.plugins-menu'], title: 'Plugins', body: msg('外掛（例如 nnU-Net 自動圈選）與 DICOM 節點服務都從這裡開；結果先進「未儲存」的暫存集，保存後才進工作集。') },
  { id: 'right', targets: ['[data-tour="right-sidebar"]', '.sidebar-right'], title: msg('右欄'), body: msg('目前任務與 plugin 的設定面板。') },
  { id: 'help', targets: ['.bar-group-help'], title: msg('說明'), body: msg('快捷鍵與滑鼠操作表、這個導覽、使用手冊都在這裡；按 ? 也能開快捷鍵表。') },
];

/**
 * **任務引導** —— 不是介紹每一塊在哪，而是帶使用者完成一件事。
 * 每一步框出要按的地方、說要做什麼；使用者自己操作，按「下一步」往下。
 */
export const TASK_DRAW_STEPS: readonly TourStep[] = [
  {
    id: 'draw-pick',
    targets: ['.structure-list', '[data-tour="left-sidebar"]', '.sidebar-left'],
    title: msg('1. 選一個結構'),
    body: msg('在左欄「結構」點名稱，把它設成作用中。匯入的結構是唯讀的：在 ROI 編輯面板按「合併到我的結構集」做一份自己的，或按「新建」。'),
  },
  {
    id: 'draw-roi',
    targets: ['.bar-group-task'],
    title: msg('2. 開 ROI 編輯'),
    body: msg('按任務列的「ROI 編輯」，右欄會出現編輯面板（新建、筆刷、區域生長、後處理）。'),
  },
  {
    id: 'draw-brush',
    targets: ['.roi-panel .slab-presets', '.bar-group-tool', '.bar-group-task'],
    title: msg('3. 畫一筆'),
    body: msg('選「筆刷」，在影像上按住拖曳；一次拖曳是一筆，Ctrl+Z 復原。橡皮擦、閾值筆刷、圈選在同一列。'),
  },
  {
    id: 'draw-saved',
    targets: ['.save-status', '.header-status'],
    title: msg('4. 確認存好了'),
    body: msg('這裡顯示「已保存」才算存到後端。送不出去時，下方提示列會列出那一筆：可以再送一次、跳到那一塊，或放棄改回後端的版本。'),
  },
];

export const TASK_OPEN_STEPS: readonly TourStep[] = [
  {
    id: 'open-pick',
    targets: ['.catalog-tree'],
    title: msg('1. 找到病人、勾影像'),
    body: msg('點病人與 study 展開，勾要看的影像（4D 組勾一列就是整組）。RTSTRUCT、RTDOSE、REG 會跟著影像列出來，一起勾。'),
  },
  {
    id: 'open-check',
    targets: ['.selection-summary', '.cart'],
    title: msg('2. 確認主要影像與對位'),
    body: msg('這裡寫出主要影像、次要影像與套用的對位（REG）；有問題會列在下面，解決了才能開啟。'),
  },
  {
    id: 'open-go',
    targets: ['[data-tour="open-case"]'],
    title: msg('3. 開啟'),
    body: msg('按「開啟」進檢視器。同一組選取會回到同一個病例 —— 之前畫的結構、量測都還在。'),
  },
];

/** 目標找得到的那些步（`exists` 由 UI 提供，測試給假的）。 */
export function availableSteps(steps: readonly TourStep[], exists: (selector: string) => boolean): TourStep[] {
  return steps.filter((s) => s.targets.some(exists));
}

export function firstTarget(step: TourStep, exists: (selector: string) => boolean): string | null {
  return step.targets.find(exists) ?? null;
}

export function tourDone(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(TOUR_STORAGE_KEY) === 'done';
  } catch {
    return true; // 讀不到就當作看過（別在私密視窗每次都彈）
  }
}

export function markTourDone(storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(TOUR_STORAGE_KEY, 'done');
  } catch {
    /* 私密視窗等：不記就算了 */
  }
}
