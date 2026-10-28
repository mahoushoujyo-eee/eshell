// `createUi(react)` — the panel's whole component vocabulary, built once per
// activation against the host React instance so hook identity stays stable
// across re-renders.

import { createControls } from "./controls.js";
import { createData } from "./data.js";
import { createOverlays } from "./overlay.js";
import { cx } from "./tokens.js";

export { cx } from "./tokens.js";

export function createUi(react) {
  const controls = createControls(react);
  const data = createData(react, controls);
  const overlays = createOverlays(react, controls);

  return {
    ...controls,
    ...data,
    ...overlays,
    cx,
    h: react.createElement,
    Fragment: react.Fragment,
    useCallback: react.useCallback,
    useEffect: react.useEffect,
    useMemo: react.useMemo,
    useRef: react.useRef,
    useState: react.useState,
  };
}
