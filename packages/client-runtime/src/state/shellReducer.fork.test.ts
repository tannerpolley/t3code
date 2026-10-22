import { runtimeRequestIsOwnerVisible } from "@t3tools/shared/delegatedRequestVisibility";
import { ThreadId, RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { v2Project, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { applyShellStreamEvent, mergeShellSnapshotProjects } from "./shellReducer.ts";

const repositoryIdentity = {
  canonicalKey: "github.com/example/repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/repo.git",
  },
};

describe("applyShellStreamEvent", () => {
  it("enrichment carries identity resolution for repositories and non-repositories", () => {
    for (const identity of [repositoryIdentity, null]) {
      const before = {
        ...v2ShellSnapshot,
        snapshotSequence: 5,
        projects: [{ ...v2Project, repositoryIdentity: null, repositoryIdentityResolved: false }],
      };
      const next = mergeShellSnapshotProjects(
        before,
        {
          ...before,
          snapshotSequence: 4,
          projects: [
            { ...v2Project, repositoryIdentity: identity, repositoryIdentityResolved: true },
          ],
        },
        { resolvedRepositoryIdentityRoots: [v2Project.workspaceRoot] },
      );
      expect(next.projects[0]?.repositoryIdentityResolved).toBe(true);
      expect(next.projects[0]?.repositoryIdentity).toEqual(identity);
    }
  });
  it("keeps a routed request hidden when the child delta arrives before the parent delta", () => {
    const parentId = ThreadId.make("routing-parent");
    const parent = {
      ...v2ThreadShell,
      id: parentId,
      status: "completed" as const,
      activeRunId: null,
      activityRunStatus: null,
    };
    const child = {
      ...v2ThreadShell,
      id: ThreadId.make("routing-child"),
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("routing-request"),
        kind: "user_input" as const,
        createdAt: v2ThreadShell.updatedAt,
        routedTo: parentId,
      },
    };
    const next = applyShellStreamEvent(
      { ...v2ShellSnapshot, threads: [parent] },
      {
        kind: "thread.updated",
        sequence: 1,
        location: "active",
        thread: child,
        routedRequestParent: { ...parent, status: "queued" },
      },
    );
    expect(
      runtimeRequestIsOwnerVisible(
        next.threads.find((t) => t.id === child.id)?.pendingRuntimeRequest,
        next.threads.find((t) => t.id === parentId),
      ),
    ).toBe(false);
    // The same unchanged child can expose its request when the related parent stops or disappears.
    for (const related of [{ ...parent, status: "interrupted" as const }, null]) {
      const released = applyShellStreamEvent(next, {
        kind: "thread.updated",
        sequence: 2,
        location: "active",
        thread: child,
        routedRequestParent: related,
      });
      expect(
        runtimeRequestIsOwnerVisible(
          released.threads.find((t) => t.id === child.id)?.pendingRuntimeRequest,
          released.threads.find((t) => t.id === parentId),
        ),
      ).toBe(true);
    }
  });
});
