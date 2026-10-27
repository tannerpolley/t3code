import {
  type ModelSelection,
  type OrchestrationV2AutoProviderSwitch,
  type UsageLimitRecoveryMode,
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { deadlineStore } from "@t3tools/client-runtime/clock";
import { GaugeIcon } from "lucide-react";
import { useState } from "react";
import { useDeadlinePassed } from "../../hooks/useDeadline";
import { Button } from "../ui/button";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type RecoveryProps = {
  mode?: UsageLimitRecoveryMode;
  runId: RunId;
  resetAt: string | null;
  stoppedAt: string;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  timestampFormat: TimestampFormat;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { runId, resetAt, stoppedAt, timestampFormat } = props;
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    icon: <GaugeIcon />,
    title: "Usage limit reached",
    description: `${props.mode === undefined ? "" : props.mode === "off" ? "Automatic recovery is off. " : props.mode === "switch" ? "Automatic provider recovery is enabled. " : "Waiting for reset. "}${
      resetAt
        ? `Resets ${formatUpcomingTimestamp(resetAt, timestampFormat)}`
        : "Reset time unavailable; retry manually"
    }`,
    actions: canSchedule ? <RecoveryActions key={`${runId}:${resetAt}`} {...props} /> : null,
  };
}

function RecoveryActions({ runId, resetAt, recovery, snoozedUntil, onChange }: RecoveryProps) {
  const [pending, setPending] = useState(false);

  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  // The server leaves snoozedUntil in place after the timer wakes the thread,
  // so a snooze whose reset has passed is no longer active.
  const resetPassed = useDeadlinePassed(resetAt === null ? null : Date.parse(resetAt));
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    snoozedUntil !== null &&
    Date.parse(snoozedUntil) === Date.parse(resetAt) &&
    !resetPassed;
  async function toggle(action: "resume" | "snooze") {
    if (resetAt === null) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      toastManager.add({
        type: "error",
        title: "Could not snooze thread",
        description: "The reset time has passed. Retry the thread manually.",
      });
      // The deadline timer can lag after a throttled tab or sleep; disable now.
      deadlineStore(Date.parse(resetAt)).refresh();
      return;
    }
    setPending(true);
    try {
      await onChange({
        runId,
        resetAt,
        ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: action === "resume" ? "Could not change auto-resume" : "Could not snooze thread",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
    setPending(false);
  }
  // Inline errors would widen the actions column and crush the title.
  return (
    <>
      <Button size="xs" variant="ghost" disabled={pending} onClick={() => void toggle("resume")}>
        {pending ? "Saving..." : scheduled ? "Cancel auto-resume" : "Resume at reset"}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={pending || (!snoozed && resetPassed)}
        onClick={() => void toggle("snooze")}
      >
        {pending ? "Saving..." : snoozed ? "Wake now" : "Snooze until reset"}
      </Button>
    </>
  );
}

export function automaticProviderSwitchBannerItem(
  marker: OrchestrationV2AutoProviderSwitch,
  onSwitchBack: (selection: ModelSelection) => Promise<void>,
  canSwitchBack: boolean,
): ComposerBannerStackItem {
  return {
    id: `auto-provider-switch:${marker.runId}`,
    variant: marker.to === null ? "warning" : "info",
    icon: <GaugeIcon />,
    title: marker.to === null ? "Waiting for reset" : "Provider switched automatically",
    description: marker.message,
    actions:
      marker.to === null && marker.switchBack === undefined ? null : (
        <SwitchBackAction
          onSwitchBack={() => onSwitchBack(marker.switchBack ?? marker.from)}
          disabled={!canSwitchBack}
        />
      ),
  };
}

function SwitchBackAction({
  onSwitchBack,
  disabled,
}: {
  onSwitchBack: () => Promise<void>;
  disabled: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled || pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            await onSwitchBack();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not switch provider.");
          }
          setPending(false);
        }}
      >
        {pending ? "Switching..." : "Switch back"}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
