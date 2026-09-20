import { listPanelContributions, listToolbarContributions } from "./registry";

/**
 * Resolves manifest discovery order against registered plugin
 * implementations.
 *
 * The manifest is the only source of *order*: a panel contributed by a plugin
 * that is not in the manifest is a bug (it renders last with a warning-free
 * no-op today, but stays testable); a manifest entry with no registered
 * implementation is a missing panel (hidden, not crashed).
 *
 * Both lists are ordered by manifest `order`, falling back to registration
 * order when the manifest omits one.
 */
export const resolvePanelContributions = (extensions) => {
  const registered = listPanelContributions();
  const registeredByPluginAndPanel = new Map(
    registered.map((panel) => [`${panel.pluginId}:${panel.id}`, panel]),
  );

  const manifestOrder = [];
  const seen = new Set();
  for (const extension of extensions || []) {
    for (const panel of extension?.contributes?.panels || []) {
      const compositeKey = `${extension.id}:${panel.id}`;
      if (seen.has(compositeKey)) {
        continue;
      }
      seen.add(compositeKey);
      manifestOrder.push({
        extensionId: extension.id,
        panelId: panel.id,
        order: panel.order ?? 0,
        enabled: extension.enabled !== false,
      });
    }
  }

  // Panels registered but missing from the manifest keep rendering (after the
  // manifest-ordered ones) so a manifest regression cannot blank the dock.
  const orphans = registered.filter(
    (panel) => !manifestOrder.some((entry) => entry.extensionId === panel.pluginId && entry.panelId === panel.id),
  );

  const byOrder = (left, right) =>
    left.order === right.order ? 0 : left.order < right.order ? -1 : 1;

  return [
    ...manifestOrder
      .map((entry) => {
        const implementation = registeredByPluginAndPanel.get(
          `${entry.extensionId}:${entry.panelId}`,
        );
        if (!implementation) {
          return null;
        }
        return {
          ...implementation,
          extensionId: entry.extensionId,
          order: entry.order,
          enabled: entry.enabled,
        };
      })
      // A disabled extension contributes nothing: its panel is hidden until
      // the extension is re-enabled, matching the manifest's enabled flag.
      .filter((panel) => panel && panel.enabled)
      .sort(byOrder),
    ...orphans.map((panel) => ({
      ...panel,
      extensionId: panel.pluginId,
      order: 0,
      enabled: true,
    })),
  ];
};

export const resolveToolbarContributions = (extensions) => {
  const registered = listToolbarContributions();
  const registeredByPluginAndPanel = new Map(
    registered.map((item) => [`${item.pluginId}:${item.id}`, item]),
  );

  const manifestOrder = [];
  const seen = new Set();
  for (const extension of extensions || []) {
    for (const panel of extension?.contributes?.panels || []) {
      const compositeKey = `${extension.id}:${panel.id}`;
      if (seen.has(compositeKey)) {
        continue;
      }
      seen.add(compositeKey);
      manifestOrder.push({
        extensionId: extension.id,
        panelId: panel.id,
        order: panel.order ?? 0,
        enabled: extension.enabled !== false,
      });
    }
  }

  const orphans = registered.filter(
    (item) => !manifestOrder.some((entry) => entry.extensionId === item.pluginId && entry.panelId === item.id),
  );

  const byOrder = (left, right) =>
    left.order === right.order ? 0 : left.order < right.order ? -1 : 1;

  return [
    ...manifestOrder
      .map((entry) => {
        const implementation = registeredByPluginAndPanel.get(
          `${entry.extensionId}:${entry.panelId}`,
        );
        if (!implementation) {
          return null;
        }
        return {
          ...implementation,
          extensionId: entry.extensionId,
          order: entry.order,
          enabled: entry.enabled,
        };
      })
      // A disabled extension contributes no toolbar entry either.
      .filter((item) => item && item.enabled)
      .sort(byOrder),
    ...orphans.map((item) => ({
      ...item,
      extensionId: item.pluginId,
      order: 0,
      enabled: true,
    })),
  ];
};
