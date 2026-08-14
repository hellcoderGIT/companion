import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";

export type DiffBase = "last-commit" | "default-branch";
/**
 * Message feed density.
 * - "standard": every command / diff / output block is rendered inline (the original layout).
 * - "compact":  those blocks collapse to a single narrow line the user can expand on demand,
 *               and empty thinking steps are hidden entirely.
 */
export type Density = "standard" | "compact";
import { type TaskPanelConfig, getInitialTaskPanelConfig, getDefaultConfig, persistTaskPanelConfig } from "../components/task-panel-sections.js";

function getInitialDarkMode(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem("cc-dark-mode");
  if (stored !== null) return stored === "true";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getInitialNotificationSound(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem("cc-notification-sound");
  if (stored !== null) return stored === "true";
  return true;
}

function getInitialNotificationDesktop(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem("cc-notification-desktop");
  if (stored !== null) return stored === "true";
  return false;
}

export function getInitialDiffBase(): DiffBase {
  if (typeof window === "undefined") return "last-commit";
  const stored = window.localStorage.getItem("cc-diff-base");
  if (stored === "last-commit" || stored === "default-branch") return stored;
  return "last-commit";
}

/**
 * Density is a per-browser preference (like dark mode), not a server setting —
 * the same account may want compact on a laptop and standard on a big screen.
 */
export function getInitialDensity(): Density {
  if (typeof window === "undefined") return "standard";
  const stored = window.localStorage.getItem("cc-density");
  if (stored === "standard" || stored === "compact") return stored;
  return "standard";
}

export interface UiSlice {
  darkMode: boolean;
  notificationSound: boolean;
  notificationDesktop: boolean;
  sidebarOpen: boolean;
  taskPanelOpen: boolean;
  taskPanelConfig: TaskPanelConfig;
  taskPanelConfigMode: boolean;
  homeResetKey: number;
  publicUrl: string;
  /**
   * MagicUI feature availability: global magicUiEnabled setting AND the
   * server reporting a usable Claude CLI. Fetched with the app settings on
   * mount; gates the per-session Magic toggle and the MagicUI view.
   */
  magicUiAvailable: boolean;
  activeTab: "chat" | "diff";
  chatTabReentryTickBySession: Map<string, number>;
  diffPanelSelectedFile: Map<string, string>;
  diffBase: DiffBase;
  density: Density;

  setDarkMode: (v: boolean) => void;
  toggleDarkMode: () => void;
  setNotificationSound: (v: boolean) => void;
  toggleNotificationSound: () => void;
  setNotificationDesktop: (v: boolean) => void;
  toggleNotificationDesktop: () => void;
  setPublicUrl: (url: string) => void;
  setMagicUiAvailable: (v: boolean) => void;
  setSidebarOpen: (v: boolean) => void;
  setTaskPanelOpen: (open: boolean) => void;
  setTaskPanelConfigMode: (open: boolean) => void;
  toggleSectionEnabled: (sectionId: string) => void;
  moveSectionUp: (sectionId: string) => void;
  moveSectionDown: (sectionId: string) => void;
  resetTaskPanelConfig: () => void;
  newSession: () => void;
  setActiveTab: (tab: "chat" | "diff") => void;
  markChatTabReentry: (sessionId: string) => void;
  setDiffPanelSelectedFile: (sessionId: string, filePath: string | null) => void;
  setDiffBase: (base: DiffBase) => void;
  setDensity: (density: Density) => void;
  toggleDensity: () => void;
}

export const createUiSlice: StateCreator<AppState, [], [], UiSlice> = (set) => ({
  darkMode: getInitialDarkMode(),
  notificationSound: getInitialNotificationSound(),
  notificationDesktop: getInitialNotificationDesktop(),
  sidebarOpen: typeof window !== "undefined" ? window.innerWidth >= 768 : true,
  taskPanelOpen: typeof window !== "undefined" ? window.innerWidth >= 1024 : true,
  taskPanelConfig: getInitialTaskPanelConfig(),
  taskPanelConfigMode: false,
  homeResetKey: 0,
  publicUrl: "",
  magicUiAvailable: false,
  activeTab: "chat",
  chatTabReentryTickBySession: new Map(),
  diffPanelSelectedFile: new Map(),
  diffBase: getInitialDiffBase(),
  density: getInitialDensity(),

  setDarkMode: (v) => {
    localStorage.setItem("cc-dark-mode", String(v));
    set({ darkMode: v });
  },
  toggleDarkMode: () =>
    set((s) => {
      const next = !s.darkMode;
      localStorage.setItem("cc-dark-mode", String(next));
      return { darkMode: next };
    }),
  setNotificationSound: (v) => {
    localStorage.setItem("cc-notification-sound", String(v));
    set({ notificationSound: v });
  },
  toggleNotificationSound: () =>
    set((s) => {
      const next = !s.notificationSound;
      localStorage.setItem("cc-notification-sound", String(next));
      return { notificationSound: next };
    }),
  setNotificationDesktop: (v) => {
    localStorage.setItem("cc-notification-desktop", String(v));
    set({ notificationDesktop: v });
  },
  toggleNotificationDesktop: () =>
    set((s) => {
      const next = !s.notificationDesktop;
      localStorage.setItem("cc-notification-desktop", String(next));
      return { notificationDesktop: next };
    }),
  setPublicUrl: (url) => set({ publicUrl: url }),
  setMagicUiAvailable: (v) => set({ magicUiAvailable: v }),
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  setTaskPanelOpen: (open) => set({ taskPanelOpen: open }),
  setTaskPanelConfigMode: (open) => set({ taskPanelConfigMode: open }),
  toggleSectionEnabled: (sectionId) =>
    set((s) => {
      const config: TaskPanelConfig = {
        order: [...s.taskPanelConfig.order],
        enabled: { ...s.taskPanelConfig.enabled, [sectionId]: !s.taskPanelConfig.enabled[sectionId] },
      };
      persistTaskPanelConfig(config);
      return { taskPanelConfig: config };
    }),
  moveSectionUp: (sectionId) =>
    set((s) => {
      const order = [...s.taskPanelConfig.order];
      const idx = order.indexOf(sectionId);
      if (idx <= 0) return s;
      [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
      const config: TaskPanelConfig = { ...s.taskPanelConfig, order };
      persistTaskPanelConfig(config);
      return { taskPanelConfig: config };
    }),
  moveSectionDown: (sectionId) =>
    set((s) => {
      const order = [...s.taskPanelConfig.order];
      const idx = order.indexOf(sectionId);
      if (idx < 0 || idx >= order.length - 1) return s;
      [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
      const config: TaskPanelConfig = { ...s.taskPanelConfig, order };
      persistTaskPanelConfig(config);
      return { taskPanelConfig: config };
    }),
  resetTaskPanelConfig: () => {
    const config = getDefaultConfig();
    persistTaskPanelConfig(config);
    set({ taskPanelConfig: config });
  },
  newSession: () => {
    localStorage.removeItem("cc-current-session");
    // Cross-slice write: clears currentSessionId (owned by SessionsSlice)
    // alongside the homeResetKey bump to return the user to the home page.
    set((s) => ({ currentSessionId: null, homeResetKey: s.homeResetKey + 1 }));
  },
  setActiveTab: (tab) => set({ activeTab: tab }),
  markChatTabReentry: (sessionId) =>
    set((s) => {
      const chatTabReentryTickBySession = new Map(s.chatTabReentryTickBySession);
      const nextTick = (chatTabReentryTickBySession.get(sessionId) ?? 0) + 1;
      chatTabReentryTickBySession.set(sessionId, nextTick);
      return { chatTabReentryTickBySession };
    }),

  setDiffPanelSelectedFile: (sessionId, filePath) =>
    set((s) => {
      const diffPanelSelectedFile = new Map(s.diffPanelSelectedFile);
      if (filePath) {
        diffPanelSelectedFile.set(sessionId, filePath);
      } else {
        diffPanelSelectedFile.delete(sessionId);
      }
      return { diffPanelSelectedFile };
    }),

  setDiffBase: (base) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("cc-diff-base", base);
    }
    set({ diffBase: base });
  },

  setDensity: (density) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("cc-density", density);
    }
    set({ density });
  },
  toggleDensity: () =>
    set((s) => {
      const next: Density = s.density === "compact" ? "standard" : "compact";
      if (typeof window !== "undefined") {
        localStorage.setItem("cc-density", next);
      }
      return { density: next };
    }),
});
