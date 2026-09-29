import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import { bootMark } from "./lib/boot-trace";
import { dismissBootSplash } from "./lib/boot-splash";
import { I18nProvider } from "./lib/i18n";
import { registerBuiltinPlugins } from "./plugins";
import { loadExternalPlugins } from "./plugins/loader";
import "./index.css";

// Static imports are hoisted, so this line runs only once the whole module
// graph — stylesheet included — has been fetched and evaluated. The gap
// between the splash painting and this mark is module loading; everything
// after it is startup work proper.
bootMark("modules loaded");

// Startup sequence (see `docs/plans/external-plugin-contract.md`):
// register builtins, load external plugins, then render. Contribution
// resolution is synchronous, so a panel contributed after the first render
// would never appear.
registerBuiltinPlugins();

const render = () => {
  bootMark("plugins ready, rendering");
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </React.StrictMode>,
  );
  // React 18+ renders asynchronously, so this returns before the first frame
  // is committed. Deferring one frame keeps the splash up until there is
  // something behind it to reveal — dropping it synchronously would show the
  // empty `#root` for exactly the stretch the splash exists to cover.
  requestAnimationFrame(() => {
    bootMark("first frame, dismissing splash");
    dismissBootSplash();
  });
};

// A failing plugin is skipped inside the loader; a failing catalog fetch
// leaves the app on the builtin manifest. Both are logged, never thrown —
// and even an unexpected loader rejection must not leave a blank window:
// the app renders on the builtin manifest either way.
loadExternalPlugins().then(render, render);
