"""契約違反的唯一錯誤型別。

`code` 是機器可讀的不變式代號（I1–I5，以及本檔擴充的 G*/P*/F*/V*）。
測試與 chaos 注入都以 code 斷言，不以訊息字串斷言。
"""

from __future__ import annotations


class ContractViolation(ValueError):
    """幾何契約違反。前端與後端共用同一組 code。"""

    def __init__(self, code: str, message: str, **context: object) -> None:
        self.code = code
        self.message = message
        """不含 code 與 context 的原文（給警告訊息用；`_temporal_bundle` 會讀它）。"""
        self.context = context
        detail = "".join(f"\n  {k} = {v!r}" for k, v in context.items())
        super().__init__(f"[{code}] {message}{detail}")


def require(condition: bool, code: str, message: str, **context: object) -> None:
    if not condition:
        raise ContractViolation(code, message, **context)
