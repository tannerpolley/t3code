import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, WorkerArchiveInput, WorkerArchiveResult } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const RETENTION_DAYS = [7, 14, 30, 60, 90];

export function WorkerArchiveSettings({
  environmentId,
  environmentLabel,
  onArchived,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onArchived: () => void;
}) {
  const gt = useGT();
  const retention = useEnvironmentSettings(
    environmentId,
    (settings) => settings.archivedWorkerRetentionDays,
  );
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const archive = useAtomCommand(serverEnvironment.workerArchiveBacklog);
  const canArchive = useAtomValue(
    serverEnvironment.workerArchiveBacklog.permissionAtom(environmentId),
  );
  const canUpdate = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const [result, setResult] = useState<WorkerArchiveResult>();
  const [pending, setPending] = useState(false);

  const run = async (input: WorkerArchiveInput) => {
    setPending(true);
    const outcome = await archive({ environmentId, input }).finally(() => setPending(false));
    if (outcome._tag !== "Success") return;
    setResult(outcome.value);
    if (outcome.value.kind === "archived") onArchived();
  };

  const days =
    retention !== null && !RETENTION_DAYS.includes(retention)
      ? [...RETENTION_DAYS, retention].sort((a, b) => a - b)
      : RETENTION_DAYS;
  return (
    <SettingsSection title={`${gt("Worker archive")} · ${environmentLabel}`}>
      <SettingsRow
        title={gt("Archived worker retention")}
        description={gt(
          "Archived workers and their history are permanently deleted after this many days.",
        )}
        control={
          <Select
            value={retention === null ? "never" : String(retention)}
            disabled={!canUpdate}
            onValueChange={(value) => {
              if (value === null) return;
              void update({
                environmentId,
                input: {
                  patch: { archivedWorkerRetentionDays: value === "never" ? null : Number(value) },
                },
              });
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Archived worker retention")}>
              <SelectValue>{retention === null ? gt("Never") : String(retention)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="never">{gt("Never")}</SelectItem>
              {days.map((day) => (
                <SelectItem key={day} value={String(day)}>
                  {day}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title={gt("Archive finished workers from before this update")}
        description={gt(
          "Preview eligible threads before archiving them. You can restore them from Archived threads.",
        )}
        control={
          result?.kind === "archived" ? (
            <span role="status">
              {gt("Workers archived")}: {result.archived}
            </span>
          ) : result?.kind === "completed" ? (
            <span role="status">{gt("Backlog archive complete")}</span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!canArchive || pending}
              onClick={() => void run({ kind: "preview" })}
            >
              {gt("Preview")}
            </Button>
          )
        }
      />
      {result?.kind === "preview" && (
        <div className="space-y-2 px-4 py-3">
          <p role="status">
            {gt("Eligible workers")}: {result.workers.length}
          </p>
          {result.workers.length > 0 && (
            <ul className="max-h-56 list-disc overflow-y-auto ps-5">
              {result.workers.map(({ id, title }) => (
                <li key={id}>{title}</li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setResult(undefined)}
            >
              {gt("Cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!canArchive || pending || result.workers.length === 0}
              onClick={() => void run({ kind: "archive", token: result.token })}
            >
              {gt("Archive workers")}
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
