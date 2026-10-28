import { NOTEBOOK_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const notebooks = {
  open: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notebook:open",
    tag: NOTEBOOK_METHODS.open,
  }),
  save: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notebook:save",
    tag: NOTEBOOK_METHODS.save,
  }),
  reload: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notebook:reload",
    tag: NOTEBOOK_METHODS.reload,
  }),
  execute: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notebook:execute",
    tag: NOTEBOOK_METHODS.execute,
  }),
  interrupt: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notebook:interrupt",
    tag: NOTEBOOK_METHODS.interrupt,
  }),
  restart: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notebook:restart",
    tag: NOTEBOOK_METHODS.restart,
  }),
  close: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "notebook:close",
    tag: NOTEBOOK_METHODS.close,
  }),
  events: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "notebook:events",
    tag: NOTEBOOK_METHODS.subscribe,
    idleTtlMs: 0,
  }),
};
