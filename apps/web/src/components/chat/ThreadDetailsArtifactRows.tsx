import { useAtomValue } from "@effect/atom-react";
import {
  defaultArtifactSection,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type ProjectArtifact,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  ChevronDownIcon,
  FolderInputIcon,
  PencilIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useId, useState } from "react";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { openFileInPreview } from "~/browser/openFileInPreview";
import { useTheme } from "~/hooks/useTheme";
import { useRightPanelStore } from "~/rightPanelStore";
import { projectArtifacts } from "~/state/projectArtifacts";
import { assetEnvironment } from "~/state/assets";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Input } from "../ui/input";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const CollapsedSections = Schema.Array(Schema.String);
const NO_COLLAPSED_SECTIONS: readonly string[] = [];
const HOVER_REVEAL =
  "flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100";

/** The server lists artifacts already grouped and in section order. */
function groupBySection(artifacts: readonly ProjectArtifact[]) {
  const sections: { name: string; artifacts: ProjectArtifact[] }[] = [];
  for (const artifact of artifacts) {
    const last = sections.at(-1);
    if (last?.name === artifact.section) last.artifacts.push(artifact);
    else sections.push({ name: artifact.section, artifacts: [artifact] });
  }
  return sections;
}

function SectionNameForm({
  label,
  initial,
  listId,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  listId: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="flex min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        const name = value.trim();
        if (name && name !== initial) onSubmit(name);
        else onCancel();
      }}
    >
      <Input
        size="sm"
        aria-label={label}
        list={listId}
        value={value}
        maxLength={100}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onBlur={onCancel}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      />
    </form>
  );
}

export function ThreadDetailsArtifactRows({
  environmentId,
  projectId,
  threadId,
  workspaceRoot,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  /** The thread's checkout; HTML inside it opens as a workspace page so its CSS and images load. */
  workspaceRoot: string | null;
}) {
  const target = { environmentId, input: { projectId } };
  const result = useAtomValue(projectArtifacts.live(target));
  const artifacts = Option.getOrNull(AsyncResult.value(result));
  const canAdd = useAtomValue(projectArtifacts.add.permissionAtom(environmentId));
  const canRemove = useAtomValue(projectArtifacts.remove.permissionAtom(environmentId));
  const canMove = useAtomValue(projectArtifacts.move.permissionAtom(environmentId));
  const canRename = useAtomValue(projectArtifacts.renameSection.permissionAtom(environmentId));
  const canReorder = useAtomValue(projectArtifacts.reorderSections.permissionAtom(environmentId));
  const add = useAtomCommand(projectArtifacts.add);
  const remove = useAtomCommand(projectArtifacts.remove);
  const move = useAtomCommand(projectArtifacts.move);
  const renameSection = useAtomCommand(projectArtifacts.renameSection);
  const reorderSections = useAtomCommand(projectArtifacts.reorderSections);
  const read = useAtomQueryRunner(projectArtifacts.list, { refresh: true });
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { refresh: true });
  const openPreview = useAtomCommand(previewEnvironment.open);
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const { resolvedTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  // Null follows the typed path's file type until the user edits the section.
  const [section, setSection] = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useLocalStorage(
    `t3code:artifact-sections-collapsed:${environmentId}:${projectId}`,
    NO_COLLAPSED_SECTIONS,
    CollapsedSections,
  );
  const [renaming, setRenaming] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const sectionListId = useId();
  const sections = groupBySection(artifacts ?? []);
  const sectionNames = sections.map((group) => group.name);
  const sectionValue = section ?? (path.trim() ? defaultArtifactSection(path.trim()) : "");
  const reorder = (index: number, offset: -1 | 1) => {
    const order = [...sectionNames];
    [order[index], order[index + offset]] = [order[index + offset]!, order[index]!];
    void reorderSections({ environmentId, input: { projectId, sections: order } });
  };
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [availability, setAvailability] = useState<ReadonlyMap<string, boolean>>(new Map());
  const open = async (artifact: ProjectArtifact) => {
    // Re-check on click: a build may have removed a file since the list arrived.
    const current = await read(target);
    if (current._tag !== "Success") return;
    const fresh = current.value.find((item) => item.id === artifact.id);
    if (!fresh?.available) {
      setAvailability((values) => new Map(values).set(artifact.id, false));
      return;
    }
    setAvailability((values) => new Map(values).set(artifact.id, true));
    const threadRef = scopeThreadRef(environmentId, threadId);
    // Only pages need hosting; the file viewer re-mints its link when a file changes, while a
    // browser tab keeps the link it opened with.
    if (/\.html?$/i.test(fresh.path)) {
      if (!httpBaseUrl) return;
      const opened = await openFileInPreview({
        threadRef,
        filePath: fresh.resolvedPath,
        workspaceRoot: workspaceRoot ?? undefined,
        httpBaseUrl,
        createAssetUrl,
        openPreview,
      });
      if (opened._tag === "Failure") setMessage("The artifact could not be opened in the browser.");
    } else {
      useRightPanelStore.getState().openFile(threadRef, fresh.resolvedPath);
    }
  };
  return (
    <ThreadDetailsSection
      headingId="thread-details-artifacts-heading"
      title="Artifacts"
      showHeading={false}
    >
      <div className="mb-1 flex min-h-8 items-center justify-between gap-2 px-1.5">
        <h3>
          <button
            type="button"
            aria-expanded={!collapsed}
            className="flex cursor-pointer items-center gap-1.5 rounded-sm text-2xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => setCollapsed(!collapsed)}
          >
            Artifacts {artifacts ? <span className="tabular-nums">{artifacts.length}</span> : null}
            <ChevronDownIcon aria-hidden className={`size-3${collapsed ? " -rotate-90" : ""}`} />
          </button>
        </h3>
        <Button
          variant="ghost-muted"
          size="xs"
          disabled={!canAdd}
          onClick={() => {
            setAdding(!adding);
            setCollapsed(false);
          }}
        >
          <PlusIcon aria-hidden className="size-3" /> Add
        </Button>
      </div>
      {!collapsed ? (
        <div className="flex flex-col gap-1">
          {adding ? (
            <form
              className="flex flex-col gap-2 p-1.5"
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy(true);
                setMessage(null);
                const saved = await add({
                  environmentId,
                  input: {
                    projectId,
                    path: path.trim(),
                    ...(label.trim() ? { label: label.trim() } : {}),
                    ...(sectionValue.trim() ? { section: sectionValue.trim() } : {}),
                  },
                }).finally(() => setBusy(false));
                if (saved._tag === "Success") {
                  setPath("");
                  setLabel("");
                  setSection(null);
                  setAdding(false);
                }
              }}
            >
              <Input
                size="sm"
                aria-label="Artifact file path"
                placeholder="Project-relative or absolute file path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                required
              />
              <Input
                size="sm"
                aria-label="Artifact label (optional)"
                placeholder="Label (optional)"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                maxLength={200}
              />
              <Input
                size="sm"
                aria-label="Artifact section"
                placeholder="Section"
                list={sectionListId}
                value={sectionValue}
                onChange={(event) => setSection(event.target.value)}
                maxLength={100}
              />
              <div className="flex gap-1">
                <Button size="xs" type="submit" disabled={busy || !canAdd || !path.trim()}>
                  Pin file
                </Button>
                <Button size="xs" variant="ghost-muted" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : null}
          <datalist id={sectionListId}>
            {sectionNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          {sections.map((group, index) => {
            const sectionCollapsed = collapsedSections.includes(group.name);
            return (
              <div key={group.name} className="flex flex-col gap-1">
                <div className="group flex min-h-7 min-w-0 items-center gap-1 px-1.5">
                  {renaming === group.name ? (
                    <SectionNameForm
                      label={`Rename section ${group.name}`}
                      initial={group.name}
                      listId={sectionListId}
                      onCancel={() => setRenaming(null)}
                      onSubmit={(to) => {
                        setRenaming(null);
                        setCollapsedSections((names) =>
                          names.map((name) => (name === group.name ? to : name)),
                        );
                        void renameSection({
                          environmentId,
                          input: { projectId, from: group.name, to },
                        });
                      }}
                    />
                  ) : (
                    <>
                      <h4 className="flex min-w-0 flex-1">
                        <button
                          type="button"
                          aria-expanded={!sectionCollapsed}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm px-1 py-1 text-left text-2xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          onClick={() =>
                            setCollapsedSections((names) =>
                              sectionCollapsed
                                ? names.filter((name) => name !== group.name)
                                : [...names, group.name],
                            )
                          }
                        >
                          <ChevronDownIcon
                            aria-hidden
                            className={`size-3 shrink-0${sectionCollapsed ? " -rotate-90" : ""}`}
                          />
                          <span className="min-w-0 truncate">{group.name}</span>
                          <span className="tabular-nums">{group.artifacts.length}</span>
                        </button>
                      </h4>
                      <div className={HOVER_REVEAL}>
                        <Button
                          variant="ghost-muted"
                          size="icon-xs"
                          disabled={!canReorder || index === 0}
                          aria-label={`Move section ${group.name} up`}
                          onClick={() => reorder(index, -1)}
                        >
                          <ArrowUpIcon aria-hidden className="size-3" />
                        </Button>
                        <Button
                          variant="ghost-muted"
                          size="icon-xs"
                          disabled={!canReorder || index === sections.length - 1}
                          aria-label={`Move section ${group.name} down`}
                          onClick={() => reorder(index, 1)}
                        >
                          <ArrowDownIcon aria-hidden className="size-3" />
                        </Button>
                        <Button
                          variant="ghost-muted"
                          size="icon-xs"
                          disabled={!canRename}
                          aria-label={`Rename section ${group.name}`}
                          onClick={() => setRenaming(group.name)}
                        >
                          <PencilIcon aria-hidden className="size-3" />
                        </Button>
                      </div>
                    </>
                  )}
                </div>
                {sectionCollapsed
                  ? null
                  : group.artifacts.map((artifact) => {
                      const missing = !(availability.get(artifact.id) ?? artifact.available);
                      return (
                        <Fragment key={artifact.id}>
                          <div className="flex min-w-0 items-center gap-1 px-1.5">
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <button
                                    type="button"
                                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm px-1 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                                    onClick={() => {
                                      void open(artifact);
                                    }}
                                  />
                                }
                              >
                                <PierreEntryIcon
                                  pathValue={artifact.path}
                                  kind="file"
                                  theme={resolvedTheme}
                                  className="size-3.5 shrink-0"
                                />
                                <span className="min-w-0 truncate">
                                  {artifact.label
                                    ? `${artifact.label} · ${artifact.name}`
                                    : artifact.name}
                                </span>
                                {missing ? (
                                  <span className="shrink-0 text-2xs text-muted-foreground">
                                    File missing
                                  </span>
                                ) : null}
                                {artifact.addedBy === "agent" ? (
                                  <span aria-label="Added by an agent">
                                    <BotIcon
                                      aria-hidden
                                      className="size-3 shrink-0 text-muted-foreground"
                                    />
                                  </span>
                                ) : null}
                              </TooltipTrigger>
                              <TooltipPopup>
                                {artifact.resolvedPath}
                                {artifact.addedBy === "agent" ? " · Added by an agent" : ""}
                              </TooltipPopup>
                            </Tooltip>
                            <Button
                              variant="ghost-muted"
                              size="icon-xs"
                              disabled={!canMove}
                              aria-label={`Move ${artifact.label ?? artifact.name} to another section`}
                              onClick={() => setMoving(moving === artifact.id ? null : artifact.id)}
                            >
                              <FolderInputIcon aria-hidden className="size-3" />
                            </Button>
                            <Button
                              variant="ghost-muted"
                              size="icon-xs"
                              disabled={!canRemove}
                              aria-label={`Remove ${artifact.label ?? artifact.name}`}
                              onClick={() => {
                                void remove({
                                  environmentId,
                                  input: { projectId, id: artifact.id },
                                });
                              }}
                            >
                              <XIcon aria-hidden className="size-3" />
                            </Button>
                          </div>
                          {moving === artifact.id ? (
                            <div className="flex px-1.5">
                              <SectionNameForm
                                label={`Section for ${artifact.label ?? artifact.name}`}
                                initial={artifact.section}
                                listId={sectionListId}
                                onCancel={() => setMoving(null)}
                                onSubmit={(name) => {
                                  setMoving(null);
                                  void move({
                                    environmentId,
                                    input: { projectId, id: artifact.id, section: name },
                                  });
                                }}
                              />
                            </div>
                          ) : null}
                        </Fragment>
                      );
                    })}
              </div>
            );
          })}
          {artifacts?.length === 0 ? (
            <p className="px-2.5 py-1.5 text-xs text-muted-foreground">
              Pin files used across this project.
            </p>
          ) : null}
          {result._tag === "Failure" ? (
            <p role="status" className="px-2.5 text-xs text-muted-foreground">
              Artifacts unavailable
            </p>
          ) : null}
          {message ? (
            <p role="status" className="px-2.5 text-xs text-muted-foreground">
              {message}
            </p>
          ) : null}
        </div>
      ) : null}
    </ThreadDetailsSection>
  );
}
