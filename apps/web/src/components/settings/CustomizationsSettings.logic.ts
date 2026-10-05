import type { ServerProvider, ServerProviderPlugin } from "@t3tools/contracts";

export interface ProviderPluginGroup {
  readonly key: string;
  readonly label: string;
  /** Plugins that offer at least one skill here, by name. */
  readonly available: ReadonlyArray<ServerProviderPlugin>;
  /** Plugins with no skills or that need the provider's desktop app, by name. */
  readonly unavailable: ReadonlyArray<ServerProviderPlugin>;
  readonly skillCount: number;
}

const byName = (left: ServerProviderPlugin, right: ServerProviderPlugin) =>
  left.name.localeCompare(right.name) ||
  (left.marketplace ?? "").localeCompare(right.marketplace ?? "");

/**
 * Each enabled provider's plugins as one group, groups by label. Null until a provider reports a
 * plugin list at all, so an older server is not mistaken for "no plugins".
 */
export function groupProviderPlugins(
  providers: ReadonlyArray<
    Pick<ServerProvider, "enabled" | "plugins" | "instanceId" | "displayName" | "driver">
  >,
): ReadonlyArray<ProviderPluginGroup> | null {
  const reporting = providers.filter(
    (provider) => provider.enabled && provider.plugins !== undefined,
  );
  if (reporting.length === 0) return null;
  return reporting
    .flatMap((provider) => {
      const plugins = (provider.plugins ?? []).toSorted(byName);
      if (plugins.length === 0) return [];
      const isUnavailable = (plugin: ServerProviderPlugin) =>
        plugin.skillCount === 0 || plugin.requiresDesktopApp === true;
      const available = plugins.filter((plugin) => !isUnavailable(plugin));
      return [
        {
          key: provider.instanceId,
          label: provider.displayName ?? provider.driver,
          available,
          unavailable: plugins.filter(isUnavailable),
          skillCount: available.reduce((total, plugin) => total + plugin.skillCount, 0),
        },
      ];
    })
    .toSorted((left, right) => left.label.localeCompare(right.label));
}
