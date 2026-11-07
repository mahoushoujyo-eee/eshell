// 简体中文词条。
//
// 键名是面板里出现的英文原文；`i18n.js` 在 `<html lang>` 为 zh 时查这张表，
// 查不到就原样返回英文。占位符 `{name}` 保持不变。

export const zh = {
  // --- 通用 ---------------------------------------------------------------
  "Cancel": "取消",
  "Confirm": "确认",
  "Save": "保存",
  "Retry": "重试",
  "Refresh": "刷新",
  "Settings…": "设置…",
  "Settings": "设置",
  "Delete…": "删除…",
  "Edit…": "编辑…",
  "Nodes…": "节点…",
  "Select…": "选择…",
  "Select": "选择",
  "Update": "更新",
  "Delete": "删除",
  "Delete group": "删除分组",
  "Delete subscription": "删除订阅",
  "Add group": "添加分组",
  "Add subscription": "添加订阅",
  "done": "完成",
  "written": "已写入",
  "nodes": "个节点",
  "unknown": "未知",
  "none": "无",
  "yes": "是",
  "no": "否",
  "default": "默认",
  "enabled": "已启用",
  "not configured": "未配置",
  "not found": "未找到",
  "never": "从未",
  "just now": "刚刚",
  "{n} min ago": "{n} 分钟前",
  "{n} h ago": "{n} 小时前",
  "{n} d ago": "{n} 天前",

  // --- 页签与表头 ---------------------------------------------------------
  "Overview": "概览",
  "Groups": "分组",
  "Subscriptions": "订阅",
  "Nodes": "节点",
  "Node": "节点",
  "Group": "分组",
  "Subscription": "订阅",
  "Tag": "标签",
  "Name": "名称",
  "Prefix": "前缀",
  "URL": "链接",
  "Selector": "选择器",
  "Strategy": "策略",
  "State": "状态",
  "Status": "状态",
  "Protocol": "协议",
  "Address": "地址",
  "Transport": "传输方式",
  "Delay": "延迟",
  "Updated": "更新时间",
  "Fallback tag": "回退标签",
  "Inbounds": "入站",
  "Outbounds": "出站",
  "Routing rules": "路由规则",
  "Observatory": "观测器",
  "Management API": "管理 API",
  "Domain strategy": "域名策略",
  "Log": "日志",
  "Binary": "程序路径",
  "Config": "配置文件",
  "Config path": "配置路径",
  "Service": "服务",
  "Service state": "服务状态",
  "Privilege": "提权",
  "Privilege prefix": "提权前缀",
  "Writable": "可写",
  "Probe URL": "探测地址",
  "automatic": "自动",
  "Automatic": "自动",
  "selected": "已选中",
  "standby": "备用",
  "unused": "未使用",
  "changed": "有变化",

  // --- 概览 ---------------------------------------------------------------
  "Probe the live path": "探测当前链路",
  "Measures a request through the local SOCKS inbound": "通过本机 SOCKS 入站发起一次请求来测量",
  "unknown service": "服务未知",
  "The observatory is enabled: the delays in the Nodes tab are read from the xray log.":
    "观测器已启用：节点页签中的延迟读自 xray 日志。",
  "Without an observatory in the config, xray measures nothing on its own — the delay column stays empty. The live path can still be probed.":
    "配置中没有观测器时，xray 不会自行测量——延迟列将保持为空。仍然可以探测当前链路。",

  // --- 分组 ---------------------------------------------------------------
  "A group is a balancer: it picks between the nodes whose tag starts with one of its prefixes.":
    "分组即 balancer：它在标签以其中某个前缀开头的节点之间挑选。",
  "No groups yet": "还没有分组",
  "Add a group, then point a subscription at it — a subscription's nodes carry its prefix, and the group selects by prefix.":
    "先添加分组，再让订阅指向它——订阅的节点带有其前缀，分组按前缀选中它们。",
  "No routing rule sends traffic to this group": "没有路由规则把流量交给这个分组",
  "Edit the group": "编辑分组",
  "Add a group": "添加分组",
  "A group is a balancer. Its selector holds the tag prefixes it picks between; the nodes of a subscription carry its prefix.":
    "分组即 balancer。它的 selector 里是用于挑选的标签前缀；订阅写入的节点带有该前缀。",
  "Letters, digits, dot, dash and underscore.": "字母、数字、点、短横线和下划线。",
  "leastPing and leastLoad need an observatory in the config.":
    "leastPing 与 leastLoad 需要配置中存在 observatory。",
  "Comma-separated tag prefixes. The nodes it selects are the outbounds whose tag starts with one of them.":
    "以逗号分隔的标签前缀。选中的节点即标签以其中之一开头的 outbound。",
  "Optional. The outbound used when no node of the group can be reached.":
    "可选。分组内节点都不可达时使用的 outbound。",
  "Delete the group": "删除分组",
  "The balancer is removed from the config. The nodes it selected stay in the config; only the group goes away.":
    "该 balancer 会从配置中移除。它选中的节点仍留在配置里，被删除的只是分组。",
  "This group's own selector is unknown — edit the group to set it.":
    "该分组自身的选择器未知——请编辑分组来设置。",
  "Hand the group back to its strategy": "把分组交还给它的策略",
  "No group selected": "未选择分组",

  // --- 订阅 ---------------------------------------------------------------
  "No subscriptions": "还没有订阅",
  "Add a subscription link. Its nodes are written into the config under the prefix you choose.":
    "添加订阅链接。它的节点会以你选择的前缀写入配置文件。",
  "The subscription is downloaded by the host, not by this machine.":
    "订阅由主机下载，而不是本机。",
  "The config holds a different number of nodes": "配置中的节点数量与订阅不一致",
  "Edit the subscription": "编辑订阅",
  "Delete the subscription": "删除订阅",
  "The subscription and the nodes it added to the config are removed.":
    "该订阅以及它写入配置的节点都会被删除。",
  "Add a subscription": "添加订阅",
  "The link is fetched by the host. Its nodes are written into the config under the prefix, and a group selects them by that prefix.":
    "链接由主机拉取。它的节点会以该前缀写入配置，分组按此前缀选中它们。",
  "An http(s) link. It carries your account token — the panel stores it locally and never shows it in full.":
    "一个 http(s) 链接，其中包含你的账号令牌——面板只保存在本地，且不会完整展示。",
  "The tag prefix the nodes get. Leave empty to derive it from the name.":
    "节点使用的标签前缀。留空则根据名称生成。",
  "Shown in the list.": "显示在列表中。",
  "Hong Kong": "香港",

  // --- 节点 ---------------------------------------------------------------
  "Select this node": "选择该节点",
  "The group's selector is narrowed to this node and xray is restarted. Traffic through this group moves to it.":
    "分组的 selector 会收窄到该节点，并重启 xray。经过该分组的流量将切到它。",
  "Filter the nodes": "筛选节点",
  "This group selects no nodes": "该分组未选中任何节点",
  "A group selects the outbounds whose tag starts with one of its prefixes. Update the subscription that feeds this prefix, or widen the selector.":
    "分组会选中标签以其某个前缀开头的 outbound。请更新提供该前缀的订阅，或放宽 selector。",
  "{n} nodes · {strategy}": "{n} 个节点 · {strategy}",

  // --- 设置 ---------------------------------------------------------------
  "Binary, config path, service and privilege": "程序、配置路径、服务与提权",
  "Re-read the host and the config": "重新读取主机与配置",
  "Leave a field empty to use what the host reports. The privilege prefix is used for the config write and the service restart — `sudo -n` never prompts.":
    "留空则使用主机检测到的值。提权前缀用于写配置和重启服务——`sudo -n` 不会提示输入密码。",
  "Detected: {path}": "检测到：{path}",
  "Detected: {name}": "检测到：{name}",
  "Empty, or `sudo -n`. A plain sudo would wait for a password this channel cannot type.":
    "留空，或填 `sudo -n`。普通 sudo 会等待输入密码，而此通道无法输入。",
  "The address the latency probe asks for.": "延迟探测请求的地址。",

  // --- 错误 ---------------------------------------------------------------
  "No active session": "没有活动会话",
  "Open an SSH session; the panel manages xray on that host.":
    "请打开一个 SSH 会话；面板会在该主机上管理 xray。",
  "The panel runs xray on {host} over the session's SSH transport.":
    "面板通过会话的 SSH 通道在 {host} 上运行 xray。",
  "There is no configuration to change.": "没有可修改的配置。",
  "The configuration path is not set.": "尚未设置配置路径。",
  "The probe did not report a time.": "探测没有返回耗时。",
  "Probe": "探测",
  "no config found": "未找到配置",
  "no session": "未连接会话",
  "no — but sudo -n works": "否——但 sudo -n 可用",
  "no — and sudo -n is not available": "否——且 sudo -n 不可用",
  "This user may not write the config and `sudo -n` does not work here, so the panel can read the configuration but cannot change it. Give the SSH user ownership of the config and its directory, or allow NOPASSWD sudo for the write and the restart.":
    "该用户无法写入配置，且此处 `sudo -n` 不可用——面板能读取配置但无法修改。请把配置文件及其所在目录的所有权给 SSH 用户，或为写入与重启开放免密 sudo。",
  "The config file is writable but its directory is not. The panel keeps its backup next to the file and replaces it by a rename, so it needs write access to the directory too.":
    "配置文件可写，但其所在目录不可写。面板把备份放在配置旁边，并通过改名完成替换，因此还需要该目录的写权限。",
  "xray was not found": "未找到 xray",
  "service": "服务",
};
