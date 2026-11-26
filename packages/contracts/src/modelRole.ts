import * as Schema from "effect/Schema";

import { ModelSelection } from "./modelSelection.ts";

export const ModelRole = Schema.Literals([
  "orchestrator",
  "designer",
  "implementor",
  "reviewer",
  "writer",
]);
export type ModelRole = typeof ModelRole.Type;

export const ModelRoleLevel = Schema.Literals(["routine", "complex"]);
export type ModelRoleLevel = typeof ModelRoleLevel.Type;

export const OrchestratorMcpTaskRole = Schema.Literals([
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general",
  ...ModelRole.literals,
]);
export type OrchestratorMcpTaskRole = typeof OrchestratorMcpTaskRole.Type;

// Preserve old fork entries until the owner replaces them with direct selections.
const LegacyModelRole = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  tier: Schema.optionalKey(Schema.Number),
  provider: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.Never),
  instanceId: Schema.optionalKey(Schema.Never),
});
const RoleSelection = Schema.NullOr(Schema.Union([ModelSelection, LegacyModelRole]));
const ModelRoleLevels = Schema.Struct({
  routine: Schema.optionalKey(RoleSelection),
  complex: Schema.optionalKey(RoleSelection),
});

export const ModelRoles = Schema.Struct({
  orchestrator: Schema.optionalKey(ModelRoleLevels),
  designer: Schema.optionalKey(ModelRoleLevels),
  implementor: Schema.optionalKey(ModelRoleLevels),
  reviewer: Schema.optionalKey(ModelRoleLevels),
  writer: Schema.optionalKey(ModelRoleLevels),
});
