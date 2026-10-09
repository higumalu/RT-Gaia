/**
 * payload 訊框解碼 —— **不變式被強制的地方**。
 *
 * 訊框格式（與 `rtgaia_geom.codec` 同一份定義）::
 *
 *     0  magic       "RTAP"        4 bytes
 *     4  version     uint16 LE     2 bytes
 *     6  reserved    uint16 LE     2 bytes
 *     8  header_len  uint32 LE     4 bytes
 *     12 header      UTF-8 JSON    header_len bytes
 *        body        raw / zstd    header.wire.body_bytes bytes
 *
 * ## zstd 解壓是可插拔的
 *
 * 瀏覽器沒有內建 zstd。相依清單列了一個 wasm 解壓套件，但**解壓器不該是
 * 這個模組的相依**——它在 Node（測試）與瀏覽器（產品）是兩個不同的東西。
 * 因此改成註冊制：`registerZstdDecoder()`。未註冊時遇到 zstd payload 會拋出
 * 明確的錯誤，而不是回傳壞資料。
 */

import { ContractViolation, require_ } from '../geometry';
import { t } from '../i18n';

const MAGIC = 0x50415452; // "RTAP" 以 LE uint32 讀出
export const WIRE_VERSION = 1;
export const CONTENT_TYPE = 'application/vnd.rtgaia.payload';

export interface WireSection {
  encoding: 'raw' | 'zstd';
  body_bytes: number;
  uncompressed_bytes: number;
}

export interface DecodedFrame {
  header: Record<string, unknown>;
  body: Uint8Array;
}

export type ZstdDecoder = (compressed: Uint8Array, uncompressedBytes: number) => Uint8Array;

let zstdDecoder: ZstdDecoder | null = null;

export function registerZstdDecoder(decoder: ZstdDecoder | null): void {
  zstdDecoder = decoder;
}

export function hasZstdDecoder(): boolean {
  return zstdDecoder !== null;
}

/**
 * 解析訊框。**任何一項不符即拒絕，不得回傳部分資料。**
 *
 * 對應的 chaos 模式：`truncate`（W6）、`missing_direction`（由 `fromWire` 抓）、
 * `wrong_size`（由 `assertPayloadLength` 抓）。
 */
export function decodeFrame(buffer: ArrayBuffer | Uint8Array): DecodedFrame {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  require_(bytes.byteLength >= 12, 'W1', t('訊框太短，連前導都不完整'), {
    length: bytes.byteLength,
  });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  require_(view.getUint32(0, true) === MAGIC, 'W2', t('magic 不符——這不是 RT-Gaia payload'));
  const version = view.getUint16(4, true);
  require_(version === WIRE_VERSION, 'W3', t('wire 版本不支援'), {
    version,
    expected: WIRE_VERSION,
  });
  const headerLen = view.getUint32(8, true);
  const headerEnd = 12 + headerLen;
  require_(bytes.byteLength >= headerEnd, 'W4', t('header 被截斷'), {
    headerLen,
    length: bytes.byteLength,
  });
  const header = JSON.parse(
    new TextDecoder('utf-8').decode(bytes.subarray(12, headerEnd)),
  ) as Record<string, unknown>;
  const wire = header.wire as WireSection | undefined;
  require_(wire !== undefined && typeof wire === 'object', 'W5', t('header 缺少 wire 區段'));

  const body = bytes.subarray(headerEnd);
  require_(
    body.byteLength === wire!.body_bytes,
    'W6',
    t('body 長度與 header 宣告不符（chaos: truncate）——不得渲染半張影像'),
    { declared: wire!.body_bytes, actual: body.byteLength },
  );

  let raw: Uint8Array;
  if (wire!.encoding === 'zstd') {
    if (zstdDecoder === null) {
      throw new ContractViolation(
        'W8',
        t('payload 是 zstd 壓縮的，但尚未註冊解壓器。呼叫 registerZstdDecoder()'),
        { uncompressedBytes: wire!.uncompressed_bytes },
      );
    }
    raw = zstdDecoder(body, wire!.uncompressed_bytes);
  } else {
    raw = body;
  }
  require_(
    raw.byteLength === wire!.uncompressed_bytes,
    'W7',
    t('解壓後長度與 header 宣告不符'),
    { declared: wire!.uncompressed_bytes, actual: raw.byteLength },
  );
  delete header.wire;
  return { header, body: raw };
}

/** `dtype` → 每個元素的位元組數。 */
export const DTYPE_BYTES: Record<string, number> = { uint8: 1, int16: 2, float32: 4, uint32: 4 };

export type TypedArray = Uint8Array | Int16Array | Float32Array | Uint32Array;

/** 依 `dtype` 把 body 包成對應的 TypedArray（**零複製**，共用同一段記憶體）。 */
export function viewAs(body: Uint8Array, dtype: string, offsetBytes = 0, count?: number): TypedArray {
  const bytes = DTYPE_BYTES[dtype];
  require_(bytes !== undefined, 'I6', t('未知的 dtype'), { dtype });
  const total = count ?? (body.byteLength - offsetBytes) / bytes!;
  require_(
    Number.isInteger(total) && total >= 0,
    'I9',
    t('body 長度不是元素大小的整數倍'),
    { dtype, byteLength: body.byteLength, offsetBytes },
  );
  const base = body.byteOffset + offsetBytes;
  switch (dtype) {
    case 'uint8':
      return new Uint8Array(body.buffer, base, total);
    case 'int16':
      return new Int16Array(body.buffer, base, total);
    case 'float32':
      return new Float32Array(body.buffer, base, total);
    case 'uint32':
      return new Uint32Array(body.buffer, base, total);
    default:
      throw new ContractViolation('I6', t('未知的 dtype'), { dtype });
  }
}
