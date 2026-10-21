import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createOwnerDecisionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const changes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:owner-decisions:changes",
    tag: WS_METHODS.ownerDecisionsSubscribe,
  });
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:owner-decisions:list",
      tag: WS_METHODS.ownerDecisionsList,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => changes({ environmentId, input: {} }),
    }),
    choose: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:owner-decisions:choose",
      tag: WS_METHODS.ownerDecisionsChoose,
    }),
  };
}
