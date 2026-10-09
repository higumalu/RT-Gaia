/** 訂閱目前語言；語言一換呼叫端重畫（App 最上層用它，整棵樹跟著重畫）。 */

import { useSyncExternalStore } from 'react';

import { getLang, onLangChange, type Lang } from '../../core/i18n';

export function useLang(): Lang {
  return useSyncExternalStore(onLangChange, getLang, getLang);
}
