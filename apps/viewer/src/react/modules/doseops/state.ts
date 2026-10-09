/** 劑量運算模組的狀態袋（`api.state.modules['dose-ops']`）。 */
export const DOSE_OPS_MODULE_ID = 'dose-ops';

export interface DoseOpsModuleState {
  /** 從左側「劑量」面板按「存檔…」→ 右側面板打開這個結果的存檔表單。 */
  readonly focus?: string;
}
