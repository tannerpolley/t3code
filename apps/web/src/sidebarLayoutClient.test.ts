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
  readLocalSidebarLayout,
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

describe("saved server layouts", () => {
  function storage() {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    return values;
  }
  it("restores confirmed layouts independently and replaces only the environment that answers", () => {
    storage();
    const send = vi.fn();
    const first = createSidebarLayoutClient(send, vi.fn());
    first.configure(local, true, EMPTY_SIDEBAR_LAYOUT);
    first.configure(remote, true, EMPTY_SIDEBAR_LAYOUT);
    const remoteRecord = {
      ...record,
      layout: {
        ...record.layout,
        sidebarProjectSections: [{ ...record.layout.sidebarProjectSections[0]!, name: "Remote" }],
      },
    };
    first.receive(local, record);
    first.receive(remote, remoteRecord);
    first.dispose();

    const reloaded = createSidebarLayoutClient(send, vi.fn());
    reloaded.configure(local, true, EMPTY_SIDEBAR_LAYOUT);
    reloaded.configure(remote, true, EMPTY_SIDEBAR_LAYOUT);
    expect(reloaded.record(local)).toBeNull();
    expect(reloaded.layouts([local, remote])).toEqual(
      new Map([
        [local, record.layout],
        [remote, remoteRecord.layout],
      ]),
    );
    reloaded.receive(local, { ...record, revision: 1, layout: EMPTY_SIDEBAR_LAYOUT });
    expect(reloaded.layouts([local, remote])).toEqual(
      new Map([
        [local, EMPTY_SIDEBAR_LAYOUT],
        [remote, remoteRecord.layout],
      ]),
    );
    const differentHome = EnvironmentId.make("another-home");
    reloaded.configure(differentHome, true, EMPTY_SIDEBAR_LAYOUT);
    expect(reloaded.layouts([differentHome]).get(differentHome)).toEqual(EMPTY_SIDEBAR_LAYOUT);
    expect(send).not.toHaveBeenCalled();
    reloaded.dispose();
  });
  it("persists a successful flush without a subscription broadcast, excluding queued edits", async () => {
    vi.useFakeTimers();
    storage();
    const confirmed = { ...record, revision: 1, layout: EMPTY_SIDEBAR_LAYOUT };
    const send = vi.fn(async () => confirmed);
    const client = createSidebarLayoutClient(send, vi.fn());
    client.configure(local, true, EMPTY_SIDEBAR_LAYOUT);
    client.receive(local, record);
    client.enqueue(local, { type: "delete", sectionId: "work" });
    expect(readLocalSidebarLayout(local, EMPTY_SIDEBAR_LAYOUT)).toEqual(record.layout);
    await vi.advanceTimersByTimeAsync(SIDEBAR_WRITE_DELAY);
    expect(send).toHaveBeenCalledTimes(1);
    expect(readLocalSidebarLayout(local, record.layout)).toEqual(EMPTY_SIDEBAR_LAYOUT);
    client.dispose();
  });
  it("holds edits until receive and ignores cached sections missing from the live layout", async () => {
    vi.useFakeTimers();
    storage().set("t3code:sidebar-local:" + local, JSON.stringify(record.layout));
    const send = vi.fn(async () => ({ ...record, revision: 2, layout: EMPTY_SIDEBAR_LAYOUT }));
    const client = createSidebarLayoutClient(send, vi.fn());
    client.configure(local, true, EMPTY_SIDEBAR_LAYOUT);
    client.enqueue(local, { type: "rename", sectionId: "work", name: "Stale" });
    client.enqueue(local, { type: "sectionExpanded", sectionId: "work", expanded: false });
    await vi.advanceTimersByTimeAsync(SIDEBAR_WRITE_DELAY);
    expect(send).not.toHaveBeenCalled();
    client.receive(local, { ...record, revision: 1, layout: EMPTY_SIDEBAR_LAYOUT });
    expect(client.layouts([local]).get(local)).toEqual(EMPTY_SIDEBAR_LAYOUT);
    await vi.advanceTimersByTimeAsync(SIDEBAR_WRITE_DELAY);
    expect(send).toHaveBeenCalledTimes(1);
    expect(client.layouts([local]).get(local)).toEqual(EMPTY_SIDEBAR_LAYOUT);
    client.dispose();
  });
  it("never imports a saved server snapshot, including after switching to local mode", () => {
    storage();
    const client = createSidebarLayoutClient(vi.fn(), vi.fn());
    client.configure(local, true, EMPTY_SIDEBAR_LAYOUT);
    client.receive(local, record);
    expect(readLocalSidebarLayout(local, EMPTY_SIDEBAR_LAYOUT, { forImport: true })).toEqual(
      EMPTY_SIDEBAR_LAYOUT,
    );
    client.configure(local, false, EMPTY_SIDEBAR_LAYOUT);
    expect(client.layouts([local]).get(local)).toEqual(record.layout);
    expect(readLocalSidebarLayout(local, EMPTY_SIDEBAR_LAYOUT, { forImport: true })).toEqual(
      EMPTY_SIDEBAR_LAYOUT,
    );
    // A local edit makes this local-mode data eligible for the existing upgrade import.
    client.enqueue(local, { type: "rename", sectionId: "work", name: "Local edit" });
    expect(
      readLocalSidebarLayout(local, EMPTY_SIDEBAR_LAYOUT, { forImport: true })
        .sidebarProjectSections[0]?.name,
    ).toBe("Local edit");
    client.dispose();
  });
});
