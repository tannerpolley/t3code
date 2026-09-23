import type {
  OrchestrationV2ThreadShell,
  OrchestrationProjectShell,
  ServerProvider,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { fileBasename } from "@t3tools/client-runtime/markdown-links";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";
import { modelEffortLabel } from "./modelEffortLabel";
import { getTriggerDisplayModelName } from "./providerIconUtils";
import type { ReactNode } from "react";
import {
  BotIcon,
  CheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  FolderIcon,
  GitBranchIcon,
  TerminalIcon,
} from "lucide-react";
import { ThreadHoverCard } from "../ThreadHoverCard";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { cn } from "~/lib/utils";

type SubagentDetailsProps = {
  model: string | null;
  provider?: ServerProvider | undefined;
  driver?: ProviderDriverKind | undefined;
  elapsed?: ReactNode;
  parentThread?: Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath"> | undefined;
  childThread?:
    | Pick<OrchestrationV2ThreadShell, "branch" | "worktreePath" | "modelSelection">
    | undefined;
  parentProject?: Pick<OrchestrationProjectShell, "workspaceRoot"> | undefined;
  childProject?: Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot"> | undefined;
  /** Absent for forks and the parent, which have no run of their own to report. */
  status?: string | undefined;
  result?: string | null | undefined;
  progress?: string | null | undefined;
};

/** Geometry and preview limits stay identical in lineage and timeline tooltips. */
export function SubagentTooltipContent(props: SubagentDetailsProps & { title: string }) {
  return (
    <ThreadHoverCard title={props.title}>
      <SubagentDetails {...props} />
    </ThreadHoverCard>
  );
}

/**
 * The lines a lineage hover card shows: model and effort, status and time, where it works, and its
 * latest progress. Lineage also shows them inline when a row is expanded.
 */
export function SubagentDetails(props: SubagentDetailsProps) {
  const model = props.model?.trim() || props.childThread?.modelSelection.model.trim();
  const modelSlug = props.provider
    ? resolveSelectableModel(props.provider.driver, model, props.provider.models)
    : model;
  const providerModel = props.provider?.models.find((candidate) => candidate.slug === modelSlug);
  const modelName = providerModel
    ? getTriggerDisplayModelName(providerModel)
    : model
      ? formatModelSlugName(model)
      : "Not reported";
  const effort = modelEffortLabel(
    props.childThread?.modelSelection.options,
    providerModel?.capabilities?.optionDescriptors,
  );
  const modelLabel = effort ? `${modelName} · ${effort}` : modelName;
  const currentWorkspace = props.parentThread?.worktreePath ?? props.parentProject?.workspaceRoot;
  const childWorkspace = props.childThread?.worktreePath ?? props.childProject?.workspaceRoot;
  const metadata = [
    ...(props.parentThread &&
    props.childProject &&
    props.childProject.id !== props.parentThread.projectId
      ? [{ label: "Project", value: props.childProject.title }]
      : []),
    ...(currentWorkspace && childWorkspace && currentWorkspace !== childWorkspace
      ? [
          {
            label: props.childThread?.branch
              ? "Branch"
              : props.childThread?.worktreePath
                ? "Worktree"
                : "Workspace",
            value: props.childThread?.branch ?? fileBasename(childWorkspace),
          },
        ]
      : []),
  ];
  const status = props.status;
  const settled =
    status !== undefined && ["completed", "failed", "cancelled", "interrupted"].includes(status);
  const result = props.result?.trim();
  const progress = props.progress?.trim();
  const detail = (settled ? result || progress : progress || result) || "";
  const compactDetail = detail.trim().replace(/\s+/g, " ");
  const preview =
    compactDetail.length > 280 ? `${compactDetail.slice(0, 280).trimEnd()}…` : compactDetail;
  const driver = props.provider?.driver ?? props.driver;
  const working =
    status !== undefined && ["running", "in_progress", "pending", "waiting"].includes(status);
  const failed = status !== undefined && ["failed", "error"].includes(status);
  const StatusIcon = working
    ? CircleDashedIcon
    : failed
      ? CircleXIcon
      : status === "completed"
        ? CheckIcon
        : CircleDashedIcon;
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        {driver ? (
          <ProviderInstanceIcon
            driverKind={driver}
            displayName={props.provider?.displayName ?? driver}
            acpRegistryIconUrl={props.provider?.iconUrl}
            iconClassName="size-3 shrink-0 grayscale opacity-60"
          />
        ) : (
          <BotIcon className="size-3 shrink-0" />
        )}
        <span className="min-w-0 truncate text-foreground/75">{modelLabel}</span>
      </div>
      {status === undefined ? null : (
        <div className="flex min-w-0 items-center justify-between gap-4">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-sm font-medium capitalize",
              working
                ? "text-sky-600 dark:text-sky-400"
                : failed
                  ? "text-red-700 dark:text-red-300"
                  : status === "completed"
                    ? "text-emerald-700 dark:text-emerald-300"
                    : "text-muted-foreground",
            )}
          >
            <StatusIcon aria-hidden className="size-3 shrink-0" />
            {status.replaceAll("_", " ")}
          </span>
          {props.elapsed}
        </div>
      )}
      {metadata.map(({ label, value }) => {
        const Icon = label === "Branch" ? GitBranchIcon : FolderIcon;
        return (
          <div key={label} className="flex min-w-0 items-center gap-2">
            <Icon aria-hidden className="size-3 shrink-0" />
            <span className="sr-only">{label}</span>
            <MiddleTruncate value={value} className="flex text-foreground/75" showTitle={false} />
          </div>
        );
      })}
      {preview ? (
        <div className="flex min-w-0 items-center gap-2">
          <TerminalIcon aria-hidden className="size-3 shrink-0" />
          <MiddleTruncate value={preview} className="flex text-foreground/75" showTitle={false} />
        </div>
      ) : null}
    </>
  );
}
