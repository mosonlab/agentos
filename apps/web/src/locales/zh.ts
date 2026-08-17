/**
 * The Chinese dictionary. Same key set as `en.ts`, asserted in both directions by
 * `tests/i18n.test.tsx`, with the same `{placeholder}` set per key.
 *
 * Where the app already shipped Chinese copy — the three App banners, the Sessions
 * gap notice, the Agents and Connections hints — that wording is carried over
 * verbatim rather than retranslated (spec §4.3.6).
 */
export const zh = {
  "common.cancel": "取消",
  "common.delete": "删除",
  "common.edit": "编辑",
  "common.loading": "加载中…",
  "common.none": "—",
  "common.retry": "重试",
  "common.save": "保存",

  "errors.route.unknown": "未知路由 {path}。",
  "errors.unauthorized": "控制面拒绝了操作员身份（{status}）。检查仓库根 .env 的 OPERATOR_TOKEN，它由 vite.config.ts 的 {base} 代理注入。",
  "errors.unreachable": "无法连接控制面（{base}）。先启动 npm run dev:api。",

  "format.daysAgo": "{n} 天前",
  "format.hoursAgo": "{n} 小时前",
  "format.inHours": "{n} 小时后",
  "format.inMinutes": "{n} 分钟后",
  "format.inUnderAMinute": "不到一分钟后",
  "format.justNow": "刚刚",
  "format.minutesAgo": "{n} 分钟前",
  "format.minutesSeconds": "{m} 分 {s} 秒",
  "format.seconds": "{n} 秒",

  "sidebar.controlPlane": "控制面",
  "sidebar.health.degraded": "降级",
  "sidebar.health.offline": "离线",
  "sidebar.health.online": "在线",
  "sidebar.inbox.unread": "{n} 条未读收件箱消息",
  "sidebar.nav.agents": "Agents",
  "sidebar.nav.connections": "连接",
  "sidebar.nav.goals": "目标",
  "sidebar.nav.inbox": "收件箱",
  "sidebar.nav.projects": "项目",
  "sidebar.nav.secrets": "凭据",
  "sidebar.nav.sessions": "会话",
  "sidebar.nav.tasks": "任务",
  "sidebar.project.empty": "还没有项目",
  "sidebar.project.manage": "管理项目…",
  "sidebar.project.none": "无项目",
  "sidebar.project.select": "选择项目",
  "sidebar.settings": "设置",
  "sidebar.theme.aria": "主题：{mode}。切换到{next}。",
  "sidebar.theme.dark": "深色",
  "sidebar.theme.label": "主题：{mode}",
  "sidebar.theme.light": "浅色",
  "sidebar.theme.system": "跟随系统",
} as const satisfies Record<string, string>;
