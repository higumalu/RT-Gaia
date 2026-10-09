"""wire 框架：JSON header ＋ zstd raw buffer。"""

from __future__ import annotations

import json
import struct

import numpy as np
import pytest
from rtgaia_geom import ContractViolation, decode, encode
from rtgaia_geom.codec import _PREAMBLE, MAGIC


def test_roundtrip() -> None:
    body = np.arange(1000, dtype=np.int16).tobytes()
    frame = encode({"dtype": "int16"}, body)
    header, raw = decode(frame)
    assert raw == body
    assert header["dtype"] == "int16"
    assert "wire" not in header


def test_roundtrip_uncompressed() -> None:
    body = b"\x01\x02\x03"
    header, raw = decode(encode({"x": 1}, body, compress=False))
    assert raw == body


def test_compression_actually_helps() -> None:
    body = np.zeros(1_000_000, dtype=np.int16).tobytes()
    assert len(encode({}, body)) < len(body) // 100


def test_detects_truncated_body() -> None:
    """chaos: `truncate` —— body 比 header 宣告的短。"""
    frame = encode({}, np.arange(500, dtype=np.int16).tobytes())
    with pytest.raises(ContractViolation) as e:
        decode(frame[:-16])
    assert e.value.code == "W6"


def test_detects_bad_magic() -> None:
    frame = encode({}, b"abc")
    with pytest.raises(ContractViolation) as e:
        decode(b"XXXX" + frame[4:])
    assert e.value.code == "W2"


def test_detects_version_mismatch() -> None:
    frame = bytearray(encode({}, b"abc"))
    struct.pack_into("<H", frame, 4, 99)
    with pytest.raises(ContractViolation) as e:
        decode(bytes(frame))
    assert e.value.code == "W3"


def test_detects_lying_uncompressed_size() -> None:
    """header 宣告的解壓長度與實際不符時必須拒絕，不得回傳部分資料。"""
    body = b"\x00" * 100
    frame = encode({}, body)
    _magic, _v, _r, hlen = _PREAMBLE.unpack_from(frame, 0)
    start = _PREAMBLE.size
    header = json.loads(frame[start : start + hlen])
    header["wire"]["uncompressed_bytes"] = 50
    new_header = json.dumps(header, separators=(",", ":")).encode()
    rebuilt = _PREAMBLE.pack(MAGIC, 1, 0, len(new_header)) + new_header + frame[start + hlen :]
    with pytest.raises(ContractViolation) as e:
        decode(rebuilt)
    assert e.value.code in ("W7", "W6")


def test_detects_short_frame() -> None:
    with pytest.raises(ContractViolation) as e:
        decode(b"RT")
    assert e.value.code == "W1"
