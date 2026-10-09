/**
 * 用哪一種版面 —— 手機、平板、桌面。純函式；量測與監聽在 `react/device/useFormFactor.ts`。
 *
 * | 條件 | 版面 |
 * |---|---|
 * | 觸控裝置（`pointer: coarse`）：寬 < 768 或短邊 < 600 | 手機（橫拿的手機寬 844，只看寬會被當平板 —— 實測影像格剩 30 px 高） |
 * | 觸控裝置，其餘 | 平板（桌面版面、按鈕加大） |
 * | 滑鼠：寬 < 600 | 手機（桌面瀏覽器拉得很窄 —— 窄視窗資料頁） |
 * | 滑鼠，其餘 | 桌面 |
 *
 * 🔴 滑鼠的門檻是 600 不是 768：桌面瀏覽器放大到 200% 時 1440 寬只剩 720 CSS px，
 * 那是桌面使用者放大字，不該換成手機版、少掉量測／對位這些功能。
 *
 * 使用者選單可以切「使用桌面版」（記在這台瀏覽器，不跟帳號 —— 同一個帳號在電腦上不該變成手機版）。
 */

export type FormFactor = 'phone' | 'tablet' | 'desktop';

export const PHONE_MAX_WIDTH = 768;
export const PHONE_MAX_SHORT_SIDE = 600;
/** 滑鼠裝置：比這個窄才用手機版面。 */
export const PHONE_MAX_WIDTH_MOUSE = 600;
/** 記在這台瀏覽器（`localStorage`，不經 `savePref`）。 */
export const FORCE_DESKTOP_KEY = 'rtgaia.forceDesktop';

export function formFactorOf(args: { width: number; height: number; coarse: boolean; forceDesktop: boolean }): FormFactor {
  if (args.forceDesktop) return 'desktop';
  const short = Math.min(args.width, args.height);
  if (args.coarse) return args.width < PHONE_MAX_WIDTH || short < PHONE_MAX_SHORT_SIDE ? 'phone' : 'tablet';
  return args.width < PHONE_MAX_WIDTH_MOUSE ? 'phone' : 'desktop';
}

/** 這個裝置「本來」是什麼（不看強制桌面版）—— 使用者選單判斷要不要顯示切換用。 */
export function naturalFormFactor(args: { width: number; height: number; coarse: boolean }): FormFactor {
  return formFactorOf({ ...args, forceDesktop: false });
}
