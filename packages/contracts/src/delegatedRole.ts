import * as Schema from "effect/Schema";
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

export const RoleModel = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  effort: Schema.optionalKey(ProviderOptionSelection),
});
export type RoleModel = typeof RoleModel.Type;

export const RoleModels = Schema.Record(DelegationModelRole, Schema.optionalKey(RoleModel));
