import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { ServerProvider } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  formatDuration,
} from "@t3tools/shared/usageLimits";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { environmentPresentations } from "../../state/presentation";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Button } from "../ui/button";
import { isUsageWindowStale } from "@t3tools/shared/forkUsageLimits";
import { useForkUsageRefresh } from "./useForkUsageRefresh";
import { limitReadouts, memberWindowSpan, poolWindowSpan } from "../usage/usageLimitModels";
import { readUsagePagePreferences, saveUsagePagePreferences } from "../usage/usagePagePreferences";

const READOUT_DRIVERS = ["claudeAgent", "codex"] as const;

interface ReadoutRow {
  readonly driver: ServerProvider["driver"];
  readonly label: string;
  readonly stale: readonly string[];
  readonly checkedAt: string;
  readonly scoped: readonly { label: string; left: number | null; resetsAt: string | undefined }[];
  readonly readouts: ReturnType<typeof limitReadouts>;
}

/**
 * Claude's and Codex's five-hour and general weekly limits, pooled across accounts, with today's
 * pace budget, keeping only the readouts that are switched on.
 */
function useLimitReadoutRows(enabled: {
  readonly session: boolean;
  readonly daily: boolean;
  readonly weekly: boolean;
}): { readonly rows: readonly ReadoutRow[]; readonly now: number } {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  // The minute clock moves the budget across midnight; no timer of its own.
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const rows = (() => {
    const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const pools = collectLimitPools(collectLimitAccounts(presentations), now);
    return READOUT_DRIVERS.flatMap((driver): ReadoutRow[] => {
      const pool = pools.find((candidate) => candidate.driver === driver);
      if (!pool) return [];
      // Claude's five_hour and Codex's paid-plan primary both arrive as the session kind.
      const isStale = (window: (typeof pool.windows)[number]) =>
        window.members.some((member) => isUsageWindowStale(member.window, now));
      const sessionWindow = pool.windows.find((window) => window.kind === "session");
      const weeklyWindow = pool.windows.find(
        (window) =>
          window.kind === "weekly" && (driver !== "claudeAgent" || window.id === "seven_day"),
      );
      const session = sessionWindow && !isStale(sessionWindow) ? sessionWindow : undefined;
      const weekly = weeklyWindow && !isStale(weeklyWindow) ? weeklyWindow : undefined;
      const stale = [
        enabled.session && sessionWindow && isStale(sessionWindow) ? "5h" : null,
        (enabled.weekly || enabled.daily) && weeklyWindow && isStale(weeklyWindow) ? "7d" : null,
      ].filter((label): label is string => label !== null);
      const scoped = enabled.weekly
        ? pool.windows
            .filter(
              (window) =>
                window.kind === "weekly" && driver === "claudeAgent" && window.id !== "seven_day",
            )
            .map((window) => ({
              label: window.label,
              left: isStale(window) ? null : window.remainingPercent,
              resetsAt: window.members[0]?.window.resetsAt,
            }))
        : [];
      const all = limitReadouts({
        session: session
          ? {
              usedPercent: session.usedPercent,
              resetsAt: poolWindowSpan(session, now)?.end ?? null,
            }
          : null,
        weekly: weekly
          ? {
              usedPercent: weekly.usedPercent,
              members: weekly.members.map(({ window }) => ({
                usedPercent: window.usedPercent,
                span: memberWindowSpan(window, now),
              })),
            }
          : null,
        now,
        timeZone,
      });
      const readouts = {
        session: enabled.session ? all.session : null,
        daily: enabled.daily ? all.daily : null,
        weekly: enabled.weekly ? all.weekly : null,
      };
      if (
        !readouts.session &&
        !readouts.daily &&
        !readouts.weekly &&
        !stale.length &&
        !scoped.length
      )
        return [];
      return [
        {
          driver: pool.driver,
          stale,
          scoped,
          checkedAt: pool.accounts.map((account) => account.limits.checkedAt).sort()[0]!,
          label: providerClients.get(pool.driver)?.label ?? String(pool.driver),
          readouts,
        },
      ];
    });
  })();
  return { rows, now };
}

/** Opens the Usage page on its Limits view, whichever tab it showed last. */
function useOpenUsageLimits() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  return () => {
    saveUsagePagePreferences({ ...readUsagePagePreferences(), metric: "limits" });
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/usage" });
  };
}

/** Quota left, colored like the desktop status bar: green from 70%, amber from 30%. */
function leftClass(leftPercent: number): string {
  if (leftPercent >= 70) return "text-emerald-500";
  if (leftPercent >= 30) return "text-amber-500";
  return "text-red-500";
}

/**
 * The footer's Usage readouts, each provider's quota left (`5h 62%`, `1d 40%`, `7d 75%`) for the
 * readouts that are switched on. They take their own row above the footer's icon buttons, one
 * button per provider that wraps when the sidebar is too narrow for both. Renders nothing when none
 * is on and until a limit is known; the footer's Usage icon button is separate and always shown.
 */
export function SidebarUsageItem() {
  const session = useClientSettings((settings) => settings.sidebarFiveHourUsage);
  const daily = useClientSettings((settings) => settings.dailyUsageMeter);
  const weekly = useClientSettings((settings) => settings.sidebarWeeklyUsage);
  return session || daily || weekly ? (
    <UsageReadoutItem enabled={{ session, daily, weekly }} />
  ) : null;
}

function UsageReadoutItem(props: { readonly enabled: Parameters<typeof useLimitReadoutRows>[0] }) {
  const { rows, now } = useLimitReadoutRows(props.enabled);
  const { refresh, refreshing, failed } = useForkUsageRefresh();
  const openLimits = useOpenUsageLimits();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  if (rows.length === 0) return null;
  const when = (at: number) =>
    `${formatUpcomingTimestamp(new Date(at).toISOString(), timestampFormat, now)}${
      at > now ? ` · in ${formatDuration(at - now)}` : ""
    }`;
  const resets = (at: number | null) => (at === null ? "" : ` · resets ${when(at)}`);
  return (
    // The parent menu wraps; `order-first w-full` puts this row above its icon buttons.
    <SidebarMenuItem className="order-first flex w-full flex-wrap">
      {rows.map(
        ({ driver, label, stale, scoped, checkedAt, readouts: { session, daily, weekly } }) => {
          const summary = [
            session ? `${session.leftPercent}% of 5 hours left` : null,
            daily
              ? daily.leftPercent === null
                ? "day off"
                : `${daily.leftPercent}% of today's budget left`
              : null,
            weekly ? `${weekly.leftPercent}% of weekly left` : null,
            ...stale.map((kind) => `${kind} usage stale`),
            ...scoped.map(
              (window) =>
                `${window.label}: ${window.left === null ? "stale" : `${window.left}% left`}`,
            ),
          ]
            .filter(Boolean)
            .join(", ");
          return (
            <Popover key={driver}>
              <PopoverTrigger
                render={
                  <SidebarMenuButton
                    aria-label={`${label} usage: ${summary}`}
                    size="sm"
                    className="w-auto"
                  />
                }
              >
                <span className="flex items-center gap-1.5 text-2xs font-medium tabular-nums">
                  <ProviderInstanceIcon
                    driverKind={driver}
                    displayName={label}
                    className="size-3.5"
                    iconClassName="size-3.5"
                  />
                  {stale.map((kind) => (
                    <span key={kind} className="text-sidebar-muted-foreground">
                      {kind} stale
                    </span>
                  ))}
                  {!weekly && !stale.length && scoped.length ? (
                    <span>7d · model limits</span>
                  ) : null}
                  {session ? (
                    <span className={leftClass(session.leftPercent)}>
                      5h {session.leftPercent}%
                    </span>
                  ) : null}
                  {daily ? (
                    daily.leftPercent === null ? (
                      <span className="text-sidebar-muted-foreground">1d off</span>
                    ) : (
                      <span className={leftClass(daily.leftPercent)}>1d {daily.leftPercent}%</span>
                    )
                  ) : null}
                  {weekly ? (
                    <span className={leftClass(weekly.leftPercent)}>7d {weekly.leftPercent}%</span>
                  ) : null}
                </span>
              </PopoverTrigger>
              <PopoverPopup side="top" width="md">
                <div className="flex flex-col gap-0.5 tabular-nums">
                  <span className="font-medium text-foreground">{label}</span>
                  <span className="text-muted-foreground">
                    Last usage reading: {formatUpcomingTimestamp(checkedAt, timestampFormat, now)}
                  </span>
                  {stale.length ? (
                    <span className="text-muted-foreground">
                      {stale.join(" and ")} reset passed · usage unknown until refreshed
                    </span>
                  ) : null}
                  {scoped.map((window) => (
                    <span key={window.label} className="text-muted-foreground">
                      {window.label}:{" "}
                      {window.left === null
                        ? "reset passed · usage unknown"
                        : `${window.left}% left`}
                      {window.left !== null && window.resetsAt
                        ? resets(Date.parse(window.resetsAt))
                        : ""}
                    </span>
                  ))}
                  {session ? (
                    <span className="text-muted-foreground">
                      5 hours: {session.usedPercent}% used, {session.leftPercent}% left
                      {resets(session.resetsAt)}
                    </span>
                  ) : null}
                  {daily ? (
                    <span className="text-muted-foreground">
                      {daily.leftPercent === null
                        ? `Today: day off, no budget · ${daily.usedPercent}% of weekly used`
                        : `Today's budget ${daily.budgetPercent}% of weekly (rolling, Mon–Fri): ${
                            daily.usedPercent
                          }% used, ${
                            daily.leftPercent >= 0
                              ? `${daily.budgetPercent - daily.usedPercent}% left`
                              : `${daily.usedPercent - daily.budgetPercent}% over pace`
                          }`}
                      {daily.nextStepAt === null ? "" : ` · budget grows ${when(daily.nextStepAt)}`}
                      {` · usage restarts when the weekly limit resets ${when(daily.resetsAt)}`}
                    </span>
                  ) : null}
                  {weekly ? (
                    <span className="text-muted-foreground">
                      Weekly: {weekly.usedPercent}% used, {weekly.leftPercent}% left
                      {resets(weekly.resetsAt)}
                    </span>
                  ) : null}
                  {failed ? (
                    <span role="status" className="text-muted-foreground">
                      Refresh failed · showing the last reading
                    </span>
                  ) : null}
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={refreshing}
                      onClick={() => void refresh()}
                    >
                      {refreshing ? "Refreshing…" : "Refresh usage"}
                    </Button>
                    <Button size="xs" variant="ghost" onClick={openLimits}>
                      Open Usage
                    </Button>
                  </div>
                </div>
              </PopoverPopup>
            </Popover>
          );
        },
      )}
    </SidebarMenuItem>
  );
}
