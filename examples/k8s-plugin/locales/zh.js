// Simplified Chinese strings for the Kubernetes panel.
//
// Keys are the English source strings, the same convention the host uses: a
// missing entry renders the key, so an untranslated string degrades to English
// instead of showing a placeholder. kubectl verbs, flags and resource kinds are
// left as they are — they are what the user would type.

export const zh = {
  // chrome
  Kubernetes: "Kubernetes",
  Refresh: "刷新",
  "Re-read the listing": "重新读取列表",
  "Panel settings": "面板设置",
  "Settings…": "设置…",
  "Active SSH session": "当前 SSH 会话",
  "API server version": "API Server 版本",
  "no session": "无会话",
  "CLI prefix": "CLI 前缀",
  "(kubeconfig default)": "（kubeconfig 默认）",
  "current: {context}": "当前：{context}",
  "(default namespace)": "（默认命名空间）",
  "all namespaces (-A)": "所有命名空间 (-A)",
  "other type…": "其他类型…",
  "Another resource type": "其他资源类型",

  // resource kinds
  Pods: "Pod",
  Deployments: "Deployment",
  StatefulSets: "StatefulSet",
  DaemonSets: "DaemonSet",
  ReplicaSets: "ReplicaSet",
  Services: "Service",
  Ingresses: "Ingress",
  Jobs: "Job",
  CronJobs: "CronJob",
  ConfigMaps: "ConfigMap",
  Secrets: "Secret",
  PVCs: "PVC",
  PVs: "PV",
  Nodes: "节点",
  Namespaces: "命名空间",
  Events: "事件",

  // toolbar
  "Filter rows…": "筛选行…",
  "Filter rows": "筛选行",
  "problems only": "仅异常",
  "Rows whose status is not healthy": "只显示状态不健康的行",
  "Rows in this listing": "本次列表的行数",
  Healthy: "健康",
  "Pending or changing": "等待中 / 变更中",
  Failing: "异常",
  "by age": "按创建时间",
  "all columns": "全部列",
  "Show the -o wide columns that are almost always empty": "显示 -o wide 中几乎总为空的列",
  "no auto refresh": "不自动刷新",
  "Auto refresh": "自动刷新",
  off: "关闭",
  "Cluster…": "集群…",
  "Top nodes": "节点资源用量",
  "Top pods": "Pod 资源用量",
  "Namespace events": "命名空间事件",
  "Cluster info": "集群信息",
  "API resources": "API 资源列表",
  "Explain this type": "查看该类型字段说明",
  Explain: "字段说明",
  "Apply YAML…": "应用 YAML…",

  // row actions
  Logs: "日志",
  Describe: "详情 (describe)",
  YAML: "YAML",
  Exec: "执行命令",
  "Copy name": "复制名称",
  "Port forward…": "端口转发…",
  "Port forward": "端口转发",
  "Scale…": "调整副本数…",
  Scale: "调整",
  "Rollout restart": "滚动重启",
  "Rollout status": "滚动状态",
  "Rollout history": "滚动历史",
  "Roll back": "回滚",
  Suspend: "暂停调度",
  Resume: "恢复调度",
  "Run now": "立即运行",
  Cordon: "标记不可调度",
  Uncordon: "恢复可调度",
  "Drain…": "驱逐 Pod…",
  Drain: "驱逐",
  "Resource usage": "资源用量",
  Delete: "删除",
  "Force delete": "强制删除",
  "Delete selected": "删除所选",
  "This type cannot be deleted from here.": "该类型不支持在此删除。",
  Clear: "清空",
  "{count} selected": "已选 {count} 项",

  // confirmations
  "Restart this workload?": "重启该工作负载？",
  "Every pod is replaced, one batch at a time, by the controller.":
    "控制器会分批替换全部 Pod。",
  Restart: "重启",
  "Roll back to the previous revision?": "回滚到上一个版本？",
  "Run this CronJob now?": "立即运行该 CronJob？",
  "A Job is created from the CronJob's template, outside its schedule.":
    "会用 CronJob 的模板创建一个 Job，不受调度时间限制。",
  "Drain this node?": "驱逐该节点上的 Pod？",
  "Every pod is evicted and the node is cordoned. DaemonSet pods are left alone and emptyDir data is deleted.":
    "会驱逐节点上的 Pod 并标记为不可调度；DaemonSet 的 Pod 保留，emptyDir 数据会被删除。",
  "Delete {name}?": "删除 {name}？",
  "Delete {count} objects?": "删除 {count} 个对象？",
  "There is no undo. A controller may recreate it immediately.":
    "删除不可撤销；若有控制器管理，它可能会立刻重建。",
  "There is no undo. A controller may recreate them immediately.":
    "删除不可撤销；若有控制器管理，它们可能会立刻重建。",
  "Force-delete {name}?": "强制删除 {name}？",
  "The API object is removed without waiting for the kubelet. For a StatefulSet pod this can break the at-most-one guarantee.":
    "不等待 kubelet 确认即删除 API 对象；对 StatefulSet 的 Pod 可能破坏“最多一个”的保证。",
  "Scale to zero?": "把副本数调为 0？",
  "Scale to zero": "调为 0",
  "Every pod of this workload is removed. Nothing serves traffic until it is scaled back up.":
    "该工作负载的所有 Pod 都会被移除，恢复副本数前不再提供服务。",

  // dialogs
  "Scale {name}": "调整副本数 · {name}",
  Replicas: "副本数",
  "Currently {current}": "当前 {current}",
  "Apply a manifest": "应用 YAML",
  "kubectl apply -f - — the document is piped in, never written to the host.":
    "kubectl apply -f - —— 内容通过管道传入，不会写到主机磁盘。",
  Manifest: "YAML 内容",
  "Applied in the namespace selected in the header unless the document names one.":
    "未在文档中指定命名空间时，使用顶部选择的命名空间。",
  "Dry run": "试运行",
  "Apply (dry run)": "应用（试运行）",
  Apply: "应用",
  "Dry run asks the API server to validate without persisting. --prune is never used.":
    "试运行只让 API Server 校验、不落盘；本面板从不使用 --prune。",
  Ports: "端口",
  "local:remote, or one port for both": "本地:远端，或只填一个端口",
  "This one has to run in a terminal tab: it holds the connection open until interrupted, and this panel's channel cannot interrupt a command.":
    "这条命令需要在终端标签页里执行：它会一直占用连接直到被中断，而本面板的通道无法中断命令。",
  "Copy command": "复制命令",
  "Command copied — paste it into a terminal tab.": "命令已复制，粘贴到终端标签页执行即可。",
  Reset: "重置",
  Cancel: "取消",
  Close: "关闭",
  Confirm: "确认",
  Copy: "复制",
  Reload: "重新加载",
  Retry: "重试",
  Run: "运行",
  "Hide the mostly-empty -o wide columns": "隐藏 -o wide 中几乎总为空的列",
  "Re-reads the listing. Paused while a dialog is open.": "定时重读列表；有弹窗打开时暂停。",
  "The context and namespace are passed per command; the host's kubeconfig is never rewritten.":
    "context 与命名空间按命令传入，不会改写主机上的 kubeconfig。",
  "What runs on the host. Use `k3s kubectl` or `microk8s kubectl` on those distributions, or `env KUBECONFIG=/path kubectl` when the config is not at ~/.kube/config.":
    "实际在主机上执行的命令。k3s / MicroK8s 请填 `k3s kubectl` 或 `microk8s kubectl`；kubeconfig 不在 ~/.kube/config 时填 `env KUBECONFIG=/路径 kubectl`。",

  // sheets
  "Filter lines…": "过滤行…",
  "all containers": "全部容器",
  "all time": "全部时间",
  previous: "上一个容器",
  "--previous: the last terminated container in this pod":
    "--previous：该 Pod 上一个已终止的容器",
  follow: "跟随",
  wrap: "折行",
  "Re-reads every 3s. kubectl logs -f cannot stream over this channel.":
    "每 3 秒重读一次；此通道无法承载 kubectl logs -f 的流式输出。",
  "(first container)": "（第一个容器）",
  "run via sh -c": "通过 sh -c 执行",
  "Off: the line is split into argv, like the CLI does after --.":
    "关闭时按 argv 拆分，与 CLI 在 -- 之后的行为一致。",
  "kubectl exec — no TTY, one command per run.": "kubectl exec —— 无 TTY，每次执行一条命令。",
  "Type a command below. Interactive programs will not work — there is no TTY.":
    "在下方输入命令。交互式程序无法使用 —— 没有 TTY。",
  "Loading…": "加载中…",
  "Nothing to show.": "没有可显示的内容。",

  // empty / error states
  "No active session": "没有活动会话",
  "Open an SSH session; the panel drives kubectl on that host.":
    "先打开一个 SSH 会话；面板会在该主机上调用 kubectl。",
  "No {kind} found.": "没有找到 {kind}。",
  "The filter matched nothing in this listing.": "当前筛选条件下没有匹配的行。",
  "kubectl get {kind} returned an empty list for this scope.":
    "在当前范围下 kubectl get {kind} 返回空列表。",
  "The panel runs {bin} on {host} over the session's SSH transport.":
    "面板通过该会话的 SSH 连接，在 {host} 上执行 {bin}。",
};
