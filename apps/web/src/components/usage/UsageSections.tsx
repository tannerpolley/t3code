import type { ProviderDriverKind } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The building blocks every Usage metric view shares, so Cost, Tokens, and
 * Limits read as one page: headline and provider rows beside a chart, a
 * Totals strip, and a Breakdown table.
 */

type ProviderIdentity = { readonly driverKind: ProviderDriverKind; readonly label: string };

/** Brand mark for the harness a row belongs to. */
export function ProviderMark({
  provider,
  className,
}: {
  readonly provider: ProviderIdentity;
  readonly className: string;
}) {
  return (
    <ProviderInstanceIcon
      driverKind={provider.driverKind}
      displayName={provider.label}
      iconClassName={className}
    />
  );
}

/** A mode switch in the page's segmented style. */
export function SegmentedToggle<T extends string>({
  ariaLabel,
  value,
  options,
  onValueChange,
}: {
  readonly ariaLabel: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onValueChange: (value: T) => void;
}) {
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      variant="segmented"
      value={[value]}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next[0]);
        if (option) onValueChange(option.value);
      }}
    >
      {options.map((option) => (
        <Toggle key={option.value} value={option.value}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

/** Headline and provider rows on the left, the chart with its heading on the right. */
export function UsageOverview({
  headline,
  detail,
  rows,
  chartHeading,
  chartActions,
  chart,
}: {
  readonly headline: ReactNode;
  readonly detail: ReactNode;
  readonly rows: ReactNode;
  readonly chartHeading: ReactNode;
  readonly chartActions?: ReactNode;
  readonly chart: ReactNode;
}) {
  const heading = <h2 className="text-sm font-medium text-foreground">{chartHeading}</h2>;
  return (
    <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        <div className="flex flex-col gap-1">
          <span className="text-4xl font-semibold text-foreground tabular-nums">{headline}</span>
          <span className="text-xs text-muted-foreground">{detail}</span>
        </div>
        {rows}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        {chartActions ? (
          <div className="flex items-center justify-between gap-3">
            {heading}
            {chartActions}
          </div>
        ) : (
          heading
        )}
        {chart}
      </div>
    </section>
  );
}

/** One provider under the headline: dot, mark, name and count, value, and a detail line. */
export function UsageProviderRow({
  color,
  provider,
  label,
  count,
  value,
  detail,
  tooltip,
}: {
  readonly color: string;
  readonly provider: ProviderIdentity;
  readonly label: string;
  readonly count: string;
  readonly value: string;
  readonly detail: string;
  /** Hover content; the row becomes focusable so keyboard users reach it too. */
  readonly tooltip?: ReactNode;
}) {
  const content = (
    <>
      <div className="flex items-baseline justify-between gap-4">
        <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
          <ProviderMark provider={provider} className="size-4" />
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate">{label}</span>
            <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground tabular-nums">
              {count}
            </span>
          </span>
        </span>
        <span className="shrink-0 text-sm font-medium text-foreground tabular-nums">{value}</span>
      </div>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </>
  );
  if (tooltip === undefined) return <div className="flex flex-col gap-1">{content}</div>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            className="flex cursor-default flex-col gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipPopup side="right" className="max-w-80 text-xs">
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}

export function UsageTotals({ children }: { readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-foreground">Totals</h2>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">{children}</div>
    </section>
  );
}

export function Metric({
  label,
  value,
  children,
}: {
  readonly label: string;
  readonly value: string;
  /** Controls that act on the figure, under it. */
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-medium text-foreground tabular-nums">{value}</span>
      {children}
    </div>
  );
}

export type UsageBreakdownMode = "model" | "time";

export function UsageBreakdown({
  value,
  onValueChange,
  timeLabel,
  children,
}: {
  readonly value: UsageBreakdownMode;
  readonly onValueChange: (value: UsageBreakdownMode) => void;
  readonly timeLabel: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
        <SegmentedToggle
          ariaLabel="Usage breakdown"
          value={value}
          options={[
            { value: "model", label: "Model" },
            { value: "time", label: timeLabel },
          ]}
          onValueChange={onValueChange}
        />
      </div>
      {children}
    </section>
  );
}

/** A breakdown table: the first column is the row's label, the rest are right-aligned values. */
export function BreakdownTable({
  columns,
  empty,
  emptyText = "No activity in this window.",
  children,
}: {
  readonly columns: readonly {
    readonly key: string;
    readonly label: ReactNode;
    readonly width: string;
  }[];
  readonly empty: boolean;
  readonly emptyText?: string;
  readonly children: ReactNode;
}) {
  return (
    <table className="w-full table-fixed text-sm">
      <colgroup>
        {columns.map((column) => (
          <col key={column.key} style={{ width: column.width }} />
        ))}
      </colgroup>
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          {columns.map((column, index) => (
            <th key={column.key} className={cn("py-2 font-normal", index > 0 && "text-right")}>
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {empty ? (
          <tr>
            <td colSpan={columns.length} className="py-6 text-center text-muted-foreground">
              {emptyText}
            </td>
          </tr>
        ) : (
          children
        )}
      </tbody>
    </table>
  );
}

export function BreakdownRow({
  label,
  children,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <tr className="border-b border-border/50 transition-colors hover:bg-muted/50">
      <td className="py-2 text-foreground">{label}</td>
      {children}
    </tr>
  );
}

/** A model name with its provider's mark, for the first column of a model table. */
export function ModelLabel({
  provider,
  model,
}: {
  readonly provider: ProviderIdentity;
  readonly model: ReactNode;
}) {
  return (
    <span className="flex items-center gap-2">
      <ProviderMark provider={provider} className="size-3.5" />
      {model}
    </span>
  );
}

export function ValueCell({
  muted = false,
  children,
}: {
  readonly muted?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <td
      className={cn(
        "py-2 text-right tabular-nums",
        muted ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {children}
    </td>
  );
}
