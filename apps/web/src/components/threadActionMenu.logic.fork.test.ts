import {
  isRepositoryOrchestratorEligible,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

describe("repository orchestrator eligibility", () => {
  const thread = {
    id: ThreadId.make("lead"),
    projectId: ProjectId.make("project"),
    branch: "main",
    worktreePath: null,
    archivedAt: null,
    deletedAt: null,
    lineage: {
      parentThreadId: null,
      rootThreadId: ThreadId.make("lead"),
      relationshipToParent: null,
    },
  } as const;

  const repository = { host: "github.com", repository: "owner/repo", projectId: thread.projectId };

  it("allows both supported drivers and an explicit Orchestrator role", () => {
    expect(
      isRepositoryOrchestratorEligible(thread, ProviderDriverKind.make("codex"), repository),
    ).toBe(true);
    expect(
      isRepositoryOrchestratorEligible(
        { ...thread, role: "orchestrator" },
        ProviderDriverKind.make("claudeAgent"),
        repository,
      ),
    ).toBe(true);
  });

  it("excludes worktrees, other roles, and unavailable or unsupported drivers", () => {
    expect(
      isRepositoryOrchestratorEligible(
        { ...thread, worktreePath: "/worktree", role: "orchestrator" },
        ProviderDriverKind.make("codex"),
        repository,
      ),
    ).toBe(false);
    expect(
      isRepositoryOrchestratorEligible(
        { ...thread, role: "implementor" },
        ProviderDriverKind.make("codex"),
        repository,
      ),
    ).toBe(false);
    expect(
      isRepositoryOrchestratorEligible(thread, ProviderDriverKind.make("cursor"), repository),
    ).toBe(false);
    expect(isRepositoryOrchestratorEligible(thread, undefined, repository)).toBe(false);
    expect(
      isRepositoryOrchestratorEligible(
        { ...thread, lineage: { ...thread.lineage, parentThreadId: ThreadId.make("parent") } },
        ProviderDriverKind.make("codex"),
        repository,
      ),
    ).toBe(false);
  });
});
