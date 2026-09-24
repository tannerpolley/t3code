import type {
  OrchestrationV2ThreadShell,
  OrchestrationProjectShell,
  ServerProvider,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { fileBasename } from "@t3tools/client-runtime/markdown-links";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";
import { modelEffortLabel } from "./modelEffortLabel";
import { useClientSettings } from "~/hooks/useSettings";
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

/** "Model · Effort" for a subagent or related thread, from its run record or its thread shell. */
export function resolveSubagentModelLabel(
  props: Pick<SubagentDetailsProps, "model" | "provider" | "childThread">,
  withEffort = true,
): string {
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
  const effort =
    withEffort &&
    modelEffortLabel(
      props.childThread?.modelSelection.options,
      providerModel?.capabilities?.optionDescriptors,
    );
  return effort ? `${modelName} · ${effort}` : modelName;
}

/** The latest progress while running, the result once settled, flattened and capped. */
export function subagentDetailPreview(
  props: Pick<SubagentDetailsProps, "status" | "result" | "progress">,
): string {
  const settled =
    props.status !== undefined &&
    ["completed", "failed", "cancelled", "interrupted"].includes(props.status);
  const result = props.result?.trim();
  const progress = props.progress?.trim();
  const detail = (settled ? result || progress : progress || result) || "";
  const compactDetail = detail.replace(/\s+/g, " ");
  return compactDetail.length > 280 ? `${compactDetail.slice(0, 280).trimEnd()}…` : compactDetail;
}

/** Project and branch/worktree lines, only where the child works somewhere else than the parent. */
export function SubagentWorkspaceLines(props: SubagentDetailsProps) {
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
  return metadata.map(({ label, value }) => {
    const Icon = label === "Branch" ? GitBranchIcon : FolderIcon;
    return (
      <div key={label} className="flex min-w-0 items-center gap-2">
        <Icon aria-hidden className="size-3 shrink-0" />
        <span className="sr-only">{label}</span>
        <MiddleTruncate value={value} className="flex text-foreground/75" showTitle={false} />
      </div>
    );
  });
}

/** One progress or result line. */
export function SubagentPreviewLine({ text }: { readonly text: string }) {
  if (!text) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <TerminalIcon aria-hidden className="size-3 shrink-0" />
      <MiddleTruncate value={text} className="flex text-foreground/75" showTitle={false} />
    </div>
  );
}

/**
 * The lines a lineage hover card shows: model and effort, status and time, where it works, and its
 * latest progress. Lineage also shows them inline when a fork or parent row is expanded.
 */
export function SubagentDetails(props: SubagentDetailsProps) {
  // The effort suffix belongs to the Lineage redesign customization.
  const withEffort = useClientSettings((settings) => settings.threadDetailsRedesign);
  const status = props.status;
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
        <span className="min-w-0 truncate text-foreground/75">
          {resolveSubagentModelLabel(props, withEffort)}
        </span>
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
      <SubagentWorkspaceLines {...props} />
      <SubagentPreviewLine text={subagentDetailPreview(props)} />
    </>
  );
}
