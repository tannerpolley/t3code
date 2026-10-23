import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  type EnvironmentId,
  type IssueRepositoryRef,
  type RepositoryOrchestration,
} from "@t3tools/contracts";
import { PencilIcon } from "lucide-react";
import { useState } from "react";
import { randomUUID } from "~/lib/utils";
import { issueEnvironment } from "~/state/issues";
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
  const currentLimit = pool === "worker" ? config.workerLimit : config.readOnlyLimit;
  const command =
    pool === "worker" ? issueEnvironment.setWorkerLimit : issueEnvironment.setReadOnlyLimit;
  const label = pool === "worker" ? "worker" : "read-only";
  const [draft, setDraft] = useState(String(currentLimit));
  const [busy, setBusy] = useState(false);
  const canSetLimit = useAtomValue(command.permissionAtom(environmentId));
  const setWorkerLimit = useAtomCommand(issueEnvironment.setWorkerLimit, { reportFailure: false });
  const setReadOnlyLimit = useAtomCommand(issueEnvironment.setReadOnlyLimit, {
    reportFailure: false,
  });
  const limit = Number(draft);
  const valid = Number.isInteger(limit) && limit >= 1 && limit <= 32;
  const disabled = busy || !canSetLimit || config.handoff?.status === "draining";
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate" role="status">
        {slotsInUse} of {currentLimit} in use
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
                      aria-label={`Change ${label} limit`}
                      disabled={disabled}
                    />
                  }
                />
              }
            >
              <PencilIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{`Change ${label} limit`}</TooltipPopup>
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
                    title: `Could not update the repository ${label} limit`,
                    description: formatEnvironmentQueryError(result.cause),
                  });
                onSettled();
              }}
            >
              <span className="text-xs text-muted-foreground">Up to</span>
              <div className="w-16">
                <Input
                  type="number"
                  size="compact"
                  aria-label={`Repository ${label} limit`}
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
                {pool === "worker" ? "workers" : "read-only children"}
              </span>
              <Button
                size="xs"
                type="submit"
                disabled={disabled || !valid || limit === currentLimit}
              >
                Save
              </Button>
            </form>
          </PopoverPopup>
        </Popover>
      ) : null}
    </span>
  );
}
