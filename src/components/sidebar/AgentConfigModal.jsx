import {
  Bot,
  Check,
  FileText,
  Loader2,
  Save,
  Server,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { api } from "../../lib/tauri-api";
import Button from "../ui/Button";
import Dialog, { DialogHeader } from "../ui/Dialog";
import { textareaClass } from "../ui/fieldClasses";

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
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      className="h-[min(600px,88vh)]"
      labelledBy="agent-config-title"
    >
      <DialogHeader
        icon={Bot}
        tone="accent"
        title={t("Agent Config")}
        titleId="agent-config-title"
        onClose={onClose}
      />
      <div className="flex min-h-0 flex-1">
        <nav className="scroll-region flex w-60 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-surface p-2">
          {targetRows.map((row) => {
            const active = row.key === selectedKey;
            return (
              <button
                key={row.key}
                type="button"
                onClick={() => setSelectedKey(row.key)}
                aria-current={active ? "page" : undefined}
                className={[
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150",
                  active ? "bg-accent-soft" : "hover:bg-hover",
                ].join(" ")}
              >
                <span
                  className={[
                    "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-panel",
                    active ? "text-accent" : "text-muted",
                  ].join(" ")}
                >
                  {row.key === GLOBAL_KEY ? (
                    <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Server className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-text">{row.label}</span>
                  <span className="block truncate font-mono text-[10.5px] text-muted">{row.hint}</span>
                </span>
                {row.exists ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] text-success"
                    title={t("Exists")}
                  >
                    <Check className="h-3 w-3" aria-hidden="true" />
                    {t("Exists")}
                  </span>
                ) : (
                  <span className="shrink-0 text-[10.5px] text-subtle">{t("Empty")}</span>
                )}
              </button>
            );
          })}
          {sshConfigs.length === 0 ? (
            <div className="mt-1 rounded-md border border-dashed border-border-strong px-3 py-3 text-center text-xs text-muted">
              {t("No server profiles yet.")}
            </div>
          ) : null}
        </nav>

        <section className="flex min-w-0 flex-1 flex-col gap-2.5 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-text">{contentTargetLabel}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!isGlobal ? (
                <Button variant="danger" onClick={deleteFile} disabled={deleting}>
                  {deleting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {t("Delete")}
                </Button>
              ) : null}
              <Button variant="primary" onClick={saveFile} disabled={saving || contentBusy}>
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {t("Save")}
              </Button>
            </div>
          </div>

          {contentError ? (
            <div className="rounded-md border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">
              {contentError}
            </div>
          ) : null}

          {contentBusy && !saving ? (
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border border-dashed border-border-strong">
              <Loader2 className="h-4 w-4 animate-spin text-muted" aria-hidden="true" />
            </div>
          ) : (
            <textarea
              className={`${textareaClass} min-h-0 flex-1 resize-none font-mono text-xs leading-5`}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder={t("Agent instructions, preferences, policies...")}
              disabled={contentBusy}
              spellCheck={false}
            />
          )}
        </section>
      </div>
    </Dialog>
  );
}
