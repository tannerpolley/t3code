import {
  PROJECT_ROLE_SKILLS_MAX_COUNT,
  PROJECT_SKILL_ID_MAX_LENGTH,
  PROJECT_SKILL_ID_PATTERN,
  type IssueRef,
  type OrchestrationV2AppThread,
  type ProjectId,
  type T3ProjectFile,
  type ThreadRole,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as IssueService from "../issue/IssueService.ts";
import type * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";

const declaration = /^Skills:[ \t]+(.+)$/;
const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function* declaredSkills(text: string) {
  let openFence: string | undefined;
  let inComment = false;
  for (const line of text.split(/\r?\n/)) {
    const marker = fence.exec(line);
    if (openFence !== undefined) {
      if (marker !== null && marker[1]!.startsWith(openFence) && marker[2]!.trim() === "") {
        openFence = undefined;
      }
      continue;
    }
    if (inComment || line.trimStart().startsWith("<!--")) {
      inComment = !line.includes("-->");
      continue;
    }
    if (marker !== null && (marker[1]![0] === "~" || !marker[2]!.includes("`"))) {
      openFence = marker[1];
      continue;
    }
    const match = declaration.exec(line);
    if (match === null) continue;
    const ids = match[1]!.split(",").map((id) => id.trim());
    if (
      ids.every(
        (id) => id.length <= PROJECT_SKILL_ID_MAX_LENGTH && PROJECT_SKILL_ID_PATTERN.test(id),
      )
    ) {
      yield* ids;
    }
  }
}

export function delegatedSkillRole(
  thread: Pick<OrchestrationV2AppThread, "delegatedFrom" | "lineage" | "role">,
) {
  if (thread.delegatedFrom != null) {
    return thread.delegatedFrom.role === undefined ? undefined : thread.role;
  }
  return thread.lineage.relationshipToParent === "subagent" ? thread.role : undefined;
}

export function selectRoleSkills(
  role: ThreadRole,
  roleSkills: NonNullable<T3ProjectFile["roleSkills"]>,
  issueBody: string,
  brief: string,
) {
  const requests = new Map<string, "role" | "issue" | "brief">();
  for (const [source, ids] of [
    ["role", roleSkills[role] ?? []],
    ["issue", declaredSkills(issueBody)],
    ["brief", declaredSkills(brief)],
  ] as const) {
    const initialCount = requests.size;
    for (const id of ids) {
      if (!requests.has(id)) requests.set(id, source);
      if (requests.size - initialCount === PROJECT_ROLE_SKILLS_MAX_COUNT) break;
    }
  }
  return Array.from(requests, ([id, source]) => ({ id, source }));
}

export const readRoleSkillIssue = Effect.fn("roleSkills.readIssue")(function* (
  issues: IssueService.IssueService["Service"] | undefined,
  thread: { readonly projectId: ProjectId; readonly issues?: ReadonlyArray<IssueRef> },
) {
  const links = thread.issues?.filter((link) => link.projectId === thread.projectId);
  if (!links?.length) return { body: "", issueLookupFailed: false };
  if (issues === undefined) return { body: "", issueLookupFailed: true };
  const scope = yield* Effect.result(issues.projectScope(thread.projectId));
  if (Result.isFailure(scope)) return { body: "", issueLookupFailed: true } as const;
  const link = links.find(
    (link) =>
      link.tracker === scope.success.tracker &&
      link.host === scope.success.host &&
      link.scope.toLowerCase() === scope.success.scope.toLowerCase(),
  );
  if (link === undefined) return { body: "", issueLookupFailed: false };
  const detail = yield* Effect.result(issues.detail({ ...scope.success, key: link.key }));
  return Result.isSuccess(detail)
    ? { body: detail.success.body ?? "", issueLookupFailed: false }
    : ({ body: "", issueLookupFailed: true } as const);
});

export const resolveRoleSkillSelection = Effect.fn("roleSkills.resolveSelection")(
  function* (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly projectFiles: T3ProjectFileLoader.T3ProjectFileLoader["Service"];
    readonly issues: IssueService.IssueService["Service"] | undefined;
    readonly issueRefs: ReadonlyArray<IssueRef>;
    readonly role: ThreadRole;
    readonly brief: string;
  }) {
    const file = yield* input.projectFiles.load(input.workspaceRoot);
    const roleSkills = Option.getOrUndefined(file)?.roleSkills;
    if (roleSkills === undefined) return null;
    const issue = yield* readRoleSkillIssue(input.issues, {
      projectId: input.projectId,
      issues: input.issueRefs,
    });
    return {
      requests: selectRoleSkills(input.role, roleSkills, issue.body, input.brief),
      ...(issue.issueLookupFailed ? { issueLookupFailed: true as const } : {}),
    };
  },
);
