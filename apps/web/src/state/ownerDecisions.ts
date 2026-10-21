import { useAtomValue } from "@effect/atom-react";
import { createOwnerDecisionAtoms } from "@t3tools/client-runtime/state/ownerDecisions";
import type { EnvironmentId, OwnerDecision } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";
import { formatEnvironmentQueryError } from "./query";

export const ownerDecisions = createOwnerDecisionAtoms(connectionAtomRuntime);
const gathered = Atom.family((key: string) =>
  Atom.make((get) => {
    const records: Array<{ environmentId: EnvironmentId; decision: OwnerDecision }> = [];
    const errors: Array<{ environmentId: EnvironmentId; message: string }> = [];
    let waiting = false;
    for (const environmentId of JSON.parse(key) as EnvironmentId[]) {
      const result = get(ownerDecisions.list({ environmentId, input: {} }));
      waiting ||= result.waiting;
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value !== null) records.push(...value.map((decision) => ({ environmentId, decision })));
      if (result._tag === "Failure")
        errors.push({ environmentId, message: formatEnvironmentQueryError(result.cause) });
    }
    return { records, errors, waiting };
  }),
);
export function useOwnerDecisions() {
  const { environments } = useEnvironments();
  const ids = environments
    .filter(
      (environment) => environment.serverConfig?.environment.capabilities.ownerDecisions === true,
    )
    .map((environment) => environment.environmentId)
    .sort();
  const view = useAtomValue(gathered(JSON.stringify(ids)));
  const unavailable = environments.filter(
    (environment) => environment.connection.phase !== "connected",
  );
  return {
    ...view,
    unavailable,
    labels: new Map(
      environments.map((environment) => [environment.environmentId, environment.label]),
    ),
  };
}
