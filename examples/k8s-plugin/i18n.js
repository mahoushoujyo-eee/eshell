// Locale support for the Kubernetes panel.
//
// The plugin cannot import the host's i18n module (a plugin ships browser ESM
// and only resolves its own relative files), but the host does publish its
// language on `<html lang>` — `en` or `zh-CN`. Reading that attribute is a
// public DOM contract rather than a private host API, so the panel follows the
// app's language switch without reaching into eShell's internals.

import { zh } from "./locales/zh.js";

const DICTIONARIES = { zh };

const normalizeLanguage = (value) =>
  String(value ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";

const currentLanguage = () =>
  typeof document === "undefined" || !document.documentElement
    ? "en"
    : normalizeLanguage(document.documentElement.lang);

const interpolate = (template, vars) =>
  vars
    ? String(template).replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
      )
    : String(template);

/**
 * Translates one source string. The language is read on every call, so a
 * language switch takes effect on the next render without rebuilding the
 * panel's component tree.
 */
export function t(key, vars) {
  const dictionary = DICTIONARIES[currentLanguage()];
  return interpolate((dictionary && dictionary[key]) || key, vars);
}

/**
 * Re-renders the caller when the host switches language. `<html lang>` is set
 * by the app's own locale effect, so observing that attribute is enough; there
 * is no host event to subscribe to.
 */
export function createUseLocale(react) {
  const { useEffect, useState } = react;
  return function useLocale() {
    const [language, setLanguage] = useState(currentLanguage);
    useEffect(() => {
      if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
        return undefined;
      }
      const observer = new MutationObserver(() => setLanguage(currentLanguage()));
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["lang"],
      });
      setLanguage(currentLanguage());
      return () => observer.disconnect();
    }, []);
    return language;
  };
}
