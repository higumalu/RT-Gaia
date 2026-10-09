/**
 * 複製文字到剪貼簿（2026-09-30：以區網 IP 走 http 開檢視器時，`navigator.clipboard` 不存在 —— 非安全環境不給；
 * 以前寫 `navigator.clipboard?.writeText(...)`，按「複製 CSV」安靜地什麼都沒發生）。
 * 有 Clipboard API 就用；沒有或被拒 → 退回隱藏 textarea ＋ `execCommand('copy')`（非安全環境也能用）。回傳是否成功。
 */
export async function copyText(text: string): Promise<boolean> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clip?.writeText) {
    try {
      await clip.writeText(text);
      return true;
    } catch {
      /* 權限被拒 → 退回舊法 */
    }
  }
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    // 已棄用但仍是非安全環境唯一的同步複製方式
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
