import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const THREAD_ROLES = [
  "orchestrator",
  "implementor",
  "reviewer",
  "investigator",
  "checker",
] as const;
export const ThreadRole = Schema.Literals(THREAD_ROLES);
export type ThreadRole = typeof ThreadRole.Type;
export const THREAD_ROLE_LABELS: Record<ThreadRole, string> = {
  orchestrator: "Orchestrator",
  implementor: "Implementor",
  reviewer: "Reviewer",
  investigator: "Investigator",
  checker: "Checker",
};

/** Old agent callers and saved role ids remain readable at the boundary. */
export const LEGACY_THREAD_ROLES = {
  implementation: "implementor",
  research: "investigator",
  review: "reviewer",
  design: "investigator",
  test: "checker",
  general: "implementor",
  "fast-builder": "implementor",
  "thorough-builder": "implementor",
  "bounded-worker": "implementor",
  "quick-claude": "implementor",
  "evidence-gatherer": "investigator",
  "strong-reviewer": "reviewer",
  "implementor-fast": "implementor",
  "implementor-thorough": "implementor",
} as const satisfies Record<string, ThreadRole>;

const isThreadRole = Schema.is(ThreadRole);

export function resolveThreadRole(value: string): ThreadRole | undefined {
  if (isThreadRole(value)) return value;
  return Object.hasOwn(LEGACY_THREAD_ROLES, value)
    ? LEGACY_THREAD_ROLES[value as keyof typeof LEGACY_THREAD_ROLES]
    : undefined;
}

// Provider default agents, matched whole before the word patterns below.
const NATIVE_SUBAGENT_DEFAULT_ROLES: ReadonlyMap<string, ThreadRole> = new Map([
  ["manager", "orchestrator"], // Codex's manager agent
  ["default", "implementor"], // Codex's generic worker
  ["general-purpose", "implementor"], // Claude's default Agent type
]);

// The first match wins, so the generic "doer" words come last: "code-reviewer"
// is a Reviewer and "implementation-checker" a Checker.
const NATIVE_SUBAGENT_ROLE_PATTERNS: ReadonlyArray<readonly [RegExp, ThreadRole]> = [
  [/review/, "reviewer"],
  [/test|check|verif/, "checker"],
  [/explor|research|investigat|search/, "investigator"],
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
 * The role every thread works as. A stored role wins. Without one, a thread
 * working in a worktree or a child agent is an Implementor, and any other
 * thread, one the user starts outside a worktree, is an Orchestrator.
 *
 * Top-level threads keep this default unstored: a thread created in the main
 * checkout may move into a worktree before or after it starts, and becomes an
 * Implementor there (see `worktreeRole`).
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

export const ThreadRoleInput = Schema.Literals([
  ...THREAD_ROLES,
  ...(Object.keys(LEGACY_THREAD_ROLES) as Array<keyof typeof LEGACY_THREAD_ROLES>),
]).pipe(
  Schema.decodeTo(
    ThreadRole,
    SchemaTransformation.transform({
      decode: (value) => resolveThreadRole(value)!,
      encode: (value) => value,
    }),
  ),
);

/** Implementor's profile is independent of its thread role. */
export function modelRoleProfile(id: string) {
  if (resolveThreadRole(id) !== "implementor") return undefined;
  return id === "thorough-builder" || id === "implementor-thorough"
    ? ("thorough" as const)
    : ("fast" as const);
}

/** Stable settings-profile ids, including saved issue-work references to old names. */
export const ModelRoleId = TrimmedNonEmptyString.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (id) => {
        const role = resolveThreadRole(id);
        if (role === undefined) return id;
        const profile = modelRoleProfile(id);
        return profile === undefined ? role : `implementor-${profile}`;
      },
      encode: (id) => id,
    }),
  ),
);
