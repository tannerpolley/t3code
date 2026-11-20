import type { OrchestrationV2AppThread } from "./orchestrationV2.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const THREAD_ROLES = [
  "orchestrator",
  "designer",
  "implementor",
  "reviewer",
  "writer",
] as const;
export const ThreadRole = Schema.Literals(THREAD_ROLES);
export type ThreadRole = typeof ThreadRole.Type;
export const THREAD_ROLE_LABELS: Record<ThreadRole, string> = {
  orchestrator: "Orchestrator",
  designer: "Designer",
  writer: "Writer",
  implementor: "Implementor",
  reviewer: "Reviewer",
};

export const MODEL_ROLE_LEVELS = ["complex", "routine"] as const;
export const ModelRoleLevel = Schema.Literals(MODEL_ROLE_LEVELS);
export type ModelRoleLevel = typeof ModelRoleLevel.Type;

const MODEL_ROLE_NAMES = {
  orchestrator: ["orchestrator", "complex"],
  designer: ["designer", "complex"],
  writer: ["writer", "complex"],
  implementor: ["implementor", "complex"],
  reviewer: ["reviewer", "complex"],
  implementation: ["implementor", "complex"],
  research: ["designer", "routine"],
  review: ["reviewer", "complex"],
  design: ["designer", "complex"],
  sprinter: ["implementor", "routine"],
  test: ["reviewer", "routine"],
  general: ["implementor", "routine"],
  "fast-builder": ["implementor", "routine"],
  "thorough-builder": ["implementor", "complex"],
  "bounded-worker": ["implementor", "routine"],
  "quick-claude": ["implementor", "routine"],
  "evidence-gatherer": ["designer", "routine"],
  "strong-reviewer": ["reviewer", "complex"],
  "implementor-fast": ["implementor", "routine"],
  "implementor-thorough": ["implementor", "complex"],
  checker: ["reviewer", "routine"],
  investigator: ["designer", "routine"],
} as const satisfies Record<string, readonly [ThreadRole, ModelRoleLevel]>;

export const THREAD_ROLE_NAMES = Object.keys(MODEL_ROLE_NAMES) as Array<
  keyof typeof MODEL_ROLE_NAMES
>;

export function resolveModelRoleName(value: string) {
  return Object.hasOwn(MODEL_ROLE_NAMES, value)
    ? MODEL_ROLE_NAMES[value as keyof typeof MODEL_ROLE_NAMES]
    : undefined;
}

export function resolveThreadRole(value: string): ThreadRole | undefined {
  return resolveModelRoleName(value)?.[0];
}

// Provider default agents, matched whole before the word patterns below.
const NATIVE_SUBAGENT_DEFAULT_ROLES: ReadonlyMap<string, ThreadRole> = new Map([
  ["manager", "orchestrator"], // Codex's manager agent
  ["default", "implementor"], // Codex's generic worker
  ["general-purpose", "implementor"], // Claude's default Agent type
]);

// The first match wins, so the generic "doer" words come last: "code-reviewer"
// is a Reviewer.
const NATIVE_SUBAGENT_ROLE_PATTERNS: ReadonlyArray<readonly [RegExp, ThreadRole]> = [
  [/review/, "reviewer"],
  [/test|check|verif/, "reviewer"],
  [/explor|research|investigat|search/, "designer"],
  [/writ/, "writer"],
  [/worker|implement|builder|coder/, "implementor"],
];

/**
 * The role a provider-native subagent gets from its provider's agent type
 * (Claude's `subagent_type`, Codex's agent role). Other named types, such as
 * "Plan", are Implementors. Without a type yet, the subagent stays role-less
 * so a later frame naming its type can still set it.
 */
export function nativeSubagentRole(agentType: string | null | undefined): ThreadRole | undefined {
  const type = agentType?.toLowerCase();
  if (!type) return undefined;
  return (
    NATIVE_SUBAGENT_DEFAULT_ROLES.get(type) ??
    NATIVE_SUBAGENT_ROLE_PATTERNS.find(([pattern]) => pattern.test(type))?.[1] ??
    "implementor"
  );
}

interface ThreadRoleDefaultInput {
  readonly role?: ThreadRole | undefined;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

/** A Scratch thread's own folder has no branch and is not a worktree. */
const inWorktree = (thread: ThreadRoleDefaultInput) =>
  Boolean(thread.branch && thread.worktreePath);

/**
 * Top-level threads keep their default unstored so moving into a worktree can
 * make them Implementors (see `worktreeRole`).
 */
export function effectiveThreadRole(
  thread: ThreadRoleDefaultInput & {
    readonly lineage: { readonly relationshipToParent: "fork" | "subagent" | null };
  },
): ThreadRole {
  if (thread.role !== undefined) return thread.role;
  return thread.lineage.relationshipToParent === "subagent" || inWorktree(thread)
    ? "implementor"
    : "orchestrator";
}

/**
 * Only Implementors work in worktrees, so a role-less thread that starts in a
 * worktree or moves into one is stored as an Implementor.
 */
export function worktreeRole(thread: ThreadRoleDefaultInput): { readonly role?: ThreadRole } {
  return thread.role === undefined && inWorktree(thread) ? { role: "implementor" } : {};
}

export const ThreadRoleInput = Schema.Literals(THREAD_ROLE_NAMES).pipe(
  Schema.decodeTo(
    ThreadRole,
    SchemaTransformation.transform({
      decode: (value) => resolveThreadRole(value)!,
      encode: (value) => value,
    }),
  ),
);

/** Stable model-role ids, including saved issue-work references to old names. */
export const ModelRoleId = TrimmedNonEmptyString.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (id) => {
        const slot = resolveModelRoleName(id);
        return slot === undefined ? id : `${slot[0]}-${slot[1]}`;
      },
      encode: (id) => id,
    }),
  ),
);

export const isManagedIssueImplementor = (
  thread: Pick<OrchestrationV2AppThread, "lineage" | "linkedIssue" | "role">,
) =>
  thread.lineage.relationshipToParent === "subagent" &&
  thread.linkedIssue !== undefined &&
  (thread.role ?? "implementor") === "implementor";
