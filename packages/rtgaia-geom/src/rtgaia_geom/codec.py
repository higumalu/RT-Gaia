"""wire 格式 —— JSON header ＋ zstd 壓縮的 raw buffer。

**不在瀏覽器解 DICOM／NIfTI／NRRD。** 因此 wire 只需要一種框架，所有二進位
payload（影像、mask、mesh、未來的劑量與 DVF）共用它。

框架（單一回應體，不用 multipart —— 少一個瀏覽器端的解析器）::

    0  magic       b"RTAP"        4 bytes
    4  version     uint16 LE      2 bytes
    6  reserved    uint16 LE      2 bytes  (恆為 0)
    8  header_len  uint32 LE      4 bytes
    12 header      UTF-8 JSON     header_len bytes
       body        raw / zstd     header["wire"]["body_bytes"] bytes

`body_bytes` 與 `uncompressed_bytes` 都放進 header，因此
`truncate`（body 比宣告短）與 `wrong_size`（解壓後與 size_ijk 不符）
兩個 chaos 模式都能在解碼時抓到，**不會渲染半張影像**。
"""

from __future__ import annotations

import json
import struct
from typing import Any

import zstandard as zstd

from .errors import require

MAGIC = b"RTAP"
VERSION = 1
CONTENT_TYPE = "application/vnd.rtgaia.payload"
_PREAMBLE = struct.Struct("<4sHHI")

DEFAULT_ZSTD_LEVEL = 3
"""壓縮等級。

3 是 zstd 預設，對 CT int16 約 2–3× 且單執行緒吞吐 > 500 MB/s。再往上壓縮率
增益很小、CPU 成本明顯，而本架構的瓶頸從來不是頻寬（院內 LAN）。
"""


def encode(header: dict[str, Any], body: bytes, *, compress: bool = True, level: int = DEFAULT_ZSTD_LEVEL) -> bytes:
    """組出一個 payload 訊框。"""
    payload = zstd.ZstdCompressor(level=level).compress(body) if compress else body
    full_header = {
        **header,
        "wire": {
            "encoding": "zstd" if compress else "raw",
            "body_bytes": len(payload),
            "uncompressed_bytes": len(body),
        },
    }
    header_bytes = json.dumps(full_header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return _PREAMBLE.pack(MAGIC, VERSION, 0, len(header_bytes)) + header_bytes + payload


def decode(frame: bytes) -> tuple[dict[str, Any], bytes]:
    """解析訊框，回傳 `(header, 解壓後的 body)`。

    每一項檢查都對應一個 chaos 模式或一個真實的網路故障；**任何一項不符即拒絕，
    不得回傳部分資料**。
    """
    require(len(frame) >= _PREAMBLE.size, "W1", "訊框太短，連前導都不完整", length=len(frame))
    magic, version, _reserved, header_len = _PREAMBLE.unpack_from(frame, 0)
    require(magic == MAGIC, "W2", "magic 不符——這不是 RT-Gaia payload", magic=magic)
    require(version == VERSION, "W3", "wire 版本不支援", version=version, expected=VERSION)
    header_end = _PREAMBLE.size + header_len
    require(len(frame) >= header_end, "W4", "header 被截斷", header_len=header_len, length=len(frame))
    header = json.loads(frame[_PREAMBLE.size : header_end].decode("utf-8"))
    wire = header.get("wire")
    require(isinstance(wire, dict), "W5", "header 缺少 wire 區段")
    body = frame[header_end:]
    require(
        len(body) == int(wire["body_bytes"]),
        "W6",
        "body 長度與 header 宣告不符（chaos: truncate）——不得渲染半張影像",
        declared=int(wire["body_bytes"]),
        actual=len(body),
    )
    if wire["encoding"] == "zstd":
        raw = zstd.ZstdDecompressor().decompress(body, max_output_size=int(wire["uncompressed_bytes"]))
    else:
        raw = body
    require(
        len(raw) == int(wire["uncompressed_bytes"]),
        "W7",
        "解壓後長度與 header 宣告不符",
        declared=int(wire["uncompressed_bytes"]),
        actual=len(raw),
    )
    header.pop("wire", None)
    return header, raw
