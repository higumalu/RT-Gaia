/**
 * 哪些請求會改病例、後端會推 layer／scene／結構集（`withPush`：推送 1.5 秒內沒到就自己走 HTTP 拿）。
 *
 * 只看 POST／PATCH／DELETE 的路徑。DVH 匯出、3D 出圖、量測、偏好這類不會推的不算 —— 算進來只是多打一次 HTTP，
 * 但會讓「推送有沒有到」的判斷失去意義。
 */
const CASE_MUTATION = /\/(structures|structure-sets|dose-ops|transforms|merge|review)(\/|\?|$)|\/dose\/[^/]+\/save(\?|$)/;

export function isCaseMutation(path: string): boolean {
  return CASE_MUTATION.test(path);
}
