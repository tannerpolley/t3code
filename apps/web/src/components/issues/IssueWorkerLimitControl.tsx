import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  type EnvironmentId,
  type IssueRepositoryRef,
  type RepositoryOrchestration,
} from "@t3tools/contracts";
import { useState } from "react";
import { randomUUID } from "~/lib/utils";
import { issueEnvironment } from "~/state/issues";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

/** Revision-keyed by the parent so a refreshed configuration replaces the draft. */
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
    <form
      className="flex items-center gap-1"
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
      <span className="text-xs text-muted-foreground" role="status">
        Workers: {slotsInUse}/{config.workerLimit} in use
      </span>
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
      <Button
        size="xs"
        variant="ghost"
        type="submit"
        disabled={disabled || !valid || limit === config.workerLimit}
      >
        Set limit
      </Button>
    </form>
  );
}
