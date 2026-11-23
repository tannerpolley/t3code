import {
  IssueOperationError,
  IssueTrackerKind,
  ProjectId,
  resolveModelRoleName,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IssueService from "../issue/IssueService.ts";
import { readRoleSkillIssue, selectRoleSkills } from "./roleSkills.ts";

it.each([
  ["orchestrator", undefined],
  ["design", "cse:design"],
  ["investigator", "cse:design"],
  ["implementor", "cse:build"],
  ["sprinter", "cse:build"],
  ["review", "cse:review"],
  ["checker", "cse:review"],
  ["writer", "cse:write"],
] as const)("selects the canonical role's default for %s", (name, id) => {
  expect(
    selectRoleSkills(
      resolveModelRoleName(name)![0],
      {
        designer: ["cse:design"],
        implementor: ["cse:build"],
        reviewer: ["cse:review"],
        writer: ["cse:write"],
      },
      "",
      "",
    ),
  ).toEqual(id === undefined ? [] : [{ id, source: "role" }]);
});

it("adds explicit issue and brief skills once, in source order", () => {
  expect(
    selectRoleSkills(
      "implementor",
      { implementor: ["cse:build"] },
      [
        "Skills: cse:build, cse:plot",
        "I also mentioned cse:review.",
        "~~~md",
        "Skills: cse:review",
        "~~~",
        "> Skills: cse:review",
        "<!-- template example",
        "Skills: cse:review",
        "-->",
        "    Skills: cse:review",
        "Skills: cse:review, ../../SKILL.md",
      ].join("\n"),
      "Skills: cse:plot, cse:build, cse:latex",
    ),
  ).toEqual([
    { id: "cse:build", source: "role" },
    { id: "cse:plot", source: "issue" },
    { id: "cse:latex", source: "brief" },
  ]);
});

it.effect(
  "uses only stored links in the project's issue scope and keeps the brief usable on lookup failure",
  () =>
    Effect.gen(function* () {
      const scope = {
        projectId: ProjectId.make("project"),
        tracker: IssueTrackerKind.make("github"),
        host: "github.com",
        scope: "someone/cse-project",
      };
      const detail = vi.fn<IssueService.IssueService["Service"]["detail"]>((input) =>
        input.key === "42"
          ? Effect.succeed({ body: "Skills: cse:plot" } as Effect.Success<
              ReturnType<IssueService.IssueService["Service"]["detail"]>
            >)
          : Effect.fail(new IssueOperationError({ operation: "detail", detail: "unavailable" })),
      );
      const link = {
        ...scope,
        key: "42",
        displayKey: "#42",
        url: "https://github.com/someone/cse-project/issues/42",
        title: "Scientific task",
        source: "agent" as const,
        linkedAt: "2026-11-20T00:00:00.000Z",
      };
      const issues = yield* Effect.service(IssueService.IssueService).pipe(
        Effect.provide(
          Layer.mock(IssueService.IssueService)({
            projectScope: () => Effect.succeed(scope),
            detail,
          }),
        ),
      );
      expect(
        yield* readRoleSkillIssue(issues, {
          ...scope,
          issues: [{ ...link, scope: "someone/else" }],
        }),
      ).toEqual({
        body: "",
        issueLookupFailed: false,
      });
      expect(detail).not.toHaveBeenCalled();
      expect((yield* readRoleSkillIssue(issues, { ...scope, issues: [link] })).body).toBe(
        "Skills: cse:plot",
      );
      const failed = yield* readRoleSkillIssue(issues, {
        ...scope,
        issues: [{ ...link, key: "43" }],
      });
      expect(failed.issueLookupFailed).toBe(true);
      expect(
        selectRoleSkills(
          "reviewer",
          { reviewer: ["cse:review"] },
          failed.body,
          "Skills: cse:latex",
        ),
      ).toEqual([
        { id: "cse:review", source: "role" },
        { id: "cse:latex", source: "brief" },
      ]);
    }),
);
