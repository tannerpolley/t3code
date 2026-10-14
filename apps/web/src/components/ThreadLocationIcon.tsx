import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { FolderGit2Icon, FolderIcon } from "lucide-react";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import type { SidebarThreadSummary } from "../types";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { threadLocation } from "./ThreadLocationIcon.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** The location mark is independent of the row's caret, provider and role. */
export function ThreadLocationIcon({
  thread,
}: {
  readonly thread: Pick<SidebarThreadSummary, "environmentId" | "worktreePath">;
}) {
  const environment = useEnvironment(thread.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const machine = resolveEnvironmentMachineKind(environment?.serverConfig ?? null);
  const remote = thread.environmentId !== primaryEnvironmentId || machine === "cloud";
  const location = threadLocation({
    remote,
    environmentName: environment?.label ?? (remote ? "Remote environment" : "Local checkout"),
    worktreePath: thread.worktreePath,
  });
  const icon =
    location.kind === "environment" ? (
      <EnvironmentMachineIcon aria-hidden kind={machine} className="size-3 shrink-0" />
    ) : location.kind === "worktree" ? (
      <FolderGit2Icon aria-hidden className="size-3 shrink-0" />
    ) : (
      <FolderIcon aria-hidden className="size-3 shrink-0" />
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={location.label}
            className="inline-flex shrink-0 text-muted-foreground"
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup side="right">{location.label}</TooltipPopup>
    </Tooltip>
  );
}
