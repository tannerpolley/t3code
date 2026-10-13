import { RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  runtimeRequestIsOwnerVisible,
  runtimeRequestOwnerAlertIsSettled,
  type RoutedRequestParent,
} from "./delegatedRequestVisibility.ts";

const request = { routedTo: ThreadId.make("parent") };
const idle: RoutedRequestParent = {
  status: "idle",
  activeRunId: null,
  archivedAt: null,
  deletedAt: null,
};

describe("delegated request visibility", () => {
  it.each(["preparing", "starting", "running", "waiting", "queued"] as const)(
    "hides a request while its parent has %s work",
    (status) => {
      expect(runtimeRequestIsOwnerVisible(request, { ...idle, status })).toBe(false);
    },
  );

  it("keeps a blocking wait hidden even when a newer run owns the status", () => {
    expect(
      runtimeRequestIsOwnerVisible(request, {
        ...idle,
        status: "cancelled",
        activeRunId: RunId.make("blocking-wait"),
      }),
    ).toBe(false);
    expect(runtimeRequestIsOwnerVisible(request, { ...idle, activityRunStatus: "running" })).toBe(
      false,
    );
  });

  it.each(["idle", "completed", "interrupted", "cancelled", "failed", "rolled_back"] as const)(
    "shows the unchanged request when its parent is %s",
    (status) => {
      expect(runtimeRequestIsOwnerVisible(request, { ...idle, status })).toBe(true);
      expect(request.routedTo).toBe("parent");
    },
  );

  it("fails open for an archived, deleted, or missing parent, and ignores other ancestors", () => {
    const now = DateTime.makeUnsafe("2026-10-12T12:00:00Z");
    expect(
      runtimeRequestIsOwnerVisible(request, { ...idle, status: "running", archivedAt: now }),
    ).toBe(true);
    expect(
      runtimeRequestIsOwnerVisible(request, { ...idle, status: "running", deletedAt: now }),
    ).toBe(true);
    expect(runtimeRequestIsOwnerVisible(request, undefined)).toBe(true);
    expect(runtimeRequestIsOwnerVisible(request, null)).toBe(true);
    // Only the immediate parent is supplied. A running root cannot hide an idle child's request.
    expect(runtimeRequestIsOwnerVisible(request, idle)).toBe(true);
  });

  it("shows unrouted requests and never surfaces answered requests", () => {
    expect(runtimeRequestIsOwnerVisible({}, { ...idle, status: "running" })).toBe(true);
    expect(runtimeRequestIsOwnerVisible(null, idle)).toBe(false);
    expect(runtimeRequestIsOwnerVisible(undefined, idle)).toBe(false);
  });
});

describe("owner alert settlement", () => {
  it("delays routed alerts from visibility time, while unrouted alerts remain immediate", () => {
    const request = { routedTo: ThreadId.make("parent") };
    expect(runtimeRequestOwnerAlertIsSettled(request, 1_000, 3_999)).toBe(false);
    expect(runtimeRequestOwnerAlertIsSettled(request, 1_000, 4_000)).toBe(true);
    expect(runtimeRequestOwnerAlertIsSettled({}, 1_000, 1_000)).toBe(true);
  });
});
