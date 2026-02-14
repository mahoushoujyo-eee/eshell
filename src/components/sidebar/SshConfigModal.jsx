import { useEffect, useState } from "react";

const EMPTY_SSH_FORM = {
  id: null,
  name: "",
  host: "",
  port: 22,
  username: "",
  password: "",
  description: "",
};

export default function SshConfigModal({
  open,
  onClose,
  sshConfigs,
  sshForm,
  setSshForm,
  onSaveSsh,
  onConnectServer,
  onDeleteSsh,
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

  const submitSsh = async (event) => {
    await onSaveSsh(event);
    setMode("list");
  };

  const openCreateForm = () => {
    setSshForm(EMPTY_SSH_FORM);
    setMode("form");
  };

  const openEditForm = (item) => {
    setSshForm(item);
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
            <h3 className="text-base font-semibold">SSH 服务器管理</h3>
            <p className="text-xs text-muted">集中管理服务器配置并快速连接</p>
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
              <span className="text-sm text-muted">已配置服务器：{sshConfigs.length}</span>
              <button
                type="button"
                className="rounded bg-accent px-3 py-1.5 text-xs text-white"
                onClick={openCreateForm}
              >
                新建服务器
              </button>
            </div>
            <div className="max-h-96 space-y-2 overflow-auto pr-1">
              {sshConfigs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/80 bg-surface p-4 text-center text-sm text-muted">
                  暂无服务器配置，点击“新建服务器”开始添加。
                </div>
              ) : (
                sshConfigs.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-lg border border-border/70 bg-surface px-3 py-2 text-xs"
                  >
                    <div className="font-medium">{item.name}</div>
                    <div className="text-muted">
                      {item.username}@{item.host}:{item.port}
                    </div>
                    <div className="mt-2 flex gap-1">
                      <button
                        type="button"
                        className="rounded bg-accent px-2 py-1 text-white"
                        onClick={async () => {
                          await onConnectServer(item.id);
                          onClose();
                        }}
                      >
                        连接
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
                        onClick={() => onDeleteSsh(item.id)}
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
              <span className="text-sm text-muted">{sshForm.id ? "编辑服务器" : "新建服务器"}</span>
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs"
                onClick={() => setMode("list")}
              >
                返回列表
              </button>
            </div>
            <form className="space-y-2" onSubmit={submitSsh}>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                  placeholder="名称"
                  value={sshForm.name}
                  onChange={(event) =>
                    setSshForm((prev) => ({ ...prev, name: event.target.value }))
                  }
                />
                <input
                  className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                  placeholder="主机"
                  value={sshForm.host}
                  onChange={(event) =>
                    setSshForm((prev) => ({ ...prev, host: event.target.value }))
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                  placeholder="端口"
                  value={sshForm.port}
                  onChange={(event) =>
                    setSshForm((prev) => ({ ...prev, port: event.target.value }))
                  }
                />
                <input
                  className="rounded border border-border bg-surface px-2 py-1.5 text-sm"
                  placeholder="用户名"
                  value={sshForm.username}
                  onChange={(event) =>
                    setSshForm((prev) => ({ ...prev, username: event.target.value }))
                  }
                />
              </div>
              <input
                type="password"
                className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
                placeholder="密码"
                value={sshForm.password}
                onChange={(event) =>
                  setSshForm((prev) => ({ ...prev, password: event.target.value }))
                }
              />
              <div className="flex justify-end">
                <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs text-white">
                  {sshForm.id ? "更新服务器" : "创建服务器"}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
