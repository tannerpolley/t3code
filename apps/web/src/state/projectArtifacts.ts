import { PROJECT_ARTIFACT_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const projectArtifacts = {
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "project-artifacts:list",
    tag: PROJECT_ARTIFACT_METHODS.list,
  }),
  live: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "project-artifacts:live",
    tag: PROJECT_ARTIFACT_METHODS.subscribe,
    idleTtlMs: 0,
  }),
  add: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-artifacts:add",
    tag: PROJECT_ARTIFACT_METHODS.add,
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-artifacts:remove",
    tag: PROJECT_ARTIFACT_METHODS.remove,
  }),
  move: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-artifacts:move",
    tag: PROJECT_ARTIFACT_METHODS.move,
  }),
  renameSection: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-artifacts:rename-section",
    tag: PROJECT_ARTIFACT_METHODS.renameSection,
  }),
  reorderSections: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-artifacts:reorder-sections",
    tag: PROJECT_ARTIFACT_METHODS.reorderSections,
  }),
};
