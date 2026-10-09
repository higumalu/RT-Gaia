/** render3d 同時只飛一個、待送只留最新。 */
import { describe, expect, it } from 'vitest';

import { SingleFlight } from '../src/react/modules/render3d/singleFlight';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('SingleFlight', () => {
  it('在飛時新請求只覆寫待送槽；上一張回來才送最新；中間的從未送出', async () => {
    const sf = new SingleFlight<string>();
    const sent: string[] = [];
    const first = deferred<string>();
    const p1 = sf.run(() => {
      sent.push('cam1');
      return first.promise;
    });
    expect(sf.busy).toBe(true);
    const p2 = sf.run(() => {
      sent.push('cam2');
      return Promise.resolve('img2');
    });
    const p3 = sf.run(() => {
      sent.push('cam3');
      return Promise.resolve('img3');
    });
    expect(sent).toEqual(['cam1']);
    first.resolve('img1');
    expect(await p1).toBe('img1');
    // cam2 被 cam3 蓋掉、從未送出；等 cam2 的人拿到 cam3 的圖（更新的相機）
    expect(await p2).toBe('img3');
    expect(await p3).toBe('img3');
    expect(sent).toEqual(['cam1', 'cam3']);
    expect(sf.droppedCount).toBe(1);
    await Promise.resolve();
    expect(sf.busy).toBe(false);
  });

  it('在飛的失敗不影響待送的送出', async () => {
    const sf = new SingleFlight<number>();
    const p1 = sf.run(() => Promise.reject(new Error('x'))).catch(() => -1);
    const p2 = sf.run(() => Promise.resolve(2));
    expect(await p1).toBe(-1);
    expect(await p2).toBe(2);
  });
});
