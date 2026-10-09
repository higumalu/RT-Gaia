/**
 * 2026-10-09：每個請求都帶 `X-RTGaia-Session`。結構、量測的 id 不是全域唯一，伺服器用 id 定位時只看這個 session ——
 * 同一個人在兩個分頁開兩個病例時，改名、刪除才不會打到另一個病例。
 */
import { describe, expect, it } from 'vitest';

import { TransportClient } from '../src/core/transport/client';

function recording(): { client: TransportClient; seen: Headers[] } {
  const seen: Headers[] = [];
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { client: new TransportClient({ fetchImpl }), seen };
}

describe('TransportClient session header', () => {
  it('沒有 session 不帶；useSession 之後每個請求都帶，原本的標頭保留；關閉病例後不再帶', async () => {
    const { client, seen } = recording();
    await client.getJson('/structures/a/versions');
    client.useSession('sess_1');
    await client.patchJson('/structures/a', { name: 'x' });
    await client.deleteJson('/measurements/m1');
    client.useSession(null);
    await client.getJson('/library');

    expect(seen.map((h) => h.get('X-RTGaia-Session'))).toEqual([null, 'sess_1', 'sess_1', null]);
    expect(seen[1]!.get('content-type')).toBe('application/json');
  });
});
