import type { ReactNode } from "react";

/** Thin-line 16px icons in the shape of the reference sidebar set
 *  (design-reference/ui-notes.md §1). */

const Svg = ({ children, size = 16 }: { children: ReactNode; size?: number }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const IconInbox = (): ReactNode => (
  <Svg><path d="M1.8 8.6V3.4a1 1 0 0 1 1-1h10.4a1 1 0 0 1 1 1v5.2" /><path d="M1.8 8.6h3.4l1 1.8h3.6l1-1.8h3.4v3.8a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" /></Svg>
);
export const IconTasks = (): ReactNode => (
  <Svg><path d="M1.9 4h2M1.9 8h2M1.9 12h2M6.4 4h7.7M6.4 8h7.7M6.4 12h7.7" /></Svg>
);
export const IconGoals = (): ReactNode => (
  <Svg><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="3" /><circle cx="8" cy="8" r=".6" fill="currentColor" /></Svg>
);
export const IconAgents = (): ReactNode => (
  <Svg><rect x="3" y="5.5" width="10" height="8" rx="2" /><path d="M8 2.2v3.3M5.8 9h.01M10.2 9h.01" /></Svg>
);
export const IconProjects = (): ReactNode => (
  <Svg><path d="M2 5.2 8 2l6 3.2-6 3.2z" /><path d="m2 10.8 6 3.2 6-3.2M2 8l6 3.2L14 8" /></Svg>
);
export const IconConnections = (): ReactNode => (
  <Svg><path d="M6.5 9.5 9.5 6.5" /><path d="M7.2 4.6 8.8 3a2.9 2.9 0 0 1 4.2 4.2l-1.6 1.6" /><path d="M8.8 11.4 7.2 13A2.9 2.9 0 0 1 3 8.8l1.6-1.6" /></Svg>
);
export const IconSecrets = (): ReactNode => (
  <Svg><path d="M8 1.9 13.3 4v4c0 3-2.2 5.1-5.3 6.1C4.9 13.1 2.7 11 2.7 8V4z" /><path d="M8 7v2.6" /></Svg>
);
/** Two stacked speech bubbles — a session is a conversation. Local rather than
 *  lucide because every other sidebar glyph comes from this set. */
export const IconSessions = (): ReactNode => (
  <Svg><path d="M2 3.4a1 1 0 0 1 1-1h7.2a1 1 0 0 1 1 1v4.2a1 1 0 0 1-1 1H5.4L3 10.8V8.6a1 1 0 0 1-1-1z" /><path d="M11.2 5.6h1.8a1 1 0 0 1 1 1v4.2a1 1 0 0 1-1 1v2.2l-2.4-2.2H6.6" /></Svg>
);
/** Stacked bars behind a coin — the page is spend over time, not a price tag. */
export const IconCosts = (): ReactNode => (
  <Svg><path d="M2.4 13.6h11.2" /><path d="M4.2 13.6V9.4M7.4 13.6V6.4M10.6 13.6V10.2M13.4 13.6V4.2" /></Svg>
);
export const IconSettings = (): ReactNode => (
  <Svg><circle cx="8" cy="8" r="2.2" /><path d="M8 1.7v1.5M8 12.8v1.5M1.7 8h1.5M12.8 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M12.5 3.5l-1 1M4.5 11.5l-1 1" /></Svg>
);
export const IconChevron = ({ open }: { open?: boolean }): ReactNode => (
  <Svg size={14}><path d={open ? "M4 9.5 8 5.5l4 4" : "M4 6.5 8 10.5l4-4"} /></Svg>
);
export const IconArrowLeft = (): ReactNode => (
  <Svg><path d="M13 8H3.4M7 3.8 3 8l4 4.2" /></Svg>
);
export const IconPlus = (): ReactNode => (
  <Svg size={14}><path d="M8 3v10M3 8h10" /></Svg>
);
export const IconDots = (): ReactNode => (
  <Svg><circle cx="8" cy="3.4" r=".9" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none" /><circle cx="8" cy="12.6" r=".9" fill="currentColor" stroke="none" /></Svg>
);
export const IconRefresh = (): ReactNode => (
  <Svg size={14}><path d="M13.4 7A5.4 5.4 0 0 0 3.6 4.6M2.6 9A5.4 5.4 0 0 0 12.4 11.4" /><path d="M3.2 1.9v2.8h2.8M12.8 14.1v-2.8h-2.8" /></Svg>
);
export const IconSend = (): ReactNode => (
  <Svg size={14}><path d="M14 2 2 7.2l4.6 1.8L8.4 14z" /></Svg>
);
export const IconQuestion = (): ReactNode => (
  <Svg size={14}><circle cx="8" cy="8" r="6.2" /><path d="M6.4 6.2a1.7 1.7 0 0 1 3.3.5c0 1.2-1.7 1.4-1.7 2.6M8 11.6h.01" /></Svg>
);
export const IconRobot = (): ReactNode => (
  <Svg size={13}><rect x="2.6" y="5.4" width="10.8" height="8" rx="2" /><path d="M8 2.4v3M5.6 9h.01M10.4 9h.01" /></Svg>
);
export const IconUser = (): ReactNode => (
  <Svg size={13}><circle cx="8" cy="5.4" r="2.6" /><path d="M2.9 13.6a5.1 5.1 0 0 1 10.2 0" /></Svg>
);
export const IconArchive = (): ReactNode => (
  <Svg size={14}><rect x="1.9" y="2.6" width="12.2" height="3" rx="1" /><path d="M3.2 5.6v7a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1v-7M6.4 8.4h3.2" /></Svg>
);
export const IconLock = (): ReactNode => (
  <Svg size={13}><rect x="3.4" y="7" width="9.2" height="6.4" rx="1.2" /><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" /></Svg>
);
export const IconBolt = ({ size = 16 }: { size?: number } = {}): ReactNode => (
  <Svg size={size}><path d="M8.9 1.8 3.4 9.1h3.9l-.8 5.1 5.5-7.3H8.1z" /></Svg>
);

/** Tool-line glyphs stay in the hand-authored icon set: the stream renderer
 * picks one by tool name without adding an icon dependency. */
export const IconToolRead = (): ReactNode => (
  <Svg size={14}><path d="M3 2.5h7l3 3v8H3z" /><path d="M10 2.5v3h3M5.5 8h5M5.5 10.5h5" /></Svg>
);
export const IconToolEdit = (): ReactNode => (
  <Svg size={14}><path d="m3 11.8-.5 2.2 2.2-.5L12.8 5.4a1.5 1.5 0 0 0-2.2-2.2z" /><path d="m9.6 4 2.2 2.2" /></Svg>
);
export const IconToolSearch = (): ReactNode => (
  <Svg size={14}><circle cx="6.4" cy="6.4" r="3.7" /><path d="m9.2 9.2 3.5 3.5" /></Svg>
);
export const IconToolRun = (): ReactNode => (
  <Svg size={14}><path d="m5.2 3.5 5 4.5-5 4.5z" /><path d="M2.5 13.5h11" /></Svg>
);
export const IconToolWeb = (): ReactNode => (
  <Svg size={14}><circle cx="8" cy="8" r="5.7" /><path d="M2.6 8h10.8M8 2.3c1.5 1.6 2.2 3.5 2.2 5.7S9.5 12.1 8 13.7C6.5 12.1 5.8 10.2 5.8 8S6.5 3.9 8 2.3z" /></Svg>
);
export const IconToolDefault = (): ReactNode => (
  <Svg size={14}><circle cx="4" cy="8" r=".9" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none" /><circle cx="12" cy="8" r=".9" fill="currentColor" stroke="none" /></Svg>
);
