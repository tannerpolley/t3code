import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentIssueEntry } from "@t3tools/client-runtime/issue-list";
import { issueWriteAccess } from "@t3tools/client-runtime/issue-presentation";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { IssueState } from "@t3tools/contracts";
import { groupBy } from "effect/Array";
import { EllipsisIcon } from "lucide-react";
import { useGT, useMessages } from "gt-react";
import { useContext, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { issueEnvironment, refreshIssueLists } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { issueStatePresentation } from "./issuePresentation";
import { reportIssueStateFailure, useSetIssueState } from "./useSetIssueState";

const BOARD_DRAG_TYPE = "application/x-t3-issue-board";

function issueTarget({
  environmentId,
  projectId,
  tracker,
  host,
  scope,
  key,
}: EnvironmentIssueEntry) {
  return { environmentId, input: { projectId, tracker, host, scope, key } };
}

interface IssueBoardProps {
  readonly rows: ReadonlyArray<EnvironmentIssueEntry>;
  readonly renderRow: (row: EnvironmentIssueEntry) => ReactNode;
}

export function IssueBoard({ rows, renderRow }: IssueBoardProps) {
  const scopes = groupBy(rows, (row) => JSON.stringify([row.environmentId, row.scope]));
  return Object.entries(scopes).map(([key, scopeRows]) => (
    <RepositoryBoard key={key} first={scopeRows[0]} rows={scopeRows} renderRow={renderRow} />
  ));
}

function RepositoryBoard({
  first,
  rows,
  renderRow,
}: IssueBoardProps & { readonly first: EnvironmentIssueEntry }) {
  const gt = useGT();
  const messages = useMessages();
  const registry = useContext(RegistryContext);
  const canWrite = useAtomValue(issueEnvironment.setState.permissionAtom(first.environmentId));
  const setState = useSetIssueState();
  const [moving, setMoving] = useState(false);
  const [dragged, setDragged] = useState<EnvironmentIssueEntry | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // A detail read carries the whole workflow, including statuses with no matching cards.
  const workflow = useEnvironmentQuery(issueEnvironment.detail(issueTarget(first))).data?.states;
  const columns = new Map<string, { state: IssueState; cards: EnvironmentIssueEntry[] }>();
  for (const state of workflow ?? []) columns.set(state.name, { state, cards: [] });
  for (const row of rows) {
    const column = columns.get(row.state.name);
    if (column) column.cards.push(row);
    else columns.set(row.state.name, { state: row.state, cards: [row] });
  }
  const move = async (row: EnvironmentIssueEntry, state: string) => {
    if (!canWrite || moving || row.state.name === state) return;
    setMoving(true);
    const target = issueTarget(row);
    const result = await executeAtomQuery(registry, issueEnvironment.detail(target), {
      reportFailure: false,
    });
    if (result._tag === "Failure") {
      reportIssueStateFailure(squashAtomCommandFailure(result));
    } else if (result.value.state.name === state) {
      refreshIssueLists(target.environmentId);
    } else {
      const access = issueWriteAccess(result.value, canWrite, messages);
      if (access.states.some((candidate) => candidate.name === state)) {
        await setState(target.environmentId, { ...target.input, state });
      } else {
        reportIssueStateFailure(
          new Error(access.blocked ?? gt("This issue cannot move to {state}.", { state })),
        );
      }
    }
    setMoving(false);
  };

  return (
    <section aria-label={first.scope} className="flex min-w-0 flex-col gap-2 px-3 pt-2">
      <h3 className="truncate text-sm font-medium">{first.scope}</h3>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {[...columns.values()].map(({ state, cards }) => {
          const { Icon, toneClassName } = issueStatePresentation(state);
          const destinations = workflow?.filter((candidate) => candidate.name !== state.name) ?? [];
          const movable = canWrite && destinations.length > 0;
          const canDrop =
            canWrite &&
            !moving &&
            dragged !== null &&
            dragged.state.name !== state.name &&
            workflow?.some((candidate) => candidate.name === state.name);
          return (
            <section
              key={state.name}
              aria-label={state.name}
              className={cn(
                "w-72 max-w-[90%] shrink-0 rounded-lg border bg-muted/30 p-2",
                canDrop && over === state.name && "border-ring bg-accent/60",
              )}
              onDragOver={(event) => {
                if (!canDrop || !event.dataTransfer.types.includes(BOARD_DRAG_TYPE)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setOver(state.name);
              }}
              onDragLeave={(event) => {
                if (
                  event.relatedTarget instanceof Node &&
                  event.currentTarget.contains(event.relatedTarget)
                )
                  return;
                setOver(null);
              }}
              onDrop={(event) => {
                if (
                  !canDrop ||
                  dragged === null ||
                  event.dataTransfer.getData(BOARD_DRAG_TYPE) !== dragged.url
                )
                  return;
                event.preventDefault();
                setDragged(null);
                setOver(null);
                void move(dragged, state.name);
              }}
            >
              <h4 className="flex items-center gap-2 px-1 pb-2 text-sm font-medium">
                <Icon aria-hidden className={cn("size-3.5 shrink-0", toneClassName)} />
                <span className="min-w-0 flex-1 truncate">{state.name}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{cards.length}</span>
              </h4>
              <div className="flex min-h-16 flex-col gap-2">
                {cards.map((row) => (
                  <div
                    key={row.url}
                    className="flex items-start rounded-md border bg-background"
                    draggable={movable && !moving}
                    onDragStart={(event) => {
                      if (!movable || moving) return;
                      event.dataTransfer.setData(BOARD_DRAG_TYPE, row.url);
                      event.dataTransfer.effectAllowed = "move";
                      setDragged(row);
                    }}
                    onDragEnd={() => {
                      setDragged(null);
                      setOver(null);
                    }}
                  >
                    <div className="min-w-0 flex-1">{renderRow(row)}</div>
                    {movable ? (
                      <div className="mt-1.5 me-1">
                        <Menu>
                          <MenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                disabled={moving}
                                aria-label={gt("Move issue {issue}", { issue: row.displayKey })}
                              />
                            }
                          >
                            <EllipsisIcon aria-hidden />
                          </MenuTrigger>
                          <MenuPopup align="end">
                            {destinations.map((destination) => {
                              const { Icon, toneClassName } = issueStatePresentation(destination);
                              return (
                                <MenuItem
                                  key={destination.name}
                                  onClick={() => void move(row, destination.name)}
                                >
                                  <Icon aria-hidden className={cn("size-4", toneClassName)} />
                                  {destination.name}
                                </MenuItem>
                              );
                            })}
                          </MenuPopup>
                        </Menu>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
