/**
 * 所有頁面頂端的容量提醒（不自動刪除，但容量超過 90% 要提醒使用者）。
 * 每 5 分鐘問一次 `GET /storage/status`（後端也每 5 分鐘量一次）；沒超過就不佔位。
 */

import { useEffect, useState } from 'react';

import { bannerText } from './model';
import { storageApi, type StorageStatus } from './storageApi';

const POLL_MS = 5 * 60_000;

export function StorageBanner(): React.JSX.Element | null {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      storageApi.status().then(
        (s) => alive && setStatus(s),
        () => undefined, // 未登入、舊後端：不顯示
      );
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  const text = bannerText(status);
  if (text === null) return null;
  return (
    <div className="storage-banner" role="alert" data-storage-warn="true">
      ⚠ {text}
    </div>
  );
}
