import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { memo, type ReactNode } from "react";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import {
  formatSidebarUsage,
  sameSidebarUsage,
  selectSidebarUsage,
  SIDEBAR_USAGE_DRIVERS,
  sidebarUsedClass,
  sumSidebarProjectUsage,
  type SidebarUsage,
} from "./SidebarProjectUsage.logic";

let previousProjectUsage: ReadonlyMap<string, SidebarUsage> = new Map();
const projectUsageAtom = Atom.make((get) => {
  const drivers = new Map(
    [...get(environmentServerConfigsAtom)].flatMap(([environmentId, config]) =>
      config.providers.map(
        (provider) => [`${environmentId}:${provider.instanceId}`, provider.driver] as const,
      ),
    ),
  );
  const next = sumSidebarProjectUsage(get(environmentThreadShells.threadShellsAtom), drivers);
  if (
    next.size === previousProjectUsage.size &&
    [...next].every(([key, sum]) => {
      const previous = previousProjectUsage.get(key);
      return previous !== undefined && sameSidebarUsage(previous, sum);
    })
  )
    return previousProjectUsage;
  previousProjectUsage = next;
  return next;
});

// Rows subscribe to their selected sum, so unrelated shell updates never repaint every row.
const selectedUsageAtom = Atom.family((selection: string) => {
  const { keys, remaining } = JSON.parse(selection) as { keys: string[]; remaining: boolean };
  const projectKeys = new Set(keys);
  let previous: SidebarUsage = {};
  return Atom.make((get) => {
    const next = selectSidebarUsage(get(projectUsageAtom), projectKeys, remaining);
    if (sameSidebarUsage(previous, next)) return previous;
    previous = next;
    return next;
  });
});

export function SidebarUsageColumns(props: { readonly children: ReactNode }) {
  return <span className="sidebar-project-usage-columns">{props.children}</span>;
}

export const SidebarProjectUsage = memo(function SidebarProjectUsage(props: {
  readonly projectKeys: readonly string[];
  readonly remaining?: boolean;
}) {
  const usage = useAtomValue(
    selectedUsageAtom(
      JSON.stringify({
        keys: props.projectKeys,
        remaining: props.remaining === true,
      }),
    ),
  );
  return (
    <SidebarUsageColumns>
      {SIDEBAR_USAGE_DRIVERS.map((driver) => (
        <span
          key={driver}
          className={usage[driver] === undefined ? undefined : sidebarUsedClass(usage[driver])}
        >
          <span aria-hidden>{formatSidebarUsage(usage[driver])}</span>
          <span className="sr-only">
            {driver === "codex" ? "Codex" : "Claude"}, estimated weekly usage share:{" "}
            {usage[driver] === undefined ? "unknown" : formatSidebarUsage(usage[driver])}
          </span>
        </span>
      ))}
    </SidebarUsageColumns>
  );
});
