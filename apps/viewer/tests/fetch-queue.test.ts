/** 有上限的抓取佇列與進度。 */
import { describe, expect, it } from 'vitest';

import { FetchQueue } from '../src/react/hooks/fetchQueue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('FetchQueue', () => {
  it('同時在飛不超過上限；進度從 0／N 數到 N／N 然後歸零', async () => {
    const progress: (string | null)[] = [];
    const q = new FetchQueue(2, (p) => progress.push(p === null ? null : `${p.done}/${p.total}`));
    const gates = [deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;
    const all = gates.map((g) =>
      q.enqueue(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await g.promise;
        running -= 1;
      }),
    );
    await Promise.resolve();
    expect(running).toBe(2);
    expect(q.pending).toBe(3);
    gates[0]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(2);
    gates[1]!.resolve();
    gates[2]!.resolve();
    await Promise.all(all);
    expect(peak).toBe(2);
    expect(progress.at(-1)).toBeNull();
    expect(progress).toContain('0/3');
    expect(progress).toContain('2/3');
    expect(q.pending).toBe(0);
  });

  it('task 拋錯不會卡住佇列（呼叫端負責吞錯，這裡只保證往前走）', async () => {
    const q = new FetchQueue(1, () => {});
    let second = false;
    const first = q.enqueue(() => Promise.reject(new Error('boom'))).catch(() => {});
    await q.enqueue(async () => {
      second = true;
    });
    await first;
    expect(second).toBe(true);
    expect(q.pending).toBe(0);
  });
});
