import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type SidebarLayout,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import {
  createOutdatedServerDescriptionCommand,
  createOutdatedServerUpdateCommand,
} from "@t3tools/client-runtime/state/outdatedServerUpdate";
import { createEnvironmentServerConfigsAtom } from "@t3tools/client-runtime/state/shell";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSession, sessionHasScope } from "./session";

export const serverEnvironment = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: environmentSession.initialConfigValueAtom,
  usageLimitSources: true,
  usageLimitsCommand: true,
  providerCatalogsOnDemand: true,
  providerCatalogDigests: true,
  providerStatusDeltas: true,
  omitRefreshedProviders: true,
});
export const describeOutdatedServer = createOutdatedServerDescriptionCommand(connectionAtomRuntime);
export const updateOutdatedServer = createOutdatedServerUpdateCommand(connectionAtomRuntime);
export const environmentServerConfigsAtom = createEnvironmentServerConfigsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

export const projectSidebarLayoutsAtom = Atom.make((get) => {
  const layouts = new Map<EnvironmentId, SidebarLayout>();
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    if (
      !config.sidebarProjectPlacement ||
      !sessionHasScope(
        get(environmentSession.sessionStateAtom(environmentId)),
        AuthOrchestrationReadScope,
      )
    )
      continue;
    const record = AsyncResult.getOrElse(
      get(serverEnvironment.sidebarLayout({ environmentId, input: {} })),
      () => null,
    );
    if (record) layouts.set(environmentId, record.layout);
  }
  return layouts;
});
