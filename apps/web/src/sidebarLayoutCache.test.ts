import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SECTION_FOLDER_COLORS_CACHE_KEY, SIDEBAR_LAYOUT_CACHE_KEY } from "./sidebarLayoutCache";

const persistence = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));
vi.mock("./localApi", () => ({ ensureLocalApi: () => ({ persistence }) }));

const cached = {
  sidebarProjectSections: [
    {
      id: '["environment-a","work"]',
      name: "Work",
      projectKeys: ["logical-project"],
      collapsed: false,
      color: "blue",
      folderIcons: true,
    },
  ],
  projectExpandedById: { "logical-project": false },
  projectOrder: ["physical-project"],
  sidebarOtherProjectsExpanded: false,
};
let storage: Map<string, string>;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  storage = new Map();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  };
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("localStorage", localStorage);
  persistence.getClientSettings.mockReset().mockResolvedValue(null);
  persistence.setClientSettings.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("hydrates the projected layout before snapshots without making it legacy import data", async () => {
  storage.set(SIDEBAR_LAYOUT_CACHE_KEY, JSON.stringify(cached));
  const { useUiStateStore, legacySidebarLayout, persistState, PERSISTED_STATE_KEY } =
    await import("./uiStateStore");

  expect(useUiStateStore.getInitialState()).toMatchObject(cached);
  expect(legacySidebarLayout.sidebarProjectSections).toEqual([]);
  expect(legacySidebarLayout.projectExpandedById).toEqual({});
  expect(legacySidebarLayout.projectOrder).toEqual([]);
  expect(legacySidebarLayout.sidebarOtherProjectsExpanded).toBe(true);

  persistState(useUiStateStore.getState());
  expect(JSON.parse(storage.get(SIDEBAR_LAYOUT_CACHE_KEY)!)).toEqual(cached);
  expect(JSON.parse(storage.get(PERSISTED_STATE_KEY)!)).toMatchObject({
    sidebarProjectSections: [],
    projectExpandedById: {},
    projectOrder: [],
    sidebarOtherProjectsExpanded: true,
  });
});

it.each(["invalid json", "null", '{"sidebarProjectSections":42}'])(
  "ignores an invalid startup cache: %s",
  async (raw) => {
    storage.set(SIDEBAR_LAYOUT_CACHE_KEY, raw);
    const { useUiStateStore } = await import("./uiStateStore");
    expect(useUiStateStore.getInitialState().sidebarProjectSections).toEqual([]);
  },
);

it.each([null, { ...DEFAULT_CLIENT_SETTINGS, sectionFolderColors: true }])(
  "uses cached folder colors only until client settings hydrate (%s)",
  async (saved) => {
    storage.set(SECTION_FOLDER_COLORS_CACHE_KEY, "false");
    let finishRead!: (settings: ClientSettings | null) => void;
    persistence.getClientSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const { getClientSettings, ensureClientSettingsHydrated, persistClientSettingsPatch } =
      await import("./hooks/useSettings");

    expect(getClientSettings().sectionFolderColors).toBe(false);
    const hydration = ensureClientSettingsHydrated();
    const write = persistClientSettingsPatch({ wordWrap: false });
    expect(persistence.setClientSettings).not.toHaveBeenCalled();
    finishRead(saved);
    await hydration;
    await write;

    expect(getClientSettings().sectionFolderColors).toBe(true);
    expect(storage.get(SECTION_FOLDER_COLORS_CACHE_KEY)).toBe("true");
    expect(persistence.setClientSettings).toHaveBeenCalledExactlyOnceWith({
      ...DEFAULT_CLIENT_SETTINGS,
      ...saved,
      wordWrap: false,
    });
  },
);
