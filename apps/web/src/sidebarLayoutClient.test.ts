import { applySidebarLayoutMutation } from "@t3tools/shared/sidebarLayout";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EMPTY_SIDEBAR_LAYOUT,
  EnvironmentId,
  type SidebarLayoutUpdate,
  type SidebarLayoutRecord,
} from "@t3tools/contracts";
import {
  createSidebarLayoutClient,
  SIDEBAR_WRITE_DELAY,
  usesServerSidebar,
} from "./sidebarLayoutClient";
const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const record: SidebarLayoutRecord = {
  revision: 0,
  legacyImportedAt: null,
  legacyImportId: null,
  layout: {
    ...EMPTY_SIDEBAR_LAYOUT,
    sidebarProjectSections: [{ id: "work", name: "Work", projectKeys: ["a"], collapsed: false }],
  },
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("sidebar client writes", () => {
  it("applies N toggles immediately and sends one batch, leaving other environments alone", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (_id: EnvironmentId, _input: SidebarLayoutUpdate) => ({
      ...record,
      revision: 1,
      layout: {
        ...record.layout,
        sidebarProjectSections: [{ ...record.layout.sidebarProjectSections[0]!, collapsed: true }],
      },
    }));
    const client = createSidebarLayoutClient(send, vi.fn());
    client.configure(local, true, EMPTY_SIDEBAR_LAYOUT);
    client.receive(local, record);
    client.configure(remote, true, EMPTY_SIDEBAR_LAYOUT);
    client.receive(remote, record);
    for (let i = 0; i < 21; i++)
      client.enqueue(local, { type: "sectionExpanded", sectionId: "work", expanded: i % 2 !== 0 });
    expect(client.layouts([local]).get(local)?.sidebarProjectSections[0]?.collapsed).toBe(true);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SIDEBAR_WRITE_DELAY);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(local);
    expect(send.mock.calls[0]?.[1].operations).toHaveLength(1);
    client.dispose();
  });
  it("coalesces rapid project toggles while preserving section expansion", async () => {
    vi.useFakeTimers();
    const collapsed: SidebarLayoutRecord = {
      ...record,
      layout: {
        ...record.layout,
        sidebarProjectSections: [{ ...record.layout.sidebarProjectSections[0]!, collapsed: true }],
      },
    };
    const send = vi.fn(async (_id: EnvironmentId, input: SidebarLayoutUpdate) => ({
      ...collapsed,
      revision: 1,
      layout: input.operations.reduce(
        (layout, operation) => applySidebarLayoutMutation(layout, operation)!,
        collapsed.layout,
      ),
    }));
    const client = createSidebarLayoutClient(send, vi.fn());
    client.configure(local, true, EMPTY_SIDEBAR_LAYOUT);
    client.receive(local, collapsed);
    for (let i = 0; i < 30; i++)
      client.enqueue(local, { type: "projectExpanded", projectKeys: ["a"], expanded: i % 2 === 0 });
    expect(client.layouts([local]).get(local)?.projectExpandedById.a).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(send).toHaveBeenCalledTimes(1);
    expect(client.layouts([local]).get(local)?.projectExpandedById.a).toBe(false);
    expect(client.layouts([local]).get(local)?.sidebarProjectSections[0]?.collapsed).toBe(false);
    expect(send.mock.calls[0]?.[1].operations).toHaveLength(2);
    client.dispose();
  });
  it("keeps one request in flight and preserves optimistic changes across broadcasts", async () => {
    vi.useFakeTimers();
    let finish!: (value: SidebarLayoutRecord) => void;
    const send = vi.fn(
      () =>
        new Promise<SidebarLayoutRecord>((resolve) => {
          finish = resolve;
        }),
    );
    const client = createSidebarLayoutClient(send, vi.fn());
    client.configure(local, true, EMPTY_SIDEBAR_LAYOUT);
    client.receive(local, record);
    client.enqueue(local, { type: "sectionExpanded", sectionId: "work", expanded: false });
    await vi.advanceTimersByTimeAsync(250);
    client.enqueue(local, { type: "rename", sectionId: "work", name: "Renamed" });
    client.receive(local, { ...record, revision: 1 });
    await vi.advanceTimersByTimeAsync(250);
    expect(send).toHaveBeenCalledTimes(1);
    expect(client.layouts([local]).get(local)?.sidebarProjectSections[0]?.name).toBe("Renamed");
    finish({ ...record, revision: 1 });
    await vi.advanceTimersByTimeAsync(250);
    expect(send).toHaveBeenCalledTimes(2);
    finish({ ...record, revision: 2 });
    await vi.runAllTimersAsync();
    client.dispose();
  });
  it("missing capability uses local expansion with no RPC or import", async () => {
    vi.useFakeTimers();
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    for (const capability of [undefined, false] as const) {
      const send = vi.fn();
      const client = createSidebarLayoutClient(send, vi.fn());
      client.configure(local, usesServerSidebar(capability), record.layout);
      client.enqueue(local, { type: "sectionExpanded", sectionId: "work", expanded: false });
      expect(client.layouts([local]).get(local)?.sidebarProjectSections[0]?.collapsed).toBe(true);
      client.enqueue(local, {
        type: "move",
        projectKeys: ["new-project"],
        sectionId: "work",
        expanded: true,
      });
      expect(client.layouts([local]).get(local)?.sidebarProjectSections[0]?.projectKeys).toContain(
        "new-project",
      );
      expect(client.layouts([local]).get(local)?.projectExpandedById["new-project"]).toBe(true);
      await vi.runAllTimersAsync();
      expect(send).not.toHaveBeenCalled();
      client.dispose();
    }
  });
});

it("queues edits before the first server record and tolerates a section missing from that record", async () => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const send = vi.fn(async (_id: EnvironmentId, input: SidebarLayoutUpdate) => ({
    ...record,
    revision: record.revision + 1,
    layout: input.operations.reduce(
      (layout, operation) => applySidebarLayoutMutation(layout, operation) ?? layout,
      EMPTY_SIDEBAR_LAYOUT,
    ),
  }));
  const client = createSidebarLayoutClient(send, onError);
  client.configure(local, true, record.layout);
  expect(client.enqueue(local, { type: "rename", sectionId: "work", name: "Stale section" })).toBe(
    true,
  );
  const section = { id: "new", name: "New section", projectKeys: [], collapsed: false };
  expect(client.enqueue(local, { type: "add", section })).toBe(true);
  await vi.advanceTimersByTimeAsync(SIDEBAR_WRITE_DELAY);
  expect(send).not.toHaveBeenCalled();
  expect(client.hasPending(local)).toBe(true);
  expect(() => client.receive(local, { ...record, layout: EMPTY_SIDEBAR_LAYOUT })).not.toThrow();
  expect(client.layouts([local]).get(local)?.sidebarProjectSections).toEqual([section]);
  await vi.advanceTimersByTimeAsync(SIDEBAR_WRITE_DELAY);
  expect(send).toHaveBeenCalledExactlyOnceWith(local, {
    revision: record.revision,
    operations: [
      { type: "rename", sectionId: "work", name: "Stale section" },
      { type: "add", section },
    ],
  });
  expect(client.layouts([local]).get(local)?.sidebarProjectSections).toEqual([section]);
  expect(client.hasPending(local)).toBe(false);
  expect(onError).not.toHaveBeenCalled();
  client.dispose();
});

it("server receives and old flush completions preserve the sole copy of local-mode data", async () => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  const getItem = vi.fn((key: string) => values.get(key) ?? null);
  vi.stubGlobal("localStorage", {
    getItem,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const key = "t3code:sidebar-local:" + local;
  values.set(key, JSON.stringify(record.layout));
  // A display snapshot must be invisible to configuration, local mode and legacy import reads.
  values.set("t3code:sidebar-display:v1", JSON.stringify({ layout: EMPTY_SIDEBAR_LAYOUT }));
  let finish!: (value: SidebarLayoutRecord) => void;
  const client = createSidebarLayoutClient(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    vi.fn(),
  );
  client.configure(local, true, EMPTY_SIDEBAR_LAYOUT);
  client.receive(local, { ...record, layout: EMPTY_SIDEBAR_LAYOUT });
  expect(JSON.parse(values.get(key)!)).toEqual(record.layout);
  client.enqueue(local, { type: "otherExpanded", expanded: false });
  await vi.advanceTimersByTimeAsync(SIDEBAR_WRITE_DELAY);
  client.configure(local, false, EMPTY_SIDEBAR_LAYOUT);
  client.enqueue(local, { type: "rename", sectionId: "work", name: "Local edit" });
  finish({ ...record, revision: 1, layout: EMPTY_SIDEBAR_LAYOUT });
  await vi.runAllTimersAsync();
  const { readLocalSidebarLayout } = await import("./sidebarLayoutClient");
  expect(readLocalSidebarLayout(local, EMPTY_SIDEBAR_LAYOUT).sidebarProjectSections[0]?.name).toBe(
    "Local edit",
  );
  expect(client.layouts([local]).get(local)?.sidebarProjectSections[0]?.name).toBe("Local edit");
  expect(getItem.mock.calls.map(([key]) => key)).not.toContain("t3code:sidebar-display:v1");
  client.dispose();
});
