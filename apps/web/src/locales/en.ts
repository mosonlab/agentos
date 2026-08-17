/**
 * The English dictionary. Flat, dotted keys `<area>.<screen>.<thing>`, sorted by
 * key so a diff is readable and a duplicate key is visible on sight.
 *
 * `en` is also the fallback for every miss, so a key present here and absent from
 * `zh.ts` renders English rather than a raw key. The i18n test asserts the two
 * key sets are equal in both directions, so that fallback is a safety net and not
 * a workflow.
 */
export const en = {
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.edit": "Edit",
  "common.loading": "Loading…",
  "common.none": "—",
  "common.retry": "Retry",
  "common.save": "Save",

  "errors.route.unknown": "Unknown route {path}.",
  "errors.unauthorized": "The control plane refused the operator principal ({status}). Check OPERATOR_TOKEN in the repository root .env; it is injected by the {base} proxy in vite.config.ts.",
  "errors.unreachable": "Cannot reach the control plane ({base}). Start npm run dev:api first.",

  "format.daysAgo": "{n}d ago",
  "format.hoursAgo": "{n}h ago",
  "format.inHours": "in {n}h",
  "format.inMinutes": "in {n}m",
  "format.inUnderAMinute": "in under a minute",
  "format.justNow": "just now",
  "format.minutesAgo": "{n}m ago",
  "format.minutesSeconds": "{m}m {s}s",
  "format.seconds": "{n}s",

  "sidebar.controlPlane": "Control plane",
  "sidebar.health.degraded": "degraded",
  "sidebar.health.offline": "offline",
  "sidebar.health.online": "online",
  "sidebar.inbox.unread": "{n} unread inbox messages",
  "sidebar.nav.agents": "Agents",
  "sidebar.nav.connections": "Connections",
  "sidebar.nav.goals": "Goals",
  "sidebar.nav.inbox": "Inbox",
  "sidebar.nav.projects": "Projects",
  "sidebar.nav.secrets": "Secrets",
  "sidebar.nav.sessions": "Sessions",
  "sidebar.nav.tasks": "Tasks",
  "sidebar.project.empty": "No projects yet",
  "sidebar.project.manage": "Manage projects…",
  "sidebar.project.none": "No project",
  "sidebar.project.select": "Select project",
  "sidebar.settings": "Settings",
  "sidebar.theme.aria": "Theme: {mode}. Switch to {next}.",
  "sidebar.theme.dark": "dark",
  "sidebar.theme.label": "Theme: {mode}",
  "sidebar.theme.light": "light",
  "sidebar.theme.system": "system",
} as const satisfies Record<string, string>;
