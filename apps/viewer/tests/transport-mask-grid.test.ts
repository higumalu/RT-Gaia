/**
 * 2026-10-09：編輯與後處理要帶**結構所屬 FoR** 的 MaskGrid。以前一律帶 primary 的 —— 次要影像（例：CBCT）上的結構，
 * 每一筆編輯、每一次後處理都被伺服器以 400 I3 拒絕，改的東西存不進去。
 */
import { describe, expect, it } from 'vitest';

import type { ViewReference } from '../src/core';
import { TransportClient } from '../src/core/transport/client';

const view: ViewReference = {
  frameOfReferenceUid: 'for.cbct',
  displayGridId: 'dg',
  planeOrigin: [0, 0, 0],
  viewPlaneNormal: [0, 0, -1],
  viewUp: [0, -1, 0],
  slabThicknessMm: 0,
  temporalGroupId: null,
  frameIndex: null,
};

function recording(): { client: TransportClient; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>);
    return new Response('{"content_hash":"mh_new"}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new TransportClient({ fetchImpl });
  client.bindSession({ studyId: 'st', displayGridId: 'dg', maskGridId: 'mg_primary' });
  return { client, bodies };
}

describe('TransportClient mask grid per structure', () => {
  it('submitEdit 帶指定的 MaskGrid；沒指定才用 primary 的', async () => {
    const { client, bodies } = recording();
    const edit = { structureId: 's', frameIndex: null, baseContentHash: 'mh_old', clientSeq: 1, offsetIjk: [0, 0, 0] as const, sizeIjk: [1, 1, 1] as const, data: new Uint8Array([1]), viewReference: view };
    await client.submitEdit({ ...edit, maskGridId: 'mg_cbct' });
    await client.submitEdit(edit);
    expect(bodies.map((b) => b.mask_grid_id)).toEqual(['mg_cbct', 'mg_primary']);
  });

  it('postprocess 帶指定的 MaskGrid', async () => {
    const { client, bodies } = recording();
    // 回應不是二進位訊框 → 解碼會失敗；這裡只看送出去的 body
    await client.postprocess({ structureId: 's', op: 'fill_holes', params: {}, baseContentHash: 'mh_old', maskGridId: 'mg_cbct' }).catch(() => undefined);
    expect(bodies[0]?.mask_grid_id).toBe('mg_cbct');
  });
});
