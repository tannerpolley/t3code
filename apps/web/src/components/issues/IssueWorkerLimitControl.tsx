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
  onSettled,
}: {
  environmentId: EnvironmentId;
  reference: IssueRepositoryRef;
  config: RepositoryOrchestration;
  slotsInUse: number;
  onSettled: () => void;
}) {
  const [draft, setDraft] = useState(String(config.workerLimit));
  const [busy, setBusy] = useState(false);
  const canSetLimit = useAtomValue(issueEnvironment.setWorkerLimit.permissionAtom(environmentId));
  const setLimit = useAtomCommand(issueEnvironment.setWorkerLimit, { reportFailure: false });
  const limit = Number(draft);
  const valid = Number.isInteger(limit) && limit >= 1 && limit <= 32;
  const disabled = busy || !canSetLimit || config.handoff?.status === "draining";
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate" role="status">
        {slotsInUse} of {config.workerLimit} in use
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
                      aria-label="Change worker limit"
                      disabled={disabled}
                    />
                  }
                />
              }
            >
              <PencilIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Change worker limit</TooltipPopup>
          </Tooltip>
          <PopoverPopup align="start" padding="compact">
            <form
              className="flex items-center gap-1.5"
              onSubmit={async (event) => {
                event.preventDefault();
                if (disabled || !valid || limit === config.workerLimit) return;
                setBusy(true);
                const result = await setLimit({
                  environmentId,
                  input: {
                    ...reference,
                    workerLimit: limit,
                    expectedRevision: config.revision,
                    clientRequestId: CommandId.make(randomUUID()),
                  },
                });
                setBusy(false);
                if (result._tag === "Failure")
                  toastManager.add({
                    type: "error",
                    title: "Could not update the repository worker limit",
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
                  aria-label="Repository worker limit"
                  min={1}
                  max={32}
                  step={1}
                  required
                  value={draft}
                  disabled={disabled}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </div>
              <span className="text-xs text-muted-foreground">workers</span>
              <Button
                size="xs"
                type="submit"
                disabled={disabled || !valid || limit === config.workerLimit}
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
