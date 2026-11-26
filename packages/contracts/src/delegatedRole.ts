import * as Schema from "effect/Schema";

export const OrchestratorMcpTaskRole = Schema.Literals([
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general",
  "writer",
]);
export type OrchestratorMcpTaskRole = typeof OrchestratorMcpTaskRole.Type;
