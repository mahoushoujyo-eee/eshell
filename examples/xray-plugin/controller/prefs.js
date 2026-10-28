// Panel preferences: the choices that survive a restart.
//
// These are the things a user points at a host once and expects to keep:
// where xray lives, which config file it reads, and how the panel is allowed
// to write it. The detected values are shown as the defaults, but an
// override always wins — a host can be configured in ways no probe can
// guess.

export const DEFAULT_PROBE_URL = "https://www.gstatic.com/generate_204";

export function createPrefs(react) {
  const { useCallback, useEffect, useState } = react;

  return function usePrefs(storage) {
    const [bin, setBin] = useState(() => String(storage.get("bin") || ""));
    const [binDraft, setBinDraft] = useState(bin);
    const [configPath, setConfigPath] = useState(() => String(storage.get("configPath") || ""));
    const [configPathDraft, setConfigPathDraft] = useState(configPath);
    const [unit, setUnit] = useState(() => String(storage.get("unit") || ""));
    const [unitDraft, setUnitDraft] = useState(unit);
    const [privilege, setPrivilege] = useState(() => String(storage.get("privilege") || ""));
    const [privilegeDraft, setPrivilegeDraft] = useState(privilege);
    const [probeUrl, setProbeUrl] = useState(() =>
      String(storage.get("probeUrl") || DEFAULT_PROBE_URL),
    );

    // One effect per stored key, written out rather than looped: hooks in a
    // loop would make the hook order depend on the data.
    useEffect(() => {
      storage.set("bin", bin);
    }, [storage, bin]);
    useEffect(() => {
      storage.set("configPath", configPath);
    }, [storage, configPath]);
    useEffect(() => {
      storage.set("unit", unit);
    }, [storage, unit]);
    useEffect(() => {
      storage.set("privilege", privilege);
    }, [storage, privilege]);
    useEffect(() => {
      storage.set("probeUrl", probeUrl);
    }, [storage, probeUrl]);

    const applyBin = useCallback(() => setBin(binDraft.trim()), [binDraft]);
    const resetBin = useCallback(() => {
      setBin("");
      setBinDraft("");
    }, []);
    const applyConfigPath = useCallback(
      () => setConfigPath(configPathDraft.trim()),
      [configPathDraft],
    );
    const resetConfigPath = useCallback(() => {
      setConfigPath("");
      setConfigPathDraft("");
    }, []);
    const applyUnit = useCallback(() => setUnit(unitDraft.trim()), [unitDraft]);
    const resetUnit = useCallback(() => {
      setUnit("");
      setUnitDraft("");
    }, []);
    const applyPrivilege = useCallback(
      () => setPrivilege(privilegeDraft.trim()),
      [privilegeDraft],
    );
    const resetPrivilege = useCallback(() => {
      setPrivilege("");
      setPrivilegeDraft("");
    }, []);

    return {
      bin,
      binDraft,
      setBinDraft,
      applyBin,
      resetBin,
      configPath,
      configPathDraft,
      setConfigPathDraft,
      applyConfigPath,
      resetConfigPath,
      unit,
      unitDraft,
      setUnitDraft,
      applyUnit,
      resetUnit,
      privilege,
      privilegeDraft,
      setPrivilegeDraft,
      applyPrivilege,
      resetPrivilege,
      probeUrl,
      setProbeUrl,
    };
  };
}
