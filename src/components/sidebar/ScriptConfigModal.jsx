import { useEffect, useState } from "react";

const EMPTY_SCRIPT_FORM = {
  id: null,
  name: "",
  path: "",
  command: "",
  description: "",
};

export default function ScriptConfigModal({
  open,
  onClose,
  scripts,
  scriptForm,
  setScriptForm,
  onSaveScript,
  onRunScript,
  onDeleteScript,
}) {
  const [mode, setMode] = useState("list");

  useEffect(() => {
    if (open) {
      setMode("list");
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const submitScript = async (event) => {
    await onSaveScript(event);
    setMode("list");
  };

  const openCreateForm = () => {
    setScriptForm(EMPTY_SCRIPT_FORM);
    setMode("form");
  };

  const openEditForm = (item) => {
    setScriptForm(item);
    setMode("form");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-2xl border border-border/80 bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">脚本管理</h3>
            <p className="text-xs text-muted">集中管理脚本并在当前会话一键执行</p>
          </div>
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-xs text-muted hover:bg-accent-soft"
            onClick={onClose}
          >
            关闭
          </button>
        </div>

        {mode === "list" ? (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm text-muted">已配置脚本：{scripts.length}</span>
              <button
                type="button"
                className="rounded bg-accent px-3 py-1.5 text-xs text-white"
                onClick={openCreateForm}
              >
                新建脚本
              </button>
            </div>
            <div className="max-h-96 space-y-2 overflow-auto pr-1">
              {scripts.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/80 bg-surface p-4 text-center text-sm text-muted">
                  暂无脚本，点击“新建脚本”开始添加。
                </div>
              ) : (
                scripts.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-lg border border-border/70 bg-surface px-3 py-2 text-xs"
                  >
                    <div className="font-medium">{item.name}</div>
                    <div className="truncate text-muted">{item.command || item.path}</div>
                    <div className="mt-2 flex gap-1">
                      <button
                        type="button"
                        className="rounded bg-accent px-2 py-1 text-white"
                        onClick={() => onRunScript(item.id)}
                      >
                        运行
                      </button>
                      <button
                        type="button"
                        className="rounded border border-border px-2 py-1"
                        onClick={() => openEditForm(item)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="rounded border border-danger/40 px-2 py-1 text-danger"
                        onClick={() => onDeleteScript(item.id)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm text-muted">{scriptForm.id ? "编辑脚本" : "新建脚本"}</span>
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs"
                onClick={() => setMode("list")}
              >
                返回列表
              </button>
            </div>
            <form className="space-y-2" onSubmit={submitScript}>
              <input
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
                placeholder="脚本名称"
                value={scriptForm.name}
                onChange={(event) => setScriptForm((prev) => ({ ...prev, name: event.target.value }))}
              />
              <input
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
                placeholder="脚本路径"
                value={scriptForm.path}
                onChange={(event) => setScriptForm((prev) => ({ ...prev, path: event.target.value }))}
              />
              <input
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
                placeholder="执行命令"
                value={scriptForm.command}
                onChange={(event) =>
                  setScriptForm((prev) => ({ ...prev, command: event.target.value }))
                }
              />
              <div className="flex justify-end">
                <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs text-white">
                  {scriptForm.id ? "更新脚本" : "创建脚本"}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
