import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import Svg, { Circle, Path } from "react-native-svg";
import { IconButton } from "../../components/ui/IconButton";
import {
  formatSidebarAgentStates,
  sidebarRoleSectionLabels,
  sidebarAgentsSectionLabel,
} from "@t3tools/client-runtime/state/sidebar-families";
import { useViewability } from "@legendapp/list/react-native";
import {
  canStartFresh,
  effortBarHeights,
  sidebarCodexDefaultSpeed,
  sidebarRoleLabels,
  sidebarRowModel,
  shouldRecedeSidebarThread,
  threadLifeRing,
} from "@t3tools/client-runtime/sidebar-row-model";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { isDelegationModelRole, isProviderDriverKind } from "@t3tools/contracts";
import { ThreadRowSpinner } from "./ThreadRowSpinner";
import { useAppActive } from "../../lib/appState";
import { useIsFocused } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import * as Dialog from "../../components/ui/Dialog";
import type { ThreadRowProviderInstance } from "./thread-provider-instance";
import {
  THREAD_LIST_V2_MONO_FONT as MONO_FONT,
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  THREAD_LIST_V2_ROW_DIVIDERS,
  selectedThreadRowColors,
  getThreadListV2NewBranchMenuTitle,
  getThreadListV2RowAppearance,
} from "./thread-list-v2-row-appearance";
import { RowPressable } from "../../components/ui/RowPressable";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadArrangementOpenAtom } from "../../state/thread-order";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import type { ThreadMoveDestination } from "./threadOrder";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import {
  formatWorkingDurationLabel,
  resolveThreadWorkingStartedAt,
} from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type EnvironmentMachineKind,
} from "@t3tools/contracts";
import { toServerClock } from "@t3tools/client-runtime/clock";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { memo, useCallback, useContext, useMemo, useState, type ComponentProps } from "react";
import { Platform, Pressable, Text as RNText, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import type { ThreadListProvider } from "../../state/thread-list-environments";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ProviderInstanceIcon, providerInstanceNameLabel } from "../../components/ProviderIcon";
import { useNowAfter } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { copyThreadReference } from "../../lib/copyThreadReference";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useEnvironmentScope, useEnvironmentScopeDenied } from "../../state/session";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  pendingDraftBranchNeedsRefs,
  resolvePendingDraftBranch,
} from "../../state/pending-new-tasks-model";
import { useBranches } from "../../state/queries";
import { useNewTaskProjectDefaults } from "./use-new-task-project-defaults";
import {
  resolveThreadPrBadgeAction,
  type ThreadPrPresentation,
} from "../../state/thread-pr-presentation";
import { useThreadPr } from "../../state/use-thread-pr";
import { useSwipeRowDormant } from "../home/swipe-row-activation";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import { canTurnThreadIntoProject, turnThreadIntoProject } from "./turnThreadIntoProject";
import { threadCanArchive } from "../home/threadArchive";
import { useCanShareWithGuest } from "./useCanShareWithGuest";
import {
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozePresets,
  threadHasUnseenCompletion,
  resolveThreadListV2RowStatus,
  resolveThreadListV2SwipeActions,
  layoutThreadListV2RowMenuActions,
  threadListV2RowAccessibilityLabel,
  type ThreadListV2Status,
  type ThreadListV2AgentSectionItem,
  type ThreadListV2ProjectFolderItem,
  type ThreadListV2ProjectSectionItem,
} from "./threadListV2";
import { QueuedMessageIcon } from "./queued-message-icon";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { pullRequestStatus } from "../pull-requests/pullRequestStatus";

interface StatusLabel {
  // Null when the icon and timer carry the status on their own.
  readonly label: string | null;
  readonly icon: AppSymbolName;
  readonly iconTintClassName: string;
}
export const THREAD_ROW_VIEWABILITY = { itemVisiblePercentThreshold: 1 };

const WORKING_STATUS_TINT = "accent-adaptive-sky-600-400";

const STATUS_LABEL_BY_STATUS: Partial<Record<ThreadListV2Status, StatusLabel>> = {
  approval: {
    label: msg("Approval", { $context: "thread status, waiting for approval" }),
    icon: "exclamationmark.shield",
    iconTintClassName: "accent-warning-foreground",
  },
  input: {
    label: msg("Input", { $context: "thread status, waiting for user input" }),
    icon: "questionmark.bubble",
    iconTintClassName: "accent-adaptive-indigo-600-300",
  },
  request: {
    label: msg("Request", { $context: "thread status, a guest request is waiting" }),
    icon: "person.crop.circle",
    iconTintClassName: "accent-adaptive-fuchsia-600-300",
  },
  working: {
    label: null,
    icon: "circle.dashed",
    iconTintClassName: WORKING_STATUS_TINT,
  },
  waiting: {
    label: null,
    icon: "circle.dashed.inset.filled",
    iconTintClassName: "accent-foreground-muted",
  },
  failed: {
    label: msg("Failed", { $context: "thread status" }),
    icon: "exclamationmark.circle",
    iconTintClassName: "accent-danger-foreground",
  },
  limited: {
    label: msg("Limited", { $context: "thread status, usage limit reached" }),
    icon: "exclamationmark.circle",
    iconTintClassName: "accent-warning-foreground",
  },
};
const DONE_STATUS_LABEL: StatusLabel = {
  label: msg("Done", { $context: "thread status, turn finished" }),
  icon: "checkmark.circle",
  iconTintClassName: "accent-adaptive-emerald-700-300",
};

// DM Sans has no tabular figures, so a ticking timer in it reflows the row every second.
const TABULAR_DURATION_STYLE = {
  fontFamily: Platform.OS === "ios" ? "System" : "sans-serif",
  fontWeight: "700",
  fontVariant: ["tabular-nums"],
} as const;

function ThreadListV2Duration(props: {
  readonly environmentId: EnvironmentId;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly visible: boolean;
}) {
  const messages = useMessages();
  const startedAtMs = Date.parse(props.startedAt ?? "");
  const nowMs = useVisibleSecondClock(
    props.visible && props.completedAt === null && Number.isFinite(startedAtMs),
  );
  if (!Number.isFinite(startedAtMs)) return null;
  return (
    <>
      <RNText style={TABULAR_DURATION_STYLE}>
        {formatWorkingDurationLabel(
          (props.completedAt
            ? Date.parse(props.completedAt)
            : toServerClock(props.environmentId, nowMs)) - startedAtMs,
          messages,
        )}
      </RNText>
    </>
  );
}

const CARD_MENU_ACTIONS: MenuAction[] = [
  { id: "settle", title: msg("Settle", { $context: "verb, thread action" }), image: "checkmark" },
  {
    id: "delete",
    title: msg("Delete", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

const SLIM_MENU_ACTIONS: MenuAction[] = [
  {
    id: "unsettle",
    title: msg("Un-settle", { $context: "verb, thread action" }),
    image: "arrow.uturn.backward",
  },
  {
    id: "delete",
    title: msg("Delete", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

const SNOOZED_MENU_ACTIONS: MenuAction[] = [
  { id: "unsnooze", title: msg("Wake thread"), image: "clock" },
  {
    id: "delete",
    title: msg("Delete", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

const LEGACY_MENU_ACTIONS: MenuAction[] = [
  {
    id: "archive",
    title: msg("Archive", { $context: "verb, thread action" }),
    image: "archivebox",
  },
  {
    id: "delete",
    title: msg("Delete", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

const ThreadListV2SectionDivider = memo(function ThreadListV2SectionDivider(props: {
  readonly label: string;
  readonly pane?: "screen" | "sidebar";
}) {
  const sidebar = props.pane === "sidebar";
  return (
    <View className={cn("mb-1.5 mt-4 flex-row items-center gap-2.5", sidebar ? "px-3" : "px-5")}>
      <Text
        className={cn(
          "text-xs font-t3-medium",
          sidebar ? "text-drawer-foreground-muted" : "text-foreground-tertiary",
        )}
      >
        {props.label}
      </Text>
      <View className={cn("h-px flex-1", sidebar ? "bg-drawer-border" : "bg-border")} />
    </View>
  );
});

const TRIAGE_MENU_ACTION_IDS = new Set(["settle", "snooze", "unsettle", "unsnooze"]);

export const ThreadListV2ShowMoreRow = memo(function ThreadListV2ShowMoreRow(props: {
  readonly pane?: "screen" | "sidebar";
  readonly hiddenCount: number;
  /** Older settled threads are loading, or their last read failed. */
  readonly state?: "loading" | "failed";
  readonly onPress: () => void;
}) {
  const gt = useGT();
  const label =
    props.state === "loading"
      ? gt("Loading", { $context: "older threads are loading" })
      : props.state === "failed"
        ? gt("Could not load older threads. Retry")
        : gt(
            "{count, plural, one {Show more ({count} settled hidden)} other {Show more ({count} settled hidden)}}",
            { count: props.hiddenCount },
          );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        props.state === undefined
          ? gt(
              "{count, plural, one {Show {count} more settled threads} other {Show {count} more settled threads}}",
              {
                count: Math.min(props.hiddenCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT),
              },
            )
          : label
      }
      disabled={props.state === "loading"}
      onPress={props.onPress}
      className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text
        className={
          props.pane === "sidebar"
            ? "text-xs font-t3-medium text-drawer-foreground-muted"
            : "text-xs font-t3-medium text-foreground-muted"
        }
      >
        {label}
      </Text>
    </Pressable>
  );
});

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  {
    id: "delete",
    title: msg("Delete", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

const DRAFT_TASK_MENU_ACTIONS: MenuAction[] = [
  {
    id: "delete",
    title: msg("Discard", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

export const ThreadListV2PendingRow = memo(function ThreadListV2PendingRow(props: {
  readonly pendingTask: PendingNewTask;
  readonly selected?: boolean;
  readonly project: EnvironmentProject | null;
  readonly environmentLabel: string | null;
  readonly environmentMachine?: EnvironmentMachineKind;
  readonly pane?: "screen" | "sidebar";
  readonly showPendingDivider: boolean;
  readonly showTrailingDivider?: boolean;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
  readonly fullSwipeWidth?: number;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly activationKey?: string;
  readonly simultaneousSwipeGesture?: ComponentProps<typeof ThreadSwipeable>["simultaneousWith"];
}) {
  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props;
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const titleTypography = useScaledTextRole("body");
  const metadataTypography = useScaledTextRole("label");
  const projectIconSize = titleTypography.fontSize * 1.25 * fontScale;
  const machineIconSize = metadataTypography.fontSize * fontScale;
  // Android's nonlinear system text scaling can differ from the fontScale estimate.
  const [androidTitleLineHeight, setTitleLineHeight] = useState(
    titleTypography.lineHeight * fontScale,
  );
  const titleLineHeight =
    Platform.OS === "android" ? androidTitleLineHeight : titleTypography.lineHeight * fontScale;
  const dormant = useSwipeRowDormant(props.activationKey);
  const theme = useUniwindTheme();
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected ?? false;
  const rowAppearance = getThreadListV2RowAppearance(theme, sidebarPane, selected);
  const gt = useGT();
  const m = useMessages();
  const isDraft = pendingTask.kind === "draft";
  const deleteLabel = isDraft
    ? gt("Discard", { $context: "verb, thread action" })
    : gt("Delete", { $context: "verb, thread action" });
  const handleDelete = useCallback(
    () => onDeletePendingTask(pendingTask),
    [onDeletePendingTask, pendingTask],
  );
  const deleteAction = useMemo(
    () => ({
      accessibilityLabel: isDraft
        ? gt("Discard {title}", { title: pendingTask.title })
        : gt("Delete {title}", { title: pendingTask.title }),
      destructive: true,
      icon: "trash" as const,
      label: deleteLabel,
      onPress: handleDelete,
    }),
    [deleteLabel, gt, handleDelete, isDraft, pendingTask.title],
  );
  const projectCwd = props.project?.workspaceRoot || null;
  // Drafts only; the reads are shared per-project atoms, and queued rows skip them.
  const projectDefaults = useNewTaskProjectDefaults(isDraft ? props.project : null);
  const draftDefaults = {
    canChooseWorkspace: !projectDefaults.isScratch,
    defaultMode: projectDefaults.defaultWorkspaceMode,
    defaultModeSettled: projectDefaults.defaultWorkspaceModeSettled,
  };
  const draftBranchRefs = useBranches({
    environmentId: pendingTask.environmentId,
    cwd:
      isDraft && pendingDraftBranchNeedsRefs(pendingTask.draft, draftDefaults) ? projectCwd : null,
  });
  const branch = isDraft
    ? resolvePendingDraftBranch({
        draft: pendingTask.draft,
        defaults: draftDefaults,
        isGitRepo: draftBranchRefs.data?.isRepo ?? true,
        branches: draftBranchRefs.data?.refs ?? [],
        projectCwd,
      })
    : pendingTask.branch;

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "delete") onDeletePendingTask(pendingTask);
    },
    [onDeletePendingTask, pendingTask],
  );

  const titleTextInset = props.project ? projectIconSize + 8 : 0;
  const rowContent = (
    <>
      <View className="flex-row items-start gap-2">
        {props.project ? (
          <View className="justify-center" style={{ height: titleLineHeight }}>
            <ProjectFavicon
              environmentId={pendingTask.environmentId}
              faviconPath={props.project.faviconPath}
              projectIcon={props.project.projectIcon}
              size={projectIconSize}
              projectTitle={props.project.title}
              workspaceRoot={props.project.workspaceRoot}
            />
          </View>
        ) : null}
        <Text
          className={cn(
            "flex-1 text-base font-t3-medium",
            selected
              ? selectedThreadRowColors.foregroundClassName
              : rowAppearance.foregroundClassName,
          )}
          numberOfLines={2}
          onTextLayout={
            Platform.OS === "android"
              ? ({ nativeEvent }) => {
                  const firstLine = nativeEvent.lines[0];
                  if (firstLine && Math.abs(firstLine.height - titleLineHeight) > 0.5) {
                    setTitleLineHeight(firstLine.height);
                  }
                }
              : undefined
          }
        >
          {pendingTask.title}
        </Text>
        {isDraft ? (
          <View className="flex-row items-center gap-1" style={{ minHeight: titleLineHeight }}>
            <SymbolView
              name="square.and.pencil"
              size={13}
              tintColorClassName={
                selected
                  ? selectedThreadRowColors.iconTintClassName
                  : "accent-adaptive-amber-700-300"
              }
              type="monochrome"
              weight="semibold"
            />
            <Text
              className={cn(
                "text-xs font-t3-bold",
                selected
                  ? selectedThreadRowColors.foregroundClassName
                  : "text-adaptive-amber-700-300",
              )}
            >
              <T>Draft</T>
            </Text>
          </View>
        ) : null}
      </View>
      {!isDraft ? (
        <View className="mt-1" style={{ paddingLeft: titleTextInset }}>
          <Text
            className={cn(
              "text-xs",
              selected
                ? selectedThreadRowColors.foregroundClassName
                : rowAppearance.tertiaryForegroundClassName,
            )}
          >
            <T>Sends on reconnect</T>
          </Text>
        </View>
      ) : null}
      {branch || props.environmentLabel ? (
        <View className="mt-1 flex-row items-center gap-1" style={{ paddingLeft: titleTextInset }}>
          {props.environmentLabel && props.environmentMachine ? (
            <EnvironmentMachineSymbol
              kind={props.environmentMachine}
              size={machineIconSize}
              tintColorClassName={
                selected
                  ? selectedThreadRowColors.mutedIconTintClassName
                  : rowAppearance.tertiaryIconTintClassName
              }
            />
          ) : null}
          <Text
            className={cn(
              "shrink text-xs text-foreground-muted",
              selected
                ? selectedThreadRowColors.mutedForegroundClassName
                : rowAppearance.mutedForegroundClassName,
            )}
            numberOfLines={1}
          >
            {branch ? (
              <Text
                className={cn(
                  "text-xs",
                  selected
                    ? selectedThreadRowColors.mutedForegroundClassName
                    : rowAppearance.mutedForegroundClassName,
                )}
                style={{ fontFamily: MONO_FONT }}
              >
                {branch}
              </Text>
            ) : null}
            {branch && props.environmentLabel ? "  ·  " : null}
            {props.environmentLabel ? (
              <Text
                className={cn(
                  "text-xs",
                  selected
                    ? selectedThreadRowColors.mutedForegroundClassName
                    : rowAppearance.tertiaryForegroundClassName,
                )}
              >
                {props.environmentLabel}
              </Text>
            ) : null}
          </Text>
        </View>
      ) : null}
    </>
  );

  return (
    <>
      {props.showPendingDivider ? (
        <ThreadListV2SectionDivider
          label={gt("Unsent", { $context: "section of tasks not yet sent" })}
          pane={props.pane}
        />
      ) : null}
      <ThreadSwipeable
        dormant={dormant}
        threadKey={pendingTask.key}
        backgroundColor={rowAppearance.swipeBackgroundColor}
        containerStyle={rowAppearance.swipeContainerStyle}
        enableTrackpadSwipe
        fullSwipeAction="primary"
        fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
        listAnimatesLayout
        onDelete={handleDelete}
        onSwipeableClose={props.onSwipeableClose}
        onSwipeableWillOpen={props.onSwipeableWillOpen}
        primaryAction={deleteAction}
        secondaryAction={null}
        resetKey={pendingTask.key}
        simultaneousWith={props.simultaneousSwipeGesture}
        threadTitle={pendingTask.title}
      >
        {() => (
          <Menu
            actions={(isDraft ? DRAFT_TASK_MENU_ACTIONS : PENDING_TASK_MENU_ACTIONS).map(
              (action) => ({
                ...action,
                title: m(action.title),
              }),
            )}
            onPressAction={handleMenuAction}
            shouldOpenOnLongPress
          >
            <RowPressable
              accessibilityHint={
                isDraft
                  ? gt("Opens the draft in the new task composer. Swipe left to discard.")
                  : gt(
                      "Sends when the environment reconnects. Opens the task for editing. Swipe left to delete.",
                    )
              }
              accessibilityLabel={pendingTask.title}
              accessibilityRole="button"
              accessibilityState={{ selected: props.selected ?? false }}
              key={pendingTask.key}
              className={rowAppearance.className}
              interactionClassName={rowAppearance.interactionClassName}
              interactionOpacity={rowAppearance.interactionOpacity}
              onPress={() => onSelectPendingTask(pendingTask)}
              style={rowAppearance.cardStyle}
            >
              {sidebarPane ? (
                rowContent
              ) : (
                <View>
                  <View className={THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME}>{rowContent}</View>
                  {THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider !== false ? (
                    <View className="ml-5 h-px bg-border-subtle" />
                  ) : null}
                </View>
              )}
            </RowPressable>
          </Menu>
        )}
      </ThreadSwipeable>
    </>
  );
});

function sectionIndent(depth: number) {
  return Math.min(depth, 3) * 10;
}

export function ThreadListV2ProjectSectionHeader({
  item,
  onToggle,
}: {
  readonly item: ThreadListV2ProjectSectionItem;
  readonly onToggle: (key: string, expanded: boolean | null) => void;
}) {
  const registry = useContext(RegistryContext);
  const update = useAtomCommand(serverEnvironment.updateSidebarLayout);
  const gt = useGT();
  const toggle = async () => {
    const { environmentId } = item;
    const record = AsyncResult.getOrElse(
      registry.get(serverEnvironment.sidebarLayout({ environmentId, input: {} })),
      () => null,
    );
    if (
      !record ||
      !registry.get(serverEnvironment.updateSidebarLayout.permissionAtom(environmentId))
    ) {
      onToggle(item.key, item.expanded);
      return;
    }
    const result = await update({
      environmentId,
      input: {
        revision: record.revision,
        mutation: { type: "collapse", sectionId: item.sectionId, collapsed: item.expanded },
      },
    });
    if (result._tag === "Success") onToggle(item.key, null);
    if (result._tag === "Failure") {
      Dialog.alert(gt("Could not save sidebar layout. Try again."));
    }
  };
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityState={{ expanded: item.expanded }}
      onPress={() => void toggle()}
      className="mt-2 min-h-11 flex-row items-center gap-2 pe-3"
      style={{ paddingStart: 12 + sectionIndent(item.depth) }}
    >
      <SymbolView
        name={item.expanded ? "folder.open" : "folder.fill"}
        size={18}
        tintColorClassName="foreground-muted"
      />
      <Text className="min-w-0 flex-1 text-sm font-t3-medium" numberOfLines={1}>
        {item.title}
      </Text>
      <SymbolView
        name={item.expanded ? "chevron.down" : "chevron.right"}
        size={12}
        tintColorClassName="foreground-muted"
      />
    </RowPressable>
  );
}

export function ThreadListV2ProjectFolderHeader({
  item,
  onToggle,
  onNewThread,
}: {
  readonly item: ThreadListV2ProjectFolderItem;
  readonly onToggle: (key: string, expanded: boolean) => void;
  readonly onNewThread: (project: EnvironmentProject) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const summary = item.expanded ? "" : formatSidebarAgentStates(item.counts, m, true).text;
  const { project } = item;

  return (
    <View
      className="mt-2 flex-row items-center"
      style={{ paddingStart: sectionIndent(item.depth) }}
    >
      <RowPressable
        accessibilityRole="button"
        accessibilityState={{ expanded: item.expanded }}
        onPress={() => onToggle(item.key, item.expanded)}
        className="min-h-11 flex-1 flex-row items-center gap-2 px-3"
      >
        <ProjectFavicon
          environmentId={project.environmentId}
          faviconPath={project.faviconPath}
          projectIcon={project.projectIcon}
          projectTitle={item.title}
          workspaceRoot={project.workspaceRoot}
          open={item.expanded}
          size={18}
        />
        <Text className="min-w-0 flex-1 text-sm font-t3-medium" numberOfLines={1}>
          {item.title}
        </Text>
        {!item.expanded && item.total > 0 ? (
          <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
            {summary || item.total}
          </Text>
        ) : null}
        <SymbolView
          name={item.expanded ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="foreground-muted"
        />
      </RowPressable>
      <IconButton
        accessibilityLabel={gt("New thread in {project}", { project: item.title })}
        icon="square.and.pencil"
        onPress={() => onNewThread(project)}
      />
    </View>
  );
}

export function ThreadListV2AgentSectionHeader({
  item,
  onToggle,
  listVisible,
  sidebarPane = false,
}: {
  readonly item: ThreadListV2AgentSectionItem;
  readonly listVisible: boolean;
  readonly sidebarPane?: boolean;
  readonly onToggle: (key: string, expanded: boolean) => void;
}) {
  const m = useMessages();
  const { working, details } = formatSidebarAgentStates(item.counts, m);
  const [visible, setVisible] = useState(false);
  useViewability(useCallback((token) => setVisible(token.isViewable), []));
  const appActive = useAppActive();
  const focused = useIsFocused();
  const animate = visible && listVisible && appActive && (focused || sidebarPane);

  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityState={{ expanded: item.expanded }}
      onPress={() => onToggle(item.key, item.expanded)}
      className="min-h-11 flex-row items-center gap-2 pe-3"
      style={{ paddingStart: 24 + sectionIndent(item.depth) }}
    >
      <SymbolView
        name={item.expanded ? "chevron.down" : "chevron.right"}
        size={12}
        tintColorClassName="foreground-muted"
      />
      <Text className="min-w-0 shrink text-sm font-t3-medium" numberOfLines={1}>
        {m(
          item.role === undefined ? sidebarAgentsSectionLabel : sidebarRoleSectionLabels[item.role],
        )}
      </Text>
      <Text className="text-xs text-foreground-muted">{item.total}</Text>
      {working ? (
        <View
          accessible
          accessibilityLabel={working.label}
          className="shrink-0 flex-row items-center gap-1"
        >
          <ThreadRowSpinner animate={animate} tint={WORKING_STATUS_TINT} />
          <Text className="text-xs text-foreground-muted">{working.count}</Text>
        </View>
      ) : null}
      {working && details ? (
        <Text aria-hidden className="text-xs text-foreground-muted">
          ·
        </Text>
      ) : null}
      {details ? (
        <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
          {details}
        </Text>
      ) : null}
    </RowPressable>
  );
}

function ThreadSpeedBolt(props: { ultrafast: boolean; color: string; surface: string }) {
  const bolt =
    "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z";
  return (
    <Svg
      width={props.ultrafast ? 15 : 12}
      height={12}
      viewBox={props.ultrafast ? "0 0 30 24" : "0 0 24 24"}
      style={{ flexShrink: 0 }}
    >
      {props.ultrafast ? (
        <>
          <Path d={bolt} x={6} fill="none" stroke={props.color} strokeWidth={2} />
          <Path d={bolt} fill={props.surface} stroke={props.surface} strokeWidth={4} />
        </>
      ) : null}
      <Path d={bolt} fill={props.color} />
    </Svg>
  );
}

export const ThreadListV2Row = memo(function ThreadListV2Row(props: {
  readonly thread: EnvironmentThreadShell;
  readonly agentCount: number;
  readonly familyExpanded?: boolean | undefined;
  readonly onToggleFamily: (key: string, expanded: boolean) => void;
  readonly agentRow: boolean;
  readonly depth?: number;
  readonly listVisible: boolean;
  readonly variant: "card" | "slim";
  readonly hasQueuedMessages?: boolean;
  readonly snoozed?: boolean;
  readonly pinned?: boolean;
  readonly wokeAt: string | null;
  readonly snoozeWakeLabelText?: string;
  readonly timeLabel: string;
  readonly snoozePresetMinute: string;
  readonly project: EnvironmentProject | null;
  readonly providers: ReadonlyArray<ThreadListProvider> | undefined;
  readonly providerInstance: ThreadRowProviderInstance | null;
  readonly environmentLabel: string | null;
  readonly environmentMachine?: EnvironmentMachineKind;
  readonly pane?: "screen" | "sidebar";
  readonly showTrailingDivider?: boolean;
  readonly selected?: boolean;
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onOpenThreadPullRequests: (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onRenameThread: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => void;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => void;
  readonly onSetThreadAutoSettle: (thread: EnvironmentThreadShell, enabled: boolean) => void;
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly snoozePresets: ReadonlyArray<SnoozePresetSetting> | undefined;
  readonly pinningSupported: boolean;
  readonly autoSettleOptOutSupported: boolean;
  readonly titleRegenerationSupported: boolean;
  readonly reorderSupported?: boolean;
  readonly onMoveThread?: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => void;
  readonly canMoveUp?: boolean;
  readonly canMoveDown?: boolean;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly activationKey?: string;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery?: string;
  readonly simultaneousSwipeGesture?: ComponentProps<typeof ThreadSwipeable>["simultaneousWith"];
}) {
  const { width: windowWidth } = useWindowDimensions();
  const gt = useGT();
  const m = useMessages();
  const {
    thread,
    variant,
    onSelectThread,
    onOpenThreadPullRequests,
    onDeleteThread,
    onRenameThread,
    onRegenerateThreadTitle,
    onNewThreadOnBranch,
    onSettleThread,
    onSnoozeThread,
    onUnsnoozeThread,
    onUnsettleThread,
    onArchiveThread,
    onPinThread,
    onUnpinThread,
    onSetThreadAutoSettle,
    onMoveThread,
  } = props;
  const snoozedRow = props.snoozed === true;
  const pinnedRow = props.pinned === true;
  const dormant = useSwipeRowDormant(props.activationKey);

  const selectThread = () => onSelectThread(thread);
  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const provider = props.providers?.find((candidate) => candidate.instanceId === modelInstanceId);
  const providerIconUrl = provider?.iconUrl;
  const driver =
    props.providerInstance?.driverKind ??
    (isProviderDriverKind(modelInstanceId) ? modelInstanceId : null);
  const codexDefaultSpeed = useAtomValue(
    serverEnvironment.settingsValueAtom(thread.environmentId),
    (settings) => sidebarCodexDefaultSpeed(settings, thread.modelSelection, driver),
  );
  const { modelParts, effort, speed } = sidebarRowModel(
    thread.modelSelection,
    provider?.models?.find((model) => model.slug === thread.modelSelection.model),
    driver,
    codexDefaultSpeed,
  );
  const speedLabel =
    speed === "ultrafast" ? gt("Ultrafast mode on") : speed === "fast" ? gt("Fast mode on") : null;
  const role = thread.delegatedRole;
  const rowTitle =
    props.agentRow || !isDelegationModelRole(role) ? thread.title : m(sidebarRoleLabels[role]);
  const [visible, setVisible] = useState(false);
  useViewability(useCallback((token) => setVisible(token.isViewable), []));
  const appActive = useAppActive();
  const focused = useIsFocused();
  const providerInstance = props.providerInstance;
  const providerNameLabel = providerInstance
    ? providerInstanceNameLabel({
        provider: providerInstance.driverKind,
        iconUrl: providerIconUrl,
        displayName: providerInstance.displayName,
        showBadge: providerInstance.showBadge,
      })
    : null;
  const pr = useThreadPr(thread);
  const prBadgeLabel = pr ? resolveThreadPrBadgeAction(pr, m).accessibilityLabel : null;
  const handleOpenPullRequests = useCallback(() => {
    if (pr) onOpenThreadPullRequests(thread, pr);
  }, [onOpenThreadPullRequests, pr, thread]);

  const theme = useUniwindTheme();
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;
  const rowAppearance = getThreadListV2RowAppearance(theme, sidebarPane, selected);

  const status = resolveThreadListV2RowStatus(thread);
  const isUnread = status === "ready" && threadHasUnseenCompletion(thread);
  const workingLabel = STATUS_LABEL_BY_STATUS[status];
  const showsWoke = status === "ready" && props.wokeAt !== null;
  const statusEntry =
    (status === "working" && workingLabel !== undefined && thread.goal?.status === "active"
      ? {
          ...workingLabel,
          label: msg("Goal", { $context: "thread status, working toward a goal" }),
        }
      : workingLabel) ?? (isUnread ? DONE_STATUS_LABEL : undefined);
  const statusLabel = statusEntry && {
    ...statusEntry,
    label: statusEntry.label === null ? null : m(statusEntry.label),
  };
  const recede = shouldRecedeSidebarThread({
    status,
    isActive: selected,
    isSelected: selected,
    isUnread: threadHasUnseenCompletion(thread),
    isWoke: props.wokeAt !== null,
    isSubagent: props.agentRow || thread.lineage.relationshipToParent === "subagent",
  });
  const agentCountLabel =
    props.agentCount > 0
      ? gt("{count, plural, one {{count} agent} other {{count} agents}}", {
          count: props.agentCount,
        })
      : null;
  const pendingSync = useAtomValue(
    threadEnvironment.pendingSyncAtom(thread.environmentId),
    (threads) => threads.has(thread.id),
  );
  const isRegeneratingTitle = thread.titleRegeneration != null;
  // List items keep marked text so they stay the same objects across a language switch.
  const timeLabel = pendingSync ? gt("Waiting to sync") : props.timeLabel && m(props.timeLabel);
  const snoozeWakeLabelText =
    props.snoozeWakeLabelText === undefined ? undefined : m(props.snoozeWakeLabelText);
  const rowAccessibilityLabel = threadListV2RowAccessibilityLabel(
    {
      title: thread.title,
      variant,
      woke: showsWoke,
      // Working and waiting rows show only an icon and a duration, so name them for speech.
      statusLabel:
        statusLabel &&
        (statusLabel.label ??
          (status === "waiting"
            ? gt("Waiting", { $context: "thread status" })
            : gt("Working", { $context: "thread status" }))),
      timeLabel,
      snoozeWakeLabel: snoozedRow && !pendingSync ? snoozeWakeLabelText : undefined,
      providerNameLabel,
      hasQueuedMessages: props.hasQueuedMessages === true,
      regeneratingTitle: isRegeneratingTitle,
    },
    m,
  );

  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const markThreadUnread = useAtomCommand(threadEnvironment.markUnread, { reportFailure: false });
  const handleAcknowledgeWoke = useCallback(() => {
    if (props.wokeAt === null) return;
    void visitThread({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, visitedAt: props.wokeAt },
    });
  }, [props.wokeAt, thread.environmentId, thread.id, visitThread]);
  // VoiceOver cannot focus buttons inside the accessible row.
  const rowAccessibilityActions = useMemo(
    () => [
      ...(prBadgeLabel ? [{ name: "openPullRequests", label: prBadgeLabel }] : []),
      ...(showsWoke ? [{ name: "dismissWoke", label: gt("Dismiss Woke notification") }] : []),
    ],
    [gt, prBadgeLabel, showsWoke],
  );

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleRename = useCallback(() => onRenameThread(thread), [onRenameThread, thread]);
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  // Until the host answers, only settle, snooze and their undo are offered: they can queue.
  const triageOnly =
    !useEnvironmentScopeDenied(thread.environmentId, AuthOrchestrationOperateScope) &&
    !canOperateThread;
  const canShareWithGuest = useCanShareWithGuest(thread.environmentId);
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const successorThreadId = thread.source.successorThreadId;
  const threshold = useAtomValue(
    serverEnvironment.threadRetirementThresholdAtom(thread.environmentId),
  );
  const canStartFreshHere =
    threshold !== null &&
    canOperateThread &&
    !props.hasQueuedMessages &&
    canStartFresh(thread.source);
  const startFresh = useAtomCommand(orchestrationEnvironment.startFresh, { reportFailure: false });
  const handleStartFresh = useCallback(async () => {
    const result = await startFresh({
      environmentId: thread.environmentId,
      input: { threadId: thread.id },
    });
    if (result._tag === "Success") {
      selectDetail({
        name: "Thread",
        params: { environmentId: thread.environmentId, threadId: result.value.successorThreadId },
      });
    } else if (!isAtomCommandInterrupted(result)) {
      Dialog.alert(gt("Could not start fresh"));
    }
  }, [gt, selectDetail, startFresh, thread.environmentId, thread.id]);
  const handleRegenerateTitle = useCallback(
    () => onRegenerateThreadTitle(thread),
    [onRegenerateThreadTitle, thread],
  );
  const handleSettle = useCallback(() => onSettleThread(thread), [onSettleThread, thread]);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  // Recycling changes identity without remounting; clear local UI directly because equality may skip the render closure.
  const rowIdentity = `${thread.environmentId}:${thread.id}`;
  const [boundIdentity, setBoundIdentity] = useState(rowIdentity);
  if (boundIdentity !== rowIdentity) {
    setBoundIdentity(rowIdentity);
    setCustomSnoozeOpen(false);
  }
  const handleSnooze = useCallback(
    (snoozedUntil: string) => onSnoozeThread(thread, snoozedUntil),
    [onSnoozeThread, thread],
  );
  const handleUnsnooze = useCallback(() => onUnsnoozeThread(thread), [onUnsnoozeThread, thread]);
  const handleUnsettle = useCallback(() => onUnsettleThread(thread), [onUnsettleThread, thread]);
  const handlePin = useCallback(() => onPinThread(thread), [onPinThread, thread]);
  const handleUnpin = useCallback(() => onUnpinThread(thread), [onUnpinThread, thread]);
  const handleSetAutoSettle = useCallback(
    (enabled: boolean) => onSetThreadAutoSettle(thread, enabled),
    [onSetThreadAutoSettle, thread],
  );
  const handleMoveUp = useCallback(() => onMoveThread?.(thread, "up"), [onMoveThread, thread]);
  const handleMoveDown = useCallback(() => onMoveThread?.(thread, "down"), [onMoveThread, thread]);
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);

  const canUnsettle = variant === "slim";
  // The gate's only time-dependent edge is the queued-turn grace window, so its
  // expiry is known without a clock: evaluate at the message's own timestamp.
  // A gate held by runtime status has no expiry, and no clock tick opens it.
  const snoozeGateExpiryMs = props.snoozeSupported
    ? resolveThreadListV2SnoozeGateExpiryMs(thread, { now: thread.latestUserMessageAt ?? "" })
    : null;
  // The window is inclusive, so wake just past it.
  const snoozeGateNowMs = useNowAfter(snoozeGateExpiryMs === null ? null : snoozeGateExpiryMs + 1);
  const snoozeGateNow = new Date(snoozeGateNowMs).toISOString();
  const swipeActions = resolveThreadListV2SwipeActions({
    variant,
    settlementSupported: props.settlementSupported,
    snoozeSupported: props.snoozeSupported,
    snoozable: canSnooze(thread, { now: snoozeGateNow }),
    snoozed: snoozedRow,
  });
  const snoozePresets = resolveThreadListV2SnoozePresets(
    {
      secondary: swipeActions.secondary,
      now: props.snoozePresetMinute || snoozeGateNow,
      presets: props.snoozePresets,
    },
    m,
  );
  const snoozePresetActions = useMemo<MenuAction[]>(
    () => [
      ...snoozePresets.map((preset) => ({
        id: `snooze:${preset.id}`,
        title: preset.label,
        subtitle: preset.whenLabel,
      })),
      { id: "snooze:custom", title: gt("Custom…", { $context: "custom snooze time" }) },
    ],
    [gt, snoozePresets],
  );
  const reorderMenuItems = useMemo<MenuAction[]>(
    () => [
      ...(!props.agentRow && (props.pinningSupported || props.reorderSupported)
        ? [{ id: "arrange", title: gt("Arrange threads…"), image: "line.3.horizontal" }]
        : []),
      ...(props.reorderSupported === true
        ? [
            {
              id: "move-up",
              title: gt("Move up"),
              image: "arrow.up",
              attributes: { disabled: props.canMoveUp !== true },
            } satisfies MenuAction,
            {
              id: "move-down",
              title: gt("Move down"),
              image: "arrow.down",
              attributes: { disabled: props.canMoveDown !== true },
            } satisfies MenuAction,
          ]
        : []),
    ],
    [
      gt,
      props.agentRow,
      props.canMoveDown,
      props.canMoveUp,
      props.pinningSupported,
      props.reorderSupported,
    ],
  );
  const pinMenuItems = useMemo<MenuAction[]>(
    () =>
      props.pinningSupported
        ? [
            thread.pinnedAt != null
              ? {
                  id: "unpin",
                  title: gt("Unpin", { $context: "verb, thread action" }),
                  image: "pin.slash",
                }
              : { id: "pin", title: gt("Pin", { $context: "verb, thread action" }), image: "pin" },
          ]
        : [],
    [gt, props.pinningSupported, thread.pinnedAt],
  );
  const autoSettleMenuItems = useMemo<MenuAction[]>(
    () =>
      props.autoSettleOptOutSupported
        ? [
            {
              id: "auto-settle",
              title: gt("Auto-settle behavior"),
              image: "timer",
              subactions: [
                {
                  id: "auto-settle:enabled",
                  title: gt("Follow settings"),
                  state: thread.autoSettleDisabledAt == null ? "on" : "off",
                },
                {
                  id: "auto-settle:disabled",
                  title: gt("Never", { $context: "never auto-settle this thread" }),
                  state: thread.autoSettleDisabledAt == null ? "off" : "on",
                },
              ],
            } satisfies MenuAction,
          ]
        : [],
    [gt, props.autoSettleOptOutSupported, thread.autoSettleDisabledAt],
  );
  const canTurnIntoProject = canTurnThreadIntoProject(thread);
  const titleMenuItems = useMemo<MenuAction[]>(
    () => [
      {
        id: "rename",
        title: gt("Rename", { $context: "verb, thread action" }),
        image: "square.and.pencil",
      },
      ...buildThreadTitleRegenerationMenuItems(
        {
          supported: props.titleRegenerationSupported,
          isRegenerating: isRegeneratingTitle,
        },
        m,
      ),
      ...(thread.latestRun?.completedAt != null && threadCanArchive(thread.runtime)
        ? [{ id: "mark-unread", title: gt("Mark unread"), image: "envelope.badge" }]
        : []),
      ...(canTurnIntoProject
        ? [
            {
              id: "turn-into-project",
              title: gt("Turn into project"),
              image: "folder.badge.plus",
              attributes: { disabled: !threadCanArchive(thread.runtime) },
            } satisfies MenuAction,
          ]
        : []),
    ],
    [
      canTurnIntoProject,
      gt,
      m,
      props.titleRegenerationSupported,
      thread.latestRun,
      thread.runtime,
      isRegeneratingTitle,
    ],
  );
  const menuActions = useMemo<MenuAction[]>(() => {
    const nested = Platform.OS === "ios";
    const localized = (action: MenuAction): MenuAction => ({ ...action, title: m(action.title) });
    const direct: MenuAction[] = [
      ...(successorThreadId === undefined
        ? []
        : [{ id: "open-successor", title: gt("Open successor"), image: "arrow.right.circle" }]),
      ...(canStartFreshHere
        ? [{ id: "start-fresh", title: gt("Start fresh"), image: "arrow.clockwise" }]
        : []),
      ...(thread.branch
        ? [
            {
              id: "new-thread-on-branch",
              title: getThreadListV2NewBranchMenuTitle(thread.branch, m),
              image: "square.and.pencil",
            },
          ]
        : []),
      { id: "copy-thread", title: gt("Copy thread"), image: "text.bubble" },
      { id: "copy-thread-id", title: gt("Copy thread ID"), image: "doc.on.doc" },
      ...(canShareWithGuest
        ? [{ id: "share-guest", title: gt("Share with guest"), image: "person.badge.plus" }]
        : []),
    ];
    if (snoozedRow) {
      return layoutThreadListV2RowMenuActions(
        {
          nested,
          direct: [...direct, localized(SNOOZED_MENU_ACTIONS[0]!)],
          reorder: [],
          pin: [],
          secondary: [
            ...titleMenuItems,
            ...autoSettleMenuItems,
            localized(LEGACY_MENU_ACTIONS[0]!),
            localized(SNOOZED_MENU_ACTIONS[1]!),
          ],
        },
        m,
      );
    }
    if (!props.settlementSupported) {
      return layoutThreadListV2RowMenuActions(
        {
          nested,
          direct: [...direct, localized(LEGACY_MENU_ACTIONS[0]!)],
          reorder: reorderMenuItems,
          pin: pinMenuItems,
          secondary: [...titleMenuItems, localized(LEGACY_MENU_ACTIONS[1]!)],
        },
        m,
      );
    }
    if (canUnsettle) {
      return layoutThreadListV2RowMenuActions(
        {
          nested,
          direct: [...direct, localized(SLIM_MENU_ACTIONS[0]!)],
          reorder: reorderMenuItems.filter(
            (action) => action.id !== "move-up" && action.id !== "move-down",
          ),
          pin: pinMenuItems,
          secondary: [
            ...titleMenuItems,
            ...autoSettleMenuItems,
            localized(LEGACY_MENU_ACTIONS[0]!),
            localized(SLIM_MENU_ACTIONS[1]!),
          ],
        },
        m,
      );
    }
    return layoutThreadListV2RowMenuActions(
      {
        nested,
        direct: [
          ...direct,
          localized(CARD_MENU_ACTIONS[0]!),
          ...(swipeActions.secondary === "snooze"
            ? [
                {
                  id: "snooze",
                  title: gt("Snooze", { $context: "verb, thread action" }),
                  image: "clock",
                  subactions: snoozePresetActions,
                },
              ]
            : []),
        ],
        reorder: reorderMenuItems,
        pin: pinMenuItems,
        secondary: [
          ...titleMenuItems,
          ...autoSettleMenuItems,
          localized(LEGACY_MENU_ACTIONS[0]!),
          localized(CARD_MENU_ACTIONS[1]!),
        ],
      },
      m,
    );
  }, [
    autoSettleMenuItems,
    canShareWithGuest,
    canStartFreshHere,
    canUnsettle,
    pinMenuItems,
    props.settlementSupported,
    reorderMenuItems,
    snoozePresetActions,
    snoozedRow,
    gt,
    m,
    swipeActions.secondary,
    successorThreadId,
    thread.branch,
    titleMenuItems,
  ]);
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "open-successor" && successorThreadId !== undefined)
        selectDetail({
          name: "Thread",
          params: { environmentId: thread.environmentId, threadId: successorThreadId },
        });
      if (nativeEvent.event === "start-fresh" && canStartFreshHere) void handleStartFresh();
      if (nativeEvent.event === "new-thread-on-branch") onNewThreadOnBranch(thread);
      if (nativeEvent.event === "settle") handleSettle();
      if (nativeEvent.event === "unsettle") handleUnsettle();
      if (nativeEvent.event === "unsnooze") handleUnsnooze();
      if (nativeEvent.event === "pin") handlePin();
      if (nativeEvent.event === "unpin") handleUnpin();
      if (nativeEvent.event === "auto-settle:enabled") handleSetAutoSettle(true);
      if (nativeEvent.event === "auto-settle:disabled") handleSetAutoSettle(false);
      if (nativeEvent.event === "arrange") appAtomRegistry.set(threadArrangementOpenAtom, true);
      if (nativeEvent.event === "move-up") handleMoveUp();
      if (nativeEvent.event === "move-down") handleMoveDown();
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "rename") handleRename();
      if (nativeEvent.event === "regenerate-title") handleRegenerateTitle();
      if (nativeEvent.event === "turn-into-project") void turnThreadIntoProject(thread);
      if (nativeEvent.event === "mark-unread") {
        void markThreadUnread({
          environmentId: thread.environmentId,
          input: { threadId: thread.id },
        });
      }
      if (nativeEvent.event === "copy-thread") {
        const target = threadChipCopyTarget(
          { environmentId: thread.environmentId, threadId: thread.id },
          thread.title,
          undefined,
          m,
        );
        void copyThreadReference(target).then((didCopy) => {
          if (!didCopy) Dialog.alert(target.failureTitle, gt("Try copying this thread again."));
        });
      }
      if (nativeEvent.event === "copy-thread-id") {
        copyTextWithHaptic(thread.id, { target: "thread-id" });
      }
      if (nativeEvent.event === "share-guest") {
        navigation.navigate("ThreadGuestShare", {
          environmentId: thread.environmentId,
          threadId: thread.id,
        });
      }
      if (nativeEvent.event === "delete") handleDelete();
      if (nativeEvent.event === "snooze:custom") {
        setCustomSnoozeOpen(true);
        return;
      }
      const snoozeSelection = resolveThreadListV2SnoozeMenuSelection({
        event: nativeEvent.event,
        displayedPresets: snoozePresets,
        now: new Date(),
        presets: props.snoozePresets,
      });
      if (snoozeSelection._tag === "selected") {
        handleSnooze(snoozeSelection.preset.snoozedUntil);
      } else if (snoozeSelection._tag === "expired") {
        Dialog.alert(
          gt("Could not snooze thread"),
          gt("That snooze time has passed. Choose another time."),
        );
      }
    },
    [
      gt,
      m,
      onNewThreadOnBranch,
      thread,
      navigation,
      selectDetail,
      successorThreadId,
      canStartFreshHere,
      handleStartFresh,
      handleArchive,
      handleDelete,
      handleRegenerateTitle,
      handleRename,
      handleMoveDown,
      handleMoveUp,
      handlePin,
      handleSettle,
      handleSnooze,
      handleSetAutoSettle,
      handleUnpin,
      handleUnsettle,
      handleUnsnooze,
      markThreadUnread,
      setCustomSnoozeOpen,
      snoozePresets,
      props.snoozePresets,
    ],
  );
  const primaryAction = useMemo(() => {
    if (swipeActions.primary === "archive") {
      return {
        accessibilityLabel: gt("Archive {title}", { title: thread.title }),
        icon: "archivebox" as const,
        label: gt("Archive", { $context: "verb, thread action" }),
        swipeHint: gt("Opens the thread. Swipe left to archive."),
        swipeSnoozeHint: gt("Opens the thread. Swipe left for archive and snooze actions."),
        onPress: handleArchive,
      };
    }
    if (swipeActions.primary === "unsnooze") {
      return {
        accessibilityLabel: gt("Wake {title} now", { title: thread.title }),
        icon: "clock" as const,
        label: gt("Wake", { $context: "verb, thread action" }),
        swipeHint: gt("Opens the thread. Swipe left to wake."),
        swipeSnoozeHint: gt("Opens the thread. Swipe left for wake and snooze actions."),
        onPress: handleUnsnooze,
      };
    }
    return swipeActions.primary === "unsettle"
      ? {
          accessibilityLabel: gt("Un-settle {title}", { title: thread.title }),
          icon: "arrow.uturn.backward" as const,
          label: gt("Un-settle", { $context: "verb, thread action" }),
          swipeHint: gt("Opens the thread. Swipe left to un-settle."),
          swipeSnoozeHint: gt("Opens the thread. Swipe left for un-settle and snooze actions."),
          onPress: handleUnsettle,
        }
      : {
          accessibilityLabel: gt("Settle {title}", { title: thread.title }),
          icon: "checkmark" as const,
          label: gt("Settle", { $context: "verb, thread action" }),
          swipeHint: gt("Opens the thread. Swipe left to settle."),
          swipeSnoozeHint: gt("Opens the thread. Swipe left for settle and snooze actions."),
          onPress: handleSettle,
        };
  }, [
    gt,
    handleArchive,
    handleSettle,
    handleUnsettle,
    handleUnsnooze,
    swipeActions.primary,
    thread.title,
  ]);
  const secondaryAction = useMemo(
    () =>
      swipeActions.secondary === "snooze"
        ? {
            accessibilityLabel: gt("Choose when to snooze {title}", { title: thread.title }),
            icon: "clock" as const,
            label: gt("Snooze", { $context: "verb, thread action" }),
            menu: {
              actions: snoozePresetActions,
              onPressAction: handleMenuAction,
              title: gt("Snooze until"),
            },
            onPress: () => undefined,
          }
        : null,
    [gt, handleMenuAction, snoozePresetActions, swipeActions.secondary, thread.title],
  );
  const canSwipe =
    canOperateThread || (triageOnly && TRIAGE_MENU_ACTION_IDS.has(swipeActions.primary));
  const swipeAccessibilityHint = !canSwipe
    ? gt("Opens the thread")
    : secondaryAction === null
      ? primaryAction.swipeHint
      : primaryAction.swipeSnoozeHint;

  const rowVisible = visible && props.listVisible && appActive && (focused || sidebarPane);
  const live = status === "working" || status === "waiting";
  const completedAt = live ? null : (thread.latestRun?.completedAt ?? null);
  const startedAt = live
    ? resolveThreadWorkingStartedAt(thread)
    : completedAt === null
      ? null
      : (thread.latestRun?.startedAt ?? null);
  const muted = selected
    ? selectedThreadRowColors.mutedForegroundClassName
    : rowAppearance.mutedForegroundClassName;
  const statusTint = selected
    ? selectedThreadRowColors.iconTintClassName
    : (statusLabel?.iconTintClassName ?? rowAppearance.mutedIconTintClassName);
  const issue = thread.issues?.[0];
  const issueCount = thread.issues?.length ?? 0;

  const lifeRing = threshold === null ? null : threadLifeRing(thread.source, threshold);
  const lifeColor = lifeRing?.warning === true ? "#d97706" : "#787882";
  const retiringLabel =
    thread.source.retiringWorkerCount === undefined
      ? null
      : gt(
          "{count, plural, one {Retiring · {count} agent running} other {Retiring · {count} agents running}}",
          { count: thread.source.retiringWorkerCount ?? 0 },
        );

  const rowContent = (close: () => void) => (
    <RowPressable
      key={`${thread.environmentId}:${thread.id}`}
      interactionClassName={rowAppearance.interactionClassName}
      interactionOpacity={rowAppearance.interactionOpacity}
      className={rowAppearance.className}
      accessibilityHint={swipeAccessibilityHint}
      accessibilityLabel={[rowAccessibilityLabel, agentCountLabel, retiringLabel, speedLabel]
        .filter(Boolean)
        .join(", ")}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityActions={rowAccessibilityActions}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "openPullRequests") handleOpenPullRequests();
        if (event.nativeEvent.actionName === "dismissWoke") handleAcknowledgeWoke();
      }}
      onPress={() => {
        close();
        selectThread();
      }}
      style={rowAppearance.style}
    >
      <View className="px-3">
        <View
          className="min-h-11 flex-row items-center gap-1"
          style={{
            opacity: recede || retiringLabel !== null ? 0.65 : 1,
          }}
        >
          {lifeRing ? (
            <View
              className="shrink-0 flex-row items-center gap-0.5"
              accessibilityLabel={gt(
                "{count, plural, one {{count} compaction} other {{count} compactions}}",
                { count: lifeRing.count },
              )}
            >
              <Svg width={12} height={12} viewBox="0 0 12 12">
                <Circle
                  cx={6}
                  cy={6}
                  r={4.5}
                  stroke={lifeColor}
                  strokeOpacity={0.3}
                  strokeWidth={2}
                  fill="none"
                />
                <Circle
                  cx={6}
                  cy={6}
                  r={4.5}
                  stroke={lifeColor}
                  strokeWidth={2}
                  fill="none"
                  strokeDasharray={2 * Math.PI * 4.5}
                  strokeDashoffset={2 * Math.PI * 4.5 * (1 - lifeRing.fill / 100)}
                  rotation={-90}
                  origin="6, 6"
                />
              </Svg>
              <Text className="text-2xs tabular-nums" style={{ color: lifeColor }}>
                {lifeRing.count}
              </Text>
            </View>
          ) : null}
          {props.project ? (
            <ProjectFavicon
              environmentId={thread.environmentId}
              faviconPath={props.project.faviconPath}
              projectIcon={props.project.projectIcon}
              size={15}
              projectTitle={props.project.title}
              workspaceRoot={props.project.workspaceRoot}
            />
          ) : null}
          {driver ? (
            <ProviderInstanceIcon
              iconUrl={providerIconUrl}
              provider={driver}
              size={14}
              displayName={
                providerInstance?.displayName ?? thread.runtime?.providerName ?? modelInstanceId
              }
              accentColor={providerInstance?.accentColor}
              showBadge={providerInstance?.showBadge ?? false}
              surfaceColor={rowAppearance.providerIconSurfaceColor}
            />
          ) : (
            <SymbolView
              name="gearshape"
              size={14}
              tintColorClassName={rowAppearance.mutedIconTintClassName}
            />
          )}
          <Text className={cn("max-w-16 shrink text-2xs", muted)} numberOfLines={1}>
            {modelParts.name}
          </Text>
          {modelParts.version ? (
            <Text className={cn("shrink-0 text-2xs tabular-nums", muted)} numberOfLines={1}>
              {modelParts.version}
            </Text>
          ) : null}
          {effort ? (
            <View className="shrink-0 flex-row items-end gap-px" accessibilityLabel={effort.label}>
              {effortBarHeights(effort.count, 9).map((height, index) => (
                <View
                  key={height}
                  className="w-0.5 rounded-sm bg-foreground-muted"
                  style={{ height, opacity: index < effort.filled ? 1 : 0.4 }}
                />
              ))}
            </View>
          ) : null}
          {speed !== "standard" ? (
            <ThreadSpeedBolt
              ultrafast={speed === "ultrafast"}
              color={theme["--color-foreground-muted"]}
              surface={rowAppearance.providerIconSurfaceColor}
            />
          ) : null}
          <View className="min-w-0 flex-1 flex-row items-center gap-1">
            <Text
              className={cn(
                "min-w-0 shrink text-sm font-t3-medium",
                selected
                  ? selectedThreadRowColors.foregroundClassName
                  : rowAppearance.foregroundClassName,
                isRegeneratingTitle && "opacity-55",
              )}
              numberOfLines={1}
            >
              {rowTitle}
            </Text>
            {pinnedRow ? (
              <SymbolView
                name="pin"
                size={11}
                tintColorClassName={rowAppearance.mutedIconTintClassName}
              />
            ) : null}
          </View>
          {retiringLabel === null ? null : (
            <Text className={cn("max-w-28 shrink text-2xs", muted)} numberOfLines={1}>
              {retiringLabel}
            </Text>
          )}
          {props.familyExpanded === undefined ? (
            agentCountLabel && (
              <Text className={cn("shrink-0 text-2xs", muted)}>{agentCountLabel}</Text>
            )
          ) : (
            <Pressable
              className="min-h-11 shrink-0 flex-row items-center gap-1"
              accessibilityRole="button"
              accessibilityLabel={agentCountLabel ?? undefined}
              accessibilityState={{ expanded: props.familyExpanded }}
              onPress={(event) => {
                event.stopPropagation();
                props.onToggleFamily(
                  `${thread.environmentId}:${thread.id}`,
                  props.familyExpanded === true,
                );
              }}
            >
              <Text className={cn("text-2xs", muted)}>{agentCountLabel}</Text>
              <SymbolView
                name={props.familyExpanded ? "chevron.down" : "chevron.right"}
                size={10}
                tintColorClassName="foreground-muted"
              />
            </Pressable>
          )}
          {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
          {issue ? (
            <View className="shrink-0 flex-row items-center gap-0.5">
              <SymbolView
                name="circle.dashed"
                size={11}
                tintColorClassName={rowAppearance.mutedIconTintClassName}
              />
              <Text className={cn("text-2xs tabular-nums", muted)}>
                {issueCount > 1 ? issueCount : issue.displayKey.replace(/^#/, "")}
              </Text>
            </View>
          ) : null}
          {pr ? (
            <Pressable
              className="h-11 shrink-0 flex-row items-center gap-0.5"
              accessibilityRole="button"
              accessibilityLabel={prBadgeLabel ?? undefined}
              onPress={handleOpenPullRequests}
              onLongPress={() => undefined}
            >
              <SymbolView
                name={
                  pr.kind === "stack"
                    ? PullRequestGlyph.stack
                    : pr.state === null
                      ? PullRequestGlyph.pullRequest
                      : pullRequestStatus({ state: pr.state, isDraft: pr.isDraft }).icon
                }
                size={12}
                tintColorClassName={rowAppearance.mutedIconTintClassName}
              />
              <Text className={cn("text-2xs tabular-nums", pr.textClassName)}>{pr.label}</Text>
            </Pressable>
          ) : null}
          <Text className={cn("shrink-0 text-2xs tabular-nums", muted)} numberOfLines={1}>
            {!pendingSync && snoozedRow && snoozeWakeLabelText !== undefined ? (
              snoozeWakeLabelText
            ) : !pendingSync && startedAt ? (
              <ThreadListV2Duration
                environmentId={thread.environmentId}
                startedAt={startedAt}
                completedAt={completedAt}
                visible={rowVisible}
              />
            ) : (
              timeLabel
            )}
          </Text>
          {showsWoke ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Dismiss Woke notification")}
              onPress={handleAcknowledgeWoke}
              onLongPress={() => undefined}
              hitSlop={6}
            >
              <SymbolView
                name="bell.badge"
                size={13}
                tintColorClassName="accent-warning-foreground"
              />
            </Pressable>
          ) : status === "working" ? (
            <ThreadRowSpinner animate={rowVisible} tint={statusTint} />
          ) : isUnread ? (
            <View className="mx-0.5 size-2 shrink-0 rounded-full bg-adaptive-emerald-600-400" />
          ) : (
            <SymbolView
              name={statusLabel?.icon ?? "circle"}
              size={13}
              tintColorClassName={statusTint}
            />
          )}
        </View>
        {props.searchMatch ? (
          <ThreadSearchMatchExcerpt
            sidebar={sidebarPane}
            match={props.searchMatch}
            query={props.searchQuery ?? ""}
            selected={selected}
          />
        ) : null}
        {!sidebarPane && THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider !== false ? (
          <View className="ml-5 h-px bg-border-subtle" />
        ) : null}
      </View>
    </RowPressable>
  );

  const inset = sectionIndent(props.depth ?? 0);
  const indentation = inset > 0 ? { marginStart: inset } : undefined;
  if (!canSwipe)
    return (
      <View style={[rowAppearance.swipeContainerStyle, indentation]}>{rowContent(() => {})}</View>
    );

  return (
    <View collapsable={false} style={indentation}>
      {customSnoozeOpen && (
        <CustomSnoozeSheet onClose={() => setCustomSnoozeOpen(false)} onSnooze={handleSnooze} />
      )}
      <ThreadSwipeable
        dormant={dormant}
        threadKey={`${thread.environmentId}:${thread.id}`}
        backgroundColor={rowAppearance.swipeBackgroundColor}
        compactActions={variant === "slim"}
        containerStyle={rowAppearance.swipeContainerStyle}
        enableTrackpadSwipe
        fullSwipeAction="primary"
        fullSwipeWidth={(props.fullSwipeWidth ?? windowWidth - 32) - inset}
        listAnimatesLayout
        onDelete={handleDelete}
        onSwipeableClose={props.onSwipeableClose}
        onSwipeableWillOpen={props.onSwipeableWillOpen}
        primaryAction={primaryAction}
        secondaryAction={secondaryAction}
        resetKey={`${thread.environmentId}:${thread.id}:${variant}:${snoozedRow}:${thread.settledAt}:${thread.unsettledAt}:${thread.snoozedUntil}:${thread.pinnedAt}`}
        simultaneousWith={props.simultaneousSwipeGesture}
        threadTitle={thread.title}
      >
        {(close) => (
          <Menu
            accessibilityLabel={rowAccessibilityLabel}
            actions={
              triageOnly
                ? menuActions.filter((action) => TRIAGE_MENU_ACTION_IDS.has(action.id ?? ""))
                : menuActions
            }
            onPressAction={handleMenuAction}
            shouldOpenOnLongPress
          >
            {rowContent(close)}
          </Menu>
        )}
      </ThreadSwipeable>
    </View>
  );
});
