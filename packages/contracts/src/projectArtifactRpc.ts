import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  ProjectArtifact,
  ProjectArtifactScope,
  ProjectArtifactAddInput,
  ProjectArtifactRemoveInput,
  ProjectArtifactUpdateInput,
  ProjectArtifactMoveInput,
  ProjectArtifactRenameSectionInput,
  ProjectArtifactReorderSectionsInput,
  ProjectArtifactList,
  ProjectArtifactError,
} from "./projectArtifact.ts";

export const PROJECT_ARTIFACT_METHODS = {
  list: "projectArtifacts.list",
  add: "projectArtifacts.add",
  remove: "projectArtifacts.remove",
  update: "projectArtifacts.update",
  move: "projectArtifacts.move",
  renameSection: "projectArtifacts.renameSection",
  reorderSections: "projectArtifacts.reorderSections",
  subscribe: "projectArtifacts.subscribe",
} as const;
const error = Schema.Union([ProjectArtifactError, EnvironmentAuthorizationError]);
export const projectArtifactRpcs = [
  Rpc.make(PROJECT_ARTIFACT_METHODS.list, {
    payload: ProjectArtifactScope,
    success: ProjectArtifactList,
    error,
  }),
  Rpc.make(PROJECT_ARTIFACT_METHODS.add, {
    payload: ProjectArtifactAddInput,
    success: ProjectArtifact,
    error,
  }),
  Rpc.make(PROJECT_ARTIFACT_METHODS.remove, {
    payload: ProjectArtifactRemoveInput,
    success: Schema.Void,
    error,
  }),
  Rpc.make(PROJECT_ARTIFACT_METHODS.move, {
    payload: ProjectArtifactMoveInput,
    success: Schema.Void,
    error,
  }),
  Rpc.make(PROJECT_ARTIFACT_METHODS.update, {
    payload: ProjectArtifactUpdateInput,
    success: Schema.Void,
    error,
  }),
  Rpc.make(PROJECT_ARTIFACT_METHODS.renameSection, {
    payload: ProjectArtifactRenameSectionInput,
    success: Schema.Void,
    error,
  }),
  Rpc.make(PROJECT_ARTIFACT_METHODS.reorderSections, {
    payload: ProjectArtifactReorderSectionsInput,
    success: Schema.Void,
    error,
  }),
  Rpc.make(PROJECT_ARTIFACT_METHODS.subscribe, {
    payload: ProjectArtifactScope,
    success: ProjectArtifactList,
    error,
    stream: true,
  }),
] as const;
