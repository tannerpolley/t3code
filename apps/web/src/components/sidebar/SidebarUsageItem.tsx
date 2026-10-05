import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { ServerProvider } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  formatDuration,
} from "@t3tools/shared/usageLimits";
import { Fragment, useMemo, type ReactNode } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { environmentPresentations } from "../../state/presentation";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { limitReadouts, poolWindowSpan } from "../usage/usageLimitModels";
import { readUsagePagePreferences, saveUsagePagePreferences } from "../usage/usagePagePreferences";

const READOUT_DRIVERS = ["claudeAgent", "codex"] as const;

interface ReadoutRow {
  readonly driver: ServerProvider["driver"];
  readonly label: string;
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
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  // The minute clock moves the budget across midnight; no timer of its own.
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const rows = useMemo(() => {
    const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const pools = collectLimitPools(collectLimitAccounts(presentations), now);
    return READOUT_DRIVERS.flatMap((driver): ReadoutRow[] => {
      const pool = pools.find((candidate) => candidate.driver === driver);
      if (!pool) return [];
      // The first window of a kind is the provider's general one; later ones are per model.
      // Claude's five_hour and Codex's paid-plan primary both arrive as the session kind.
      const session = pool.windows.find((window) => window.kind === "session");
      const weekly = pool.windows.find((window) => window.kind === "weekly");
      const all = limitReadouts({
        session: session
          ? {
              usedPercent: session.usedPercent,
              resetsAt: poolWindowSpan(session, now)?.end ?? null,
            }
          : null,
        weekly: weekly
          ? { usedPercent: weekly.usedPercent, span: poolWindowSpan(weekly, now) }
          : null,
        now,
        timeZone,
      });
      const readouts = {
        session: enabled.session ? all.session : null,
        daily: enabled.daily ? all.daily : null,
        weekly: enabled.weekly ? all.weekly : null,
      };
      if (!readouts.session && !readouts.daily && !readouts.weekly) return [];
      return [
        {
          driver: pool.driver,
          label: getDriverOption(pool.driver)?.label ?? String(pool.driver),
          readouts,
        },
      ];
    });
  }, [enabled.daily, enabled.session, enabled.weekly, now, presentations]);
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
 * The footer's Usage button, shown as each provider's quota left (`5h 62%`, `1d 40%`, `7d 75%`)
 * for the readouts that are switched on. Renders `fallback`, the plain button, when none is on
 * and until a limit is known.
 */
export function SidebarUsageItem(props: { readonly fallback: ReactNode }) {
  const session = useClientSettings((settings) => settings.sidebarFiveHourUsage);
  const daily = useClientSettings((settings) => settings.dailyUsageMeter);
  const weekly = useClientSettings((settings) => settings.sidebarWeeklyUsage);
  return session || daily || weekly ? (
    <UsageReadoutItem fallback={props.fallback} enabled={{ session, daily, weekly }} />
  ) : (
    props.fallback
  );
}

function UsageReadoutItem(props: {
  readonly fallback: ReactNode;
  readonly enabled: Parameters<typeof useLimitReadoutRows>[0];
}) {
  const { rows, now } = useLimitReadoutRows(props.enabled);
  const openLimits = useOpenUsageLimits();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  if (rows.length === 0) return props.fallback;
  const resets = (at: number | null) =>
    at === null
      ? ""
      : ` · resets ${formatUpcomingTimestamp(new Date(at).toISOString(), timestampFormat, now)}${
          at > now ? ` · in ${formatDuration(at - now)}` : ""
        }`;
  const summary = rows
    .map((row) => {
      const { session, daily, weekly } = row.readouts;
      const parts = [
        session ? `${session.leftPercent}% of 5 hours left` : null,
        daily
          ? daily.leftPercent === null
            ? "day off"
            : `${daily.leftPercent}% of today's budget left`
          : null,
        weekly ? `${weekly.leftPercent}% of weekly left` : null,
      ];
      return `${row.label} ${parts.filter(Boolean).join(", ")}`;
    })
    .join("; ");
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={`Usage: ${summary}`}
              onClick={openLimits}
              size="sm"
              className="w-auto"
            />
          }
        >
          <span className="flex items-center gap-1.5 text-2xs font-medium tabular-nums">
            {rows.map(({ driver, label, readouts: { session, daily, weekly } }, index) => (
              <Fragment key={driver}>
                {index > 0 ? (
                  <span aria-hidden className="h-3 w-px shrink-0 bg-sidebar-border" />
                ) : null}
                <ProviderInstanceIcon
                  driverKind={driver}
                  displayName={label}
                  className="size-3.5"
                  iconClassName="size-3.5"
                />
                {session ? (
                  <span className={leftClass(session.leftPercent)}>5h {session.leftPercent}%</span>
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
              </Fragment>
            ))}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-80">
          <div className="flex flex-col gap-1.5 tabular-nums">
            {rows.map(({ driver, label, readouts: { session, daily, weekly } }) => (
              <div key={driver} className="flex flex-col gap-0.5">
                <span className="font-medium text-foreground">{label}</span>
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
                        } · resets at midnight`}
                  </span>
                ) : null}
                {weekly ? (
                  <span className="text-muted-foreground">
                    Weekly: {weekly.usedPercent}% used, {weekly.leftPercent}% left
                    {resets(weekly.resetsAt)}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
