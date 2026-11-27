import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";

export const projectArtifacts = {
  list: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:project-artifacts",
    tag: WS_METHODS.projectArtifactsSubscribe,
  }),
  add: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-artifacts:add",
    tag: WS_METHODS.projectArtifactsAdd,
  }),
  update: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-artifacts:update",
    tag: WS_METHODS.projectArtifactsUpdate,
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-artifacts:remove",
    tag: WS_METHODS.projectArtifactsRemove,
  }),
};

export function useSaveProjectArtifact(environmentId: EnvironmentId | null) {
  const gt = useGT();
  const allowed = useAtomValue(projectArtifacts.add.permissionAtom(environmentId));
  const save = useAtomCommand(projectArtifacts.add);
  return environmentId === null || !allowed
    ? null
    : async (projectId: ProjectId, path: string) => {
        const result = await save({ environmentId, input: { projectId, path } });
        if (result._tag === "Success") {
          toastManager.add({ type: "success", title: gt("Artifact saved") });
        }
      };
}
