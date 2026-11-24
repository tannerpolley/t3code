import { T, useGT } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import {
  repositoryPhase,
  CommandId,
  type EnvironmentId,
  type IssueRepositoryRef,
  type RepositoryOrchestration,
} from "@t3tools/contracts";
import { PencilIcon } from "lucide-react";
import { useState } from "react";
import { randomUUID } from "~/lib/utils";
import { repositoryIssueEnvironment } from "~/state/repositoryIssues";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Revision-keyed by the parent, so a saved limit replaces the draft and closes the popover. */
export function IssueWorkerLimitControl({
  environmentId,
  reference,
  config,
  slotsInUse,
  pool = "worker",
  onSettled,
}: {
  environmentId: EnvironmentId;
  reference: IssueRepositoryRef;
  config: RepositoryOrchestration;
  slotsInUse: number;
  pool?: "worker" | "readOnly";
  onSettled: () => void;
}) {
  const gt = useGT();
  const currentLimit = pool === "worker" ? config.workerLimit : config.readOnlyLimit;
  const command =
    pool === "worker"
      ? repositoryIssueEnvironment.setWorkerLimit
      : repositoryIssueEnvironment.setReadOnlyLimit;
  const worker = pool === "worker";
  const changeLabel = worker ? gt("Change worker limit") : gt("Change read-only limit");
  const [draft, setDraft] = useState(String(currentLimit));
  const [busy, setBusy] = useState(false);
  const canSetLimit = useAtomValue(command.permissionAtom(environmentId));
  const setWorkerLimit = useAtomCommand(repositoryIssueEnvironment.setWorkerLimit, {
    reportFailure: false,
  });
  const setReadOnlyLimit = useAtomCommand(repositoryIssueEnvironment.setReadOnlyLimit, {
    reportFailure: false,
  });
  const limit = Number(draft);
  const valid = Number.isInteger(limit) && limit >= 1 && limit <= 32;
  const disabled = busy || !canSetLimit || repositoryPhase(config) === "draining";
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate" role="status">
        {gt("{used} of {limit} in use", { used: slotsInUse, limit: currentLimit })}
      </span>
      {canSetLimit ? (
        <Popover>
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={changeLabel}
                      disabled={disabled}
                    />
                  }
                />
              }
            >
              <PencilIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{changeLabel}</TooltipPopup>
          </Tooltip>
          <PopoverPopup align="start" padding="compact">
            <form
              className="flex items-center gap-1.5"
              onSubmit={async (event) => {
                event.preventDefault();
                if (disabled || !valid || limit === currentLimit) return;
                setBusy(true);
                const input = {
                  ...reference,
                  expectedRevision: config.revision,
                  clientRequestId: CommandId.make(randomUUID()),
                };
                const result = await (pool === "worker"
                  ? setWorkerLimit({ environmentId, input: { ...input, workerLimit: limit } })
                  : setReadOnlyLimit({ environmentId, input: { ...input, readOnlyLimit: limit } }));
                setBusy(false);
                if (result._tag === "Failure")
                  toastManager.add({
                    type: "error",
                    title: worker
                      ? gt("Could not update the repository worker limit")
                      : gt("Could not update the repository read-only limit"),
                    description: formatEnvironmentQueryError(result.cause),
                  });
                onSettled();
              }}
            >
              <span className="text-xs text-muted-foreground">
                <T>Up to</T>
              </span>
              <div className="w-16">
                <Input
                  type="number"
                  size="compact"
                  aria-label={
                    worker ? gt("Repository worker limit") : gt("Repository read-only limit")
                  }
                  min={1}
                  max={32}
                  step={1}
                  required
                  value={draft}
                  disabled={disabled}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </div>
              <span className="text-xs text-muted-foreground">
                {worker ? gt("workers") : gt("read-only children")}
              </span>
              <Button
                size="xs"
                type="submit"
                disabled={disabled || !valid || limit === currentLimit}
              >
                <T>Save</T>
              </Button>
            </form>
          </PopoverPopup>
        </Popover>
      ) : null}
    </span>
  );
}
