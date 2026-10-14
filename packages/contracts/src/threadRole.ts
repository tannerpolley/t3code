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
