/**
 * Push 通道客戶端。
 *
 * chaos 模式 `disconnect` 的一對一對應行為在這裡：**重連並重新同步**。
 */

import { describe, expect, it, vi } from 'vitest';

import { PushChannel, type PushHandlers } from '../src/core';
import { isSceneRefetch, reconnectDelayMs } from '../src/core/transport/client';

/** 最小的假 WebSocket —— 讓重連邏輯可在 Node 下測。 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event?: { code: number }) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type, payload }) });
  }
}

function connect(handlers: PushHandlers = {}, delay = 0): { channel: PushChannel; socket: () => FakeSocket } {
  FakeSocket.instances = [];
  const channel = new PushChannel(
    'ws://test/api/v1/session/current/events',
    handlers,
    (url) => new FakeSocket(url) as unknown as WebSocket,
    delay,
  );
  channel.connect();
  return { channel, socket: () => FakeSocket.instances.at(-1)! };
}

describe('連線與 hello', () => {
  it('連上就送 session.hello（帶能力回報）', () => {
    const { channel, socket } = connect();
    socket().onopen?.();
    expect(JSON.parse(socket().sent[0]!)).toMatchObject({ type: 'session.hello' });
    channel.close();
  });
});

describe('Server → Client 訊息分派', () => {
  it('scene.replace', () => {
    const onScene = vi.fn();
    const { channel, socket } = connect({ onScene });
    socket().emit('scene.replace', { layers: [] });
    expect(onScene).toHaveBeenCalledWith({ layers: [] });
    channel.close();
  });

  it('scene.replace 太大（chaos push_limit）→ 只帶 refetch 的小訊息原樣交給 onScene，由 App 走 HTTP 拿', () => {
    const onScene = vi.fn();
    const { channel, socket } = connect({ onScene });
    const stub = { sessionId: 's1', caseId: 'c1', refetch: true, bytes: 385193, limit: 262144 };
    socket().emit('scene.replace', stub);
    expect(onScene).toHaveBeenCalledWith(stub);
    expect(isSceneRefetch(stub)).toBe(true);
    expect(isSceneRefetch({ layers: [] })).toBe(false);
    expect(isSceneRefetch({ refetch: 'true' })).toBe(false);
    channel.close();
  });

  it('layer.add / update / remove 都經 fromWire.layer 驗證', () => {
    const onLayer = vi.fn();
    const { channel, socket } = connect({ onLayer });
    const layer = {
      layerId: 'mask:gtv',
      kind: 'mask',
      label: 'GTV',
      groupId: 'structures',
      frameOfReferenceUid: 'for.1',
      contentRef: 'gtv',
      visible: true,
      opacity: 1,
      order: 100,
      renderStyle: 'outline',
    };
    socket().emit('layer.add', layer);
    socket().emit('layer.update', { ...layer, visible: false });
    socket().emit('layer.remove', layer);
    expect(onLayer).toHaveBeenCalledTimes(3);
    expect(onLayer.mock.calls[0]![0]).toBe('add');
    expect(onLayer.mock.calls[1]![1]).toMatchObject({ visible: false });
    channel.close();
  });

  it('🔴 mask.updated 只帶 metadata —— 體素一律走 HTTP GET', () => {
    const onMaskUpdated = vi.fn();
    const { channel, socket } = connect({ onMaskUpdated });
    socket().emit('mask.updated', { structureId: 'gtv', frameIndex: null, contentHash: 'mh_x' });
    expect(onMaskUpdated).toHaveBeenCalledWith({
      structureId: 'gtv',
      frameIndex: null,
      contentHash: 'mh_x',
    });
    channel.close();
  });

  it('camera.set 帶完整 ViewReference（斜面沒有 slice index）', () => {
    const onCamera = vi.fn();
    const { channel, socket } = connect({ onCamera });
    socket().emit('camera.set', {
      viewportId: 'axial',
      viewReference: {
        frame_of_reference_uid: 'for.1',
        display_grid_id: 'dg',
        plane_origin: [0, 0, 0],
        view_plane_normal: [0, 0.5, 0.8660254037844386],
        view_up: [0, 0.8660254037844386, -0.5],
        slab_thickness_mm: 3,
        temporal_group_id: null,
        frame_index: null,
      },
    });
    expect(onCamera).toHaveBeenCalledOnce();
    expect(onCamera.mock.calls[0]![1].slabThicknessMm).toBe(3);
    channel.close();
  });

  it('不合法的 ViewReference 在分派時就被拒絕（非單位法線）', () => {
    const { channel, socket } = connect({ onCamera: vi.fn() });
    expect(() =>
      socket().emit('camera.set', {
        viewportId: 'axial',
        viewReference: {
          frame_of_reference_uid: 'for.1',
          display_grid_id: 'dg',
          plane_origin: [0, 0, 0],
          view_plane_normal: [0, 0, 2],
          view_up: [0, -1, 0],
          slab_thickness_mm: 0,
          temporal_group_id: null,
          frame_index: null,
        },
      }),
    ).toThrowError(/V2/);
    channel.close();
  });

  it('job.progress 與 error', () => {
    const onJobProgress = vi.fn();
    const onError = vi.fn();
    const { channel, socket } = connect({ onJobProgress, onError });
    socket().emit('job.progress', { jobId: 'job_1', phase: 'extract_contours', percent: 40 });
    socket().emit('error', { code: 'EXPORT_FAILED', message: 'boom' });
    expect(onJobProgress).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith({ code: 'EXPORT_FAILED', message: 'boom' });
    channel.close();
  });
});

describe('chaos: disconnect → 重連並重新同步', () => {
  it('斷線後自動重連，並回報第幾次嘗試', async () => {
    vi.useFakeTimers();
    const onReconnect = vi.fn();
    const { channel, socket } = connect({ onReconnect }, 500);
    const first = socket();
    first.onclose?.();
    expect(onReconnect).toHaveBeenCalledWith(1);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(2);
    // 重新同步不需前端額外做事：伺服器在 connect 時就推一次 scene.replace
    channel.close();
    vi.useRealTimers();
  });

  it('close() 之後不再重連', () => {
    vi.useFakeTimers();
    const onReconnect = vi.fn();
    const { channel, socket } = connect({ onReconnect }, 100);
    channel.close();
    socket().onclose?.();
    vi.advanceTimersByTime(1000);
    expect(onReconnect).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe('帳號失效的關閉碼與退避', () => {
  it('4401／4403 通知 onAuthLost（App 重新確認登入），一般斷線不通知；兩種都照樣重連', () => {
    vi.useFakeTimers();
    try {
      const onAuthLost = vi.fn();
      const { channel, socket } = connect({ onAuthLost }, 10);
      socket().onopen?.();
      socket().onclose?.({ code: 4401 });
      expect(onAuthLost).toHaveBeenCalledWith(4401);
      vi.advanceTimersByTime(10);
      expect(FakeSocket.instances).toHaveLength(2);
      socket().onopen?.();
      socket().onclose?.({ code: 1006 });
      expect(onAuthLost).toHaveBeenCalledTimes(1);
      socket().onclose?.({ code: 4403 });
      expect(onAuthLost).toHaveBeenLastCalledWith(4403);
      channel.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('連續失敗指數退避、上限 10 秒；連上一次就歸零', () => {
    expect([1, 2, 3, 4].map((n) => reconnectDelayMs(500, n))).toEqual([500, 1000, 2000, 4000]);
    expect(reconnectDelayMs(500, 20)).toBe(10_000);
    vi.useFakeTimers();
    try {
      const { channel, socket } = connect({}, 100);
      socket().onclose?.({ code: 1006 }); // 第 1 次失敗 → 100 ms
      vi.advanceTimersByTime(99);
      expect(FakeSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(2);
      socket().onclose?.({ code: 1006 }); // 第 2 次（沒連上過）→ 200 ms
      vi.advanceTimersByTime(199);
      expect(FakeSocket.instances).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(3);
      socket().onopen?.(); // 連上 → 歸零
      socket().onclose?.({ code: 1006 });
      vi.advanceTimersByTime(100);
      expect(FakeSocket.instances).toHaveLength(4);
      channel.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

