import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const RETENTION_DAYS = [7, 14, 30, 60, 90];

export function WorkerArchiveSettings({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const gt = useGT();
  const retention = useEnvironmentSettings(
    environmentId,
    (settings) => settings.archivedWorkerRetentionDays,
  );
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const canUpdate = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
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
    </SettingsSection>
  );
}
