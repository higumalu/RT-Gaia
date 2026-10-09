/**
 * 契約違反的唯一錯誤型別 —— **與 `rtgaia_geom.errors` 逐一對應**。
 *
 * `code` 是機器可讀的不變式代號（I1–I5，以及後端擴充的
 * `G` / `P` / `F` / `V` / `W` 系列）。前後端共用同一組 code，因此測試後端的 chaos 模式與前端的
 * 拒絕邏輯可以**一對一對照**。
 */
export class ContractViolation extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;

  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    const detail = Object.entries(context)
      .map(([k, v]) => `\n  ${k} = ${JSON.stringify(v)}`)
      .join('');
    super(`[${code}] ${message}${detail}`);
    this.name = 'ContractViolation';
    this.code = code;
    this.context = context;
  }
}

/** 與 Python 的 `require()` 同義。條件不成立就拋出，不回傳布林。 */
export function require_(
  condition: boolean,
  code: string,
  message: string,
  context: Record<string, unknown> = {},
): void {
  if (!condition) throw new ContractViolation(code, message, context);
}
