import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelection } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const DelegationModelRole = Schema.Literals([
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "writer",
]);
export type DelegationModelRole = typeof DelegationModelRole.Type;

export const OrchestratorMcpTaskRole = Schema.Literals([
  ...DelegationModelRole.literals,
  "general",
]);
export type OrchestratorMcpTaskRole = typeof OrchestratorMcpTaskRole.Type;

export const DelegationComplexity = Schema.Literals(["routine", "complex"]);
export type DelegationComplexity = typeof DelegationComplexity.Type;

export const RoleModel = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  effort: Schema.optionalKey(
    Schema.Union([ProviderOptionSelection, Schema.Literal("orchestrator")]),
  ),
});
export type RoleModel = typeof RoleModel.Type;

const RoleModelLevels = Schema.Record(DelegationComplexity, Schema.optionalKey(RoleModel));
const CompatibleRoleModelLevels = Schema.Union([RoleModel, RoleModelLevels]).pipe(
  Schema.decodeTo(
    Schema.toType(RoleModelLevels),
    SchemaTransformation.transform({
      decode: (value) => ("instanceId" in value ? { routine: value, complex: value } : value),
      encode: (value) => value,
    }),
  ),
);

export const RoleModels = Schema.Record(
  DelegationModelRole,
  Schema.optionalKey(CompatibleRoleModelLevels),
);
