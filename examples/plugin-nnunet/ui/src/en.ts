/**
 * 面板的英文（`@rtgaia/sdk` 0.1.1 的 `registerMessages`）：key 是原文（繁中），宿主依介面語言用 `t()` 取。
 * 繁中介面直接顯示原文，所以只需要英文這一份。manifest 的 `label`／`description` 也在這裡 —— 宿主的 Plugins 選單與管理頁經 `t()` 顯示。
 */
export const EN: Readonly<Record<string, string>> = {
  // manifest（plugin.py 的 MANIFEST）
  'AI 圈選（nnU-Net）': 'AI contouring (nnU-Net)',
  'nnU-Net 系器官自動圈選。local：引擎在本 plugin 內；remote：轉發到遠端推論服務。權重預設 TotalSegmentator（非商業授權）。':
    'Organ auto-contouring with nnU-Net-family models. local: the engine runs inside this plugin; remote: forwarded to a remote inference service. Default weights: TotalSegmentator (non-commercial license).',
  // 面板
  'AI 圈選': 'AI contouring',
  推論來源: 'Inference',
  '本機（與 RT-Gaia 一起部署；engine {engine}）': 'Local (deployed with RT-Gaia; engine {engine})',
  遠端推論服務: 'Remote inference service',
  儲存: 'Save',
  '填好 URL 與 port 後按「儲存」才會切到遠端': 'Fill in the URL and port, then click "Save" to switch to the remote service',
  測試連線: 'Test connection',
  '只有 admin 能改推論來源（目前身分：{role}）。': 'Only administrators can change the inference source (your role: {role}).',
  未知: 'unknown',
  要推論的影像: 'Image to segment',
  '（病例裡沒有影像）': '(no image in this case)',
  '結果會掛在這組影像的座標系（FoR）上。': "Results are placed in this image's frame of reference.",
  '要推論的 ROI（{n}）': 'Structures to compute ({n})',
  全部: 'All',
  '取不到 ROI 清單：{error}': 'Could not load the structure list: {error}',
  重試: 'Retry',
  '搜尋名稱或 TG-263': 'Search name or TG-263',
  選目前顯示的: 'Select shown',
  執行推論: 'Run',
  已儲存並切到遠端: 'Saved; using the remote service',
  已切回本機: 'Switched back to local',
  '測試中…': 'Testing…',
  '連線正常（engine {engine}）': 'Connected (engine {engine})',
  '連不上：{error}': 'Cannot connect: {error}',
  // model.ts
  'URL 要以 http:// 或 https:// 開頭，例如 http://gpu-box': 'The URL must start with http:// or https://, for example http://gpu-box',
  'port 要是 1–65535 的整數': 'The port must be an integer from 1 to 65535',
  尚未執行: 'Not run yet',
  排隊中: 'Queued',
  '執行中 {percent}%': 'Running {percent}%',
  '執行中 {percent}%（{phase}）': 'Running {percent}% ({phase})',
  '完成：結果已放入「plugin 結果（未儲存）」': 'Done: the results are in "Plugin results (unsaved)"',
  '失敗：{error}': 'Failed: {error}',
  未知原因: 'unknown reason',
};
