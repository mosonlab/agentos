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
export const IconRepos = (): ReactNode => (
  <Svg><circle cx="4.4" cy="3.6" r="1.6" /><circle cx="4.4" cy="12.4" r="1.6" /><circle cx="11.6" cy="6" r="1.6" /><path d="M4.4 5.2v5.6M11.6 7.6c0 2.2-2.2 2.2-3.6 2.8" /></Svg>
);
/** Two stacked speech bubbles — a session is a conversation. Local rather than
 *  lucide because every other sidebar glyph comes from this set. */
export const IconSessions = (): ReactNode => (
  <Svg><path d="M2 3.4a1 1 0 0 1 1-1h7.2a1 1 0 0 1 1 1v4.2a1 1 0 0 1-1 1H5.4L3 10.8V8.6a1 1 0 0 1-1-1z" /><path d="M11.2 5.6h1.8a1 1 0 0 1 1 1v4.2a1 1 0 0 1-1 1v2.2l-2.4-2.2H6.6" /></Svg>
);
export const IconActivity = (): ReactNode => (
  <Svg><path d="M1.6 8h3l1.6-4.6L9.4 12l1.4-4h3.6" /></Svg>
);
export const IconChevron = ({ open }: { open?: boolean }): ReactNode => (
  <Svg size={14}><path d={open ? "M4 9.5 8 5.5l4 4" : "M4 6.5 8 10.5l4-4"} /></Svg>
);
export const IconChevronRight = (): ReactNode => (
  <Svg size={14}><path d="M6 3.5 10.5 8 6 12.5" /></Svg>
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
export const IconTrash = (): ReactNode => (
  <Svg size={14}><path d="M2.6 4h10.8M6.4 4V2.6h3.2V4M4 4v8.4a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4" /></Svg>
);
export const IconEdit = (): ReactNode => (
  <Svg size={14}><path d="M11.2 2.6 13.4 4.8 5.6 12.6l-3 .8.8-3z" /></Svg>
);
export const IconSend = (): ReactNode => (
  <Svg size={14}><path d="M14 2 2 7.2l4.6 1.8L8.4 14z" /></Svg>
);
export const IconCheck = (): ReactNode => (
  <Svg size={14}><path d="M3 8.4 6.4 11.6 13 4.8" /></Svg>
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
export const IconFolder = (): ReactNode => (
  <Svg size={14}><path d="M1.9 12.4V3.6a1 1 0 0 1 1-1h3.1l1.4 1.8h5.7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2.9a1 1 0 0 1-1-1z" /></Svg>
);
export const IconArchive = (): ReactNode => (
  <Svg size={14}><rect x="1.9" y="2.6" width="12.2" height="3" rx="1" /><path d="M3.2 5.6v7a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1v-7M6.4 8.4h3.2" /></Svg>
);
