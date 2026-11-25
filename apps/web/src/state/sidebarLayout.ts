import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type SidebarLayoutMutation,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useGT } from "gt-react";

import { toastManager } from "../components/ui/toast";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
import { serverEnvironment } from "./server";
import { useEnvironmentsWithScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

const layoutStates = environmentAtomList("sidebar-layout", (environmentId) =>
  Atom.make((get) => ({
    environmentId,
    record: AsyncResult.getOrElse(
      get(serverEnvironment.sidebarLayout({ environmentId, input: {} })),
      () => null,
    ),
    writable: get(serverEnvironment.updateSidebarLayout.permissionAtom(environmentId)),
  })),
);

export function useSidebarLayout(environments: readonly EnvironmentId[]) {
  const readable = useEnvironmentsWithScope(
    environments.map((environmentId) => ({ environmentId })),
    AuthOrchestrationReadScope,
  );
  const states = useAtomValue(
    layoutStates(environmentIdsKey(environments.filter((id) => readable.has(id)))),
  );
  const byEnvironment = new Map(states.map((state) => [state.environmentId, state]));
  const update = useAtomCommand(serverEnvironment.updateSidebarLayout, { reportFailure: false });
  const gt = useGT();
  const change = async (environmentId: EnvironmentId, mutation: SidebarLayoutMutation) => {
    const state = byEnvironment.get(environmentId);
    if (!state?.record || !state.writable) return false;
    const result = await update({
      environmentId,
      input: { revision: state.record.revision, mutation },
    });
    if (result._tag === "Success") return true;
    toastManager.add({ type: "error", title: gt("Could not save sidebar layout. Try again.") });
    return false;
  };
  return { byEnvironment, change };
}
