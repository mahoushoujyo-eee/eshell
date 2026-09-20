import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./lib/i18n";
import { registerBuiltinPlugins } from "./plugins";
import { loadExternalPlugins } from "./plugins/loader";
import "./index.css";

// Startup sequence (see `docs/plans/external-plugin-contract.md`):
// register builtins, load external plugins, then render. Contribution
// resolution is synchronous, so a panel contributed after the first render
// would never appear.
registerBuiltinPlugins();

const render = () => {
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </React.StrictMode>,
  );
};

// A failing plugin is skipped inside the loader; a failing catalog fetch
// leaves the app on the builtin manifest. Both are logged, never thrown —
// and even an unexpected loader rejection must not leave a blank window:
// the app renders on the builtin manifest either way.
loadExternalPlugins().then(render, render);
