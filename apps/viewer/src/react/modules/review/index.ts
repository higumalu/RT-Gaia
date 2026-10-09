/** 簽核模組：工具列「簽核」開關 ＋ 右側面板。簽核事件、版本鏈、角色由後端處理。 */

import { registerModule, type ModuleManifest } from '../../../core';
import { REVIEW_MODE } from './mode';
import { ReviewPanel } from './ReviewPanel';
import { ReviewToggle } from './ReviewToggle';
import { msg } from '../../../core/i18n';

export const REVIEW_MODULE_VERSION = '0.1.0';

const MANIFEST: ModuleManifest = {
  id: 'rt-gaia-review',
  version: REVIEW_MODULE_VERSION,
  panels: [
    { id: 'review.toggle', slot: 'toolbar', order: 50, group: 'task', title: msg('簽核'), component: ReviewToggle },
    { id: 'review.panel', slot: 'right-sidebar', order: 150, title: msg('簽核'), component: ReviewPanel, visibleWhen: (s) => s.modes.includes(REVIEW_MODE) },
  ],
};

let registered = false;

export function registerReviewModule(): void {
  if (registered) return;
  registered = true;
  registerModule(MANIFEST);
}

export function resetReviewModuleRegistration(): void {
  registered = false;
}

export { REVIEW_MODE };
export * from './model';
