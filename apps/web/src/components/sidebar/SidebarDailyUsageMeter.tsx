import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { ServerProvider } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  formatDuration,
} from "@t3tools/shared/usageLimits";
import { useMemo } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { barColor } from "../usage/UsageLimits";
import { dailyPaceBudget, poolWindowSpan } from "../usage/usageLimitModels";
import { readUsagePagePreferences, saveUsagePagePreferences } from "../usage/usagePagePreferences";

const METER_DRIVERS = ["claudeAgent", "codex"] as const;
/** Within this many points of today's budget the bar turns amber. */
const NEAR_BUDGET_POINTS = 5;

interface MeterRow {
  readonly driver: ServerProvider["driver"];
  readonly label: string;
  readonly usedPercent: number;
  readonly budgetPercent: number;
  readonly isWorkday: boolean;
  readonly resetsAt: number;
}

/** Sidebar footer rows pacing each workday at 20% of Claude's and Codex's weekly limits. */
export function SidebarDailyUsageMeter() {
  const enabled = useClientSettings((settings) => settings.dailyUsageMeter);
  return enabled ? <DailyUsageMeterRows /> : null;
}

function DailyUsageMeterRows() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  // The minute clock moves the budget across midnight; no timer of its own.
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const rows = useMemo(() => {
    const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const pools = collectLimitPools(collectLimitAccounts(presentations), now);
    return METER_DRIVERS.flatMap((driver): MeterRow[] => {
      const pool = pools.find((candidate) => candidate.driver === driver);
      // The first weekly window is the provider's general one; later ones are per model.
      const weekly = pool?.windows.find((window) => window.kind === "weekly");
      const span = weekly ? poolWindowSpan(weekly, now) : null;
      if (!pool || !weekly || !span) return [];
      const pace = dailyPaceBudget({ windowStart: span.start, windowEnd: span.end, now, timeZone });
      return [
        {
          driver: pool.driver,
          label: getDriverOption(pool.driver)?.label ?? String(pool.driver),
          usedPercent: weekly.usedPercent,
          budgetPercent: Math.round(pace.budgetPercent),
          isWorkday: pace.isWorkday,
          resetsAt: span.end,
        },
      ];
    });
  }, [now, presentations]);
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col pb-1">
      {rows.map((row) => (
        <MeterRowButton key={row.driver} row={row} now={now} />
      ))}
    </div>
  );
}

function MeterRowButton({ row, now }: { readonly row: MeterRow; readonly now: number }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const left = row.budgetPercent - row.usedPercent;
  const fillColor =
    left < 0
      ? "var(--destructive)"
      : left <= NEAR_BUDGET_POINTS
        ? "var(--warning)"
        : barColor(row.driver);
  const fill = row.budgetPercent > 0 ? Math.min(1, row.usedPercent / row.budgetPercent) : 1;
  const summary = row.isWorkday
    ? `${row.label}: ${row.usedPercent} of ${row.budgetPercent}% budget used`
    : `${row.label}: day off, ${row.usedPercent}% of weekly used`;
  const openLimits = () => {
    // The Usage page opens on whichever tab it last showed.
    saveUsagePagePreferences({ ...readUsagePagePreferences(), metric: "limits" });
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/usage" });
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={summary}
            onClick={openLimits}
            className="flex h-4.5 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-[11px] text-sidebar-muted-foreground tabular-nums outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <ProviderInstanceIcon
          driverKind={row.driver}
          displayName={row.label}
          className="size-4"
          iconClassName="size-3 text-foreground/80"
        />
        {row.isWorkday ? (
          <>
            <span className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${fill * 100}%`, backgroundColor: fillColor }}
              />
            </span>
            <span className={cn("shrink-0", left < 0 && "text-destructive")}>
              {row.usedPercent} / {row.budgetPercent}%
            </span>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-left">Day off</span>
            <span className="shrink-0">{row.usedPercent}%</span>
          </>
        )}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72 text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-foreground">{row.label}</span>
          <span className="text-muted-foreground">Used {row.usedPercent}% of weekly</span>
          {row.isWorkday ? (
            <>
              <span className="text-muted-foreground">
                Today's budget {row.budgetPercent}% (rolling, Mon–Fri)
              </span>
              <span className="text-foreground">
                {left >= 0 ? `${left}% left today` : `${-left}% over pace`}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Day off: no budget today</span>
          )}
          <span className="text-muted-foreground">
            Week resets{" "}
            {formatUpcomingTimestamp(new Date(row.resetsAt).toISOString(), timestampFormat, now)}
            {row.resetsAt > now ? ` · in ${formatDuration(row.resetsAt - now)}` : ""}
          </span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
