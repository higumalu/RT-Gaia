/** 2026-09-24：`deleteJson` 對 204／空 body 不硬解 JSON（DELETE /structures/{id} 回 204）。 */
import { describe, expect, it } from 'vitest';

import { TransportClient } from '../src/core/transport/client';

function clientWith(status: number, body: string): TransportClient {
  const fetchImpl = (async () =>
    new Response(status === 204 ? null : body, { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  return new TransportClient({ fetchImpl });
}

describe('TransportClient.deleteJson', () => {
  it('204 → undefined；空 200 → undefined；有 body 就解 JSON；非 2xx 拋 Error 帶狀態', async () => {
    expect(await clientWith(204, '').deleteJson('/structures/x')).toBeUndefined();
    expect(await clientWith(200, '').deleteJson('/structures/x')).toBeUndefined();
    expect(await clientWith(200, '{"removed_structure_ids":["a"]}').deleteJson<{ removed_structure_ids: string[] }>('/x')).toEqual({ removed_structure_ids: ['a'] });
    await expect(clientWith(403, '{"detail":{"code":"NOT_OWNER"}}').deleteJson('/x')).rejects.toThrow(/HTTP 403 .*NOT_OWNER/);
  });
});
