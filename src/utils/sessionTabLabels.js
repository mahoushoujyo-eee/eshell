/**
 * Tab label per session id.
 *
 * Several tabs can point at the same server profile, and the profile name
 * alone makes them indistinguishable, so only the duplicated names get an
 * ordinal (`prod #1`, `prod #2`).
 */
export function sessionTabLabels(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const totals = new Map();
  list.forEach((session) => {
    totals.set(session.configName, (totals.get(session.configName) || 0) + 1);
  });
  const seen = new Map();
  return new Map(
    list.map((session) => {
      const ordinal = (seen.get(session.configName) || 0) + 1;
      seen.set(session.configName, ordinal);
      const label =
        totals.get(session.configName) > 1 ? `${session.configName} #${ordinal}` : session.configName;
      return [session.id, label];
    }),
  );
}
