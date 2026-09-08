import {
  Bot,
  Check,
  ChevronRight,
  FileText,
  Loader2,
  Save,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { api } from "../../lib/tauri-api";

const GLOBAL_KEY = "global";

export default function AgentConfigModal({
  open,
  onClose,
  sshConfigs = [],
  onNotice,
}) {
  const { t } = useI18n();
  const [selectedKey, setSelectedKey] = useState(GLOBAL_KEY);
  const [content, setContent] = useState("");
  const [contentBusy, setContentBusy] = useState(false);
  const [contentError, setContentError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [existsMap, setExistsMap] = useState({});

  const isGlobal = selectedKey === GLOBAL_KEY;
  const selectedServerId = isGlobal ? null : selectedKey;
  const selectedServer = sshConfigs.find((item) => item.id === selectedServerId) || null;
  const contentTargetLabel = isGlobal
    ? t("Global AGENTS.md")
    : selectedServer?.name || selectedServer?.host || selectedServerId;

  const loadFileList = useCallback(async () => {
    try {
      const result = await api.listAgentContextFiles();
      const map = {};
      if (result?.global != null) {
        map[GLOBAL_KEY] = result.global.exists;
      }
      for (const server of result?.servers || []) {
        if (server.serverId) {
          map[server.serverId] = server.exists;
        }
      }
      setExistsMap(map);
    } catch {
      // Best-effort; selecting a target surfaces its own load error.
    }
  }, []);

  const loadTarget = useCallback(async (key) => {
    setContentBusy(true);
    setContentError("");
    try {
      const serverId = key === GLOBAL_KEY ? null : key;
      const result = await api.getAgentContext(serverId);
      setContent(result?.content || "");
    } catch (error) {
      setContent("");
      setContentError(String(error || ""));
    } finally {
      setContentBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    setSelectedKey(GLOBAL_KEY);
    setContent("");
    setContentError("");
    void loadFileList();
  }, [open, loadFileList]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadTarget(selectedKey);
  }, [open, selectedKey, loadTarget]);

  const saveFile = async () => {
    if (contentBusy || saving) {
      return;
    }
    setSaving(true);
    setContentError("");
    try {
      await api.saveAgentContext(selectedServerId, content);
      setExistsMap((prev) => ({ ...prev, [selectedKey]: true }));
      onNotice?.(t("Saved {target}", { target: contentTargetLabel }), "success");
    } catch (error) {
      setContentError(String(error || ""));
    } finally {
      setSaving(false);
    }
  };

  const deleteFile = async () => {
    if (isGlobal || deleting) {
      return;
    }
    setDeleting(true);
    setContentError("");
    try {
      await api.deleteAgentContext(selectedServerId);
      setExistsMap((prev) => ({ ...prev, [selectedKey]: false }));
      setContent("");
      onNotice?.(t("Deleted {target}", { target: contentTargetLabel }), "info");
    } catch (error) {
      setContentError(String(error || ""));
    } finally {
      setDeleting(false);
    }
  };

  if (!open) {
    return null;
  }

  const targetRows = [
    {
      key: GLOBAL_KEY,
      label: t("Global AGENTS.md"),
      hint: t("Injected as global context."),
      exists: Boolean(existsMap[GLOBAL_KEY]),
    },
    ...sshConfigs.map((server) => ({
      key: server.id,
      label: server.name || server.host || server.id,
      hint: server.host || "",
      exists: Boolean(existsMap[server.id]),
    })),
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div
        className="w-full max-w-3xl rounded-2xl border border-border/80 bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="inline-flex items-center gap-2 text-base font-semibold">
              <Bot className="h-4 w-4 text-accent" aria-hidden="true" />
              {t("Agent Config")}
            </h3>
            <p className="text-xs text-muted">
              {t("Agent context is stored as editable AGENTS.md files under .eshell-data/agent/.")}
            </p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted hover:bg-accent-soft"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {t("Close")}
          </button>
        </div>

        <div className="grid max-h-[64vh] gap-3 overflow-auto pr-1 md:grid-cols-[240px_1fr]">
          <nav className="min-w-0 space-y-1">
            {targetRows.map((row) => {
              const active = row.key === selectedKey;
              return (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => setSelectedKey(row.key)}
                  className={[
                    "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition",
                    active
                      ? "border-accent/50 bg-accent-soft/40"
                      : "border-border/70 bg-surface hover:bg-accent-soft/25",
                  ].join(" ")}
                >
                  <span
                    className={[
                      "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border",
                      active ? "border-accent/40 bg-panel text-accent" : "border-border/70 bg-panel text-muted",
                    ].join(" ")}
                  >
                    {row.key === GLOBAL_KEY ? (
                      <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <Server className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{row.label}</span>
                    <span className="block truncate text-[11px] text-muted">{row.hint}</span>
                  </span>
                  {row.exists ? (
                    <span className="inline-flex items-center gap-0.5 rounded-full border border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] text-success">
                      <Check className="h-3 w-3" aria-hidden="true" />
                      {t("Exists")}
                    </span>
                  ) : (
                    <span className="inline-flex rounded-full border border-border/70 bg-panel px-1.5 py-0.5 text-[10px] text-muted">
                      {t("Empty")}
                    </span>
                  )}
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                </button>
              );
            })}
            {sshConfigs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/80 bg-surface p-3 text-center text-xs text-muted">
                {t("No server profiles yet.")}
              </div>
            ) : null}
          </nav>

          <section className="min-w-0 rounded-xl border border-border/70 bg-surface p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{contentTargetLabel}</div>
                <div className="truncate text-[11px] text-muted">
                  {t("Select a server and Save to create its context file.")}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!isGlobal ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded border border-danger/40 px-3 py-1.5 text-xs text-danger disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={deleteFile}
                    disabled={deleting}
                  >
                    {deleting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {t("Delete")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white disabled:cursor-wait disabled:opacity-60"
                  onClick={saveFile}
                  disabled={saving || contentBusy}
                >
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {t("Save")}
                </button>
              </div>
            </div>

            {contentError ? (
              <div className="mb-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                {contentError}
              </div>
            ) : null}

            {contentBusy && !saving ? (
              <div className="flex h-56 items-center justify-center rounded border border-dashed border-border/80 bg-panel">
                <Loader2 className="h-4 w-4 animate-spin text-muted" aria-hidden="true" />
              </div>
            ) : (
              <textarea
                className="h-56 w-full resize-none rounded border border-border bg-panel px-3 py-2 text-xs leading-5 text-text outline-none disabled:opacity-60"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder={t("Agent instructions, preferences, policies...")}
                disabled={contentBusy}
              />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
