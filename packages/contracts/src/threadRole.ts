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
 * (Claude's `subagent_type`, Codex's agent role). Other types, such as
 * "general-purpose" or "default", stay role-less.
 */
export function nativeSubagentRole(agentType: string | null | undefined): ThreadRole | undefined {
  const type = agentType?.toLowerCase();
  if (!type) return undefined;
  return NATIVE_SUBAGENT_ROLE_PATTERNS.find(([pattern]) => pattern.test(type))?.[1];
}

/**
 * Only Implementors work in worktrees, so a role-less thread that starts in a
 * worktree or moves into one becomes an Implementor. A Scratch thread's own
 * folder has no branch and is not a worktree.
 */
export function worktreeRole(thread: {
  readonly role?: ThreadRole | undefined;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}): { readonly role?: ThreadRole } {
  return thread.role === undefined && thread.branch !== null && thread.worktreePath !== null
    ? { role: "implementor" }
    : {};
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
