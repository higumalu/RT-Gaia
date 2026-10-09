/**
 * `core/geometry` —— 「單一 3D ＋ 時間空間」的 TypeScript 定義。
 *
 * 🔴 **這是 `rtgaia-geom`（Python）的鏡像，不是另一份設計。**
 * 兩邊的不變式代號、容差、以及 index↔world 的算法都必須一致；
 * `tests/geometry-consistency.test.ts` 以後端產生的測試向量檔逐條驗證這件事。
 */

export * from './displayGrid';
export * from './errors';
export * from './frameGroup';
export * from './viewInFrame';
export * from './grid';
export * from './invariants';
export * from './lps';
export * from './rigid';
export * from './temporal';
export * from './viewReference';
