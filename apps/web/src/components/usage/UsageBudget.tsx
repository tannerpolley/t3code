import type { UsageBudgetGroup, UsageBudgetRow, UsageProviderKind } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatCount, formatTokens } from "@t3tools/shared/usageFormat";
import { useGT } from "gt-react";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export function UsageBudget({
  environments,
  hiddenProviders,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
}) {
  const gt = useGT();
  const groups = {
    task: gt("Task"),
    role: gt("Role"),
    stage: gt("Stage"),
    wake: gt("Wake reason"),
  } satisfies Record<UsageBudgetGroup, string>;
  const [group, setGroup] = useState<UsageBudgetGroup>("task");
  return (
    <section className="mt-8 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{gt("Recorded usage over seven days")}</h2>
        <ToggleGroup
          aria-label={gt("Rank usage by")}
          value={[group]}
          variant="segmented"
          onValueChange={([value]) => {
            if (value && Object.hasOwn(groups, value)) setGroup(value as UsageBudgetGroup);
          }}
        >
          {Object.entries(groups).map(([key, label]) => (
            <Toggle key={key} value={key}>
              {label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      <p className="text-xs text-muted-foreground">
        {gt(
          "Token totals cover settled turns recorded by T3 Code. Provider meters track account quotas.",
        )}
      </p>
      {environments.map((environment) => (
        <EnvironmentBudget
          key={environment.environmentId}
          environment={environment}
          hiddenProviders={hiddenProviders}
          group={group}
          groupLabel={groups[group]}
        />
      ))}
    </section>
  );
}

function EnvironmentBudget({
  environment,
  group,
  groupLabel,
  hiddenProviders,
}: {
  readonly environment: EnvironmentUsageStatus;
  readonly group: UsageBudgetGroup;
  readonly groupLabel: string;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
}) {
  const gt = useGT();
  const { environmentId } = environment;
  const query = useEnvironmentQuery(
    environment.canReadDiagnostics && environment.isConnected
      ? serverEnvironment.usageBudget({ environmentId, input: {} })
      : null,
  );
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h3 className="text-sm font-medium">{environment.label}</h3>
      {environment.error || query.error ? (
        <p role="status" className="text-sm text-muted-foreground">
          {environment.error ?? query.error}
        </p>
      ) : null}
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {gt("Reading usage…")}
        </p>
      ) : null}
      {query.data === null ? null : (
        <>
          <p className="text-xs text-muted-foreground">
            {new Date(query.data.since).toLocaleString()} –{" "}
            {new Date(query.data.asOf).toLocaleString()}
            {query.error ? ` · ${gt("Previous result")}` : ""}
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {query.data.providers
              .filter(({ provider }) => !hiddenProviders.has(provider))
              .map(({ provider, totals, groups }) => (
                <section key={provider} className="min-w-0 space-y-2">
                  <h4 className="text-sm font-medium">
                    {provider === "claude" ? "Claude" : "Codex"}
                  </h4>
                  {totals.turns === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {gt("No settled turns in this window.")}
                    </p>
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">
                        {gt(
                          "{tokens} tokens · {measured}/{turns} turns measured · {partial} with incomplete detail",
                          {
                            tokens: formatTokens(totals.input + totals.output),
                            measured: formatCount(totals.measuredTurns),
                            turns: formatCount(totals.turns),
                            partial: formatCount(totals.partialTurns),
                          },
                        )}
                      </p>
                      {totals.residual > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {gt(
                            "{tokens} additional provider-ledger tokens may overlap native child turns and are excluded from rankings.",
                            {
                              tokens: formatTokens(totals.residual),
                            },
                          )}
                        </p>
                      ) : null}
                      <ol
                        className="divide-y rounded-lg border"
                        aria-label={gt("Top usage by {group}", { group: groupLabel })}
                      >
                        {groups[group].map((row) => (
                          <BudgetRow key={row.key} row={row} environmentId={environmentId} />
                        ))}
                      </ol>
                    </>
                  )}
                </section>
              ))}
          </div>
        </>
      )}
    </section>
  );
}

function BudgetRow({
  row,
  environmentId,
}: {
  readonly row: UsageBudgetRow;
  readonly environmentId: EnvironmentUsageStatus["environmentId"];
}) {
  const gt = useGT();
  const { totals } = row;
  const observed = (value: number, count: number) =>
    count === 0
      ? gt("Unknown")
      : count < totals.turns
        ? gt("{value} (partial)", { value: formatCount(value) })
        : formatCount(value);
  const details = [
    [gt("Input"), formatCount(totals.input)],
    [gt("Uncached input"), observed(totals.uncachedInput, totals.uncachedInputTurns)],
    [gt("Cache reads"), observed(totals.cacheRead, totals.cacheReadTurns)],
    [gt("Cache writes"), observed(totals.cacheWrite, totals.cacheWriteTurns)],
    [gt("Output"), formatCount(totals.output)],
    [gt("Measured turns"), `${totals.measuredTurns} / ${totals.turns}`],
    [gt("Requests"), observed(totals.requests, totals.requestCountTurns)],
    [
      gt("First observed input context"),
      totals.firstContext === null ? gt("Unknown") : formatCount(totals.firstContext),
    ],
    [
      gt("Peak observed input context"),
      totals.peakContext === null ? gt("Unknown") : formatCount(totals.peakContext),
    ],
    [gt("Run starts"), formatCount(totals.wakes)],
    [gt("Delivered child results"), formatCount(totals.deliveredResults)],
  ];
  return (
    <li className="p-2.5 text-xs">
      <details>
        <summary className="cursor-pointer">
          <span className="mx-1 break-words">{row.label}</span>
          <span className="font-medium tabular-nums">
            {gt("{tokens} tokens", { tokens: formatTokens(totals.input + totals.output) })}
          </span>
        </summary>
        <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-muted-foreground">
          {details.map(([label, value]) => (
            <div key={label} className="contents">
              <dt>{label}</dt>
              <dd className="text-end tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {row.issueUrl && /^https?:\/\//i.test(row.issueUrl) ? (
          <a
            className="mt-2 inline-block underline"
            href={row.issueUrl}
            target="_blank"
            rel="noreferrer"
          >
            {gt("Open issue")}
          </a>
        ) : row.threadId ? (
          <Link
            className="mt-2 inline-block underline"
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams(scopeThreadRef(environmentId, row.threadId))}
          >
            {gt("Open thread")}
          </Link>
        ) : null}
      </details>
    </li>
  );
}
