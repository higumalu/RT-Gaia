// RT-Gaia plugin shim (docs/plugin-contract.md, UI bundles): gives plugin bundles the host's react instance as an ES module.
// The import map in index.html points here; the host fills globalThis.__rtgaia__ in src/sdk/expose.ts.
const H = globalThis.__rtgaia__;
if (!H) throw new Error('RT-Gaia host is not loaded (globalThis.__rtgaia__ is missing); plugin bundles can only be loaded by the RT-Gaia viewer');
const M = H.react;
export default M;
export const { Activity, Children, Component, Fragment, Profiler, PureComponent, StrictMode, Suspense, act, cache, cacheSignal, captureOwnerStack, cloneElement, createContext, createElement, createRef, forwardRef, isValidElement, lazy, memo, startTransition, unstable_useCacheRefresh, use, useActionState, useCallback, useContext, useDebugValue, useDeferredValue, useEffect, useEffectEvent, useId, useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo, useOptimistic, useReducer, useRef, useState, useSyncExternalStore, useTransition, version } = M;
