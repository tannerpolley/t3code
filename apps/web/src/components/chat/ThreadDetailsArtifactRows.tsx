import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ThreadId, ProjectArtifact } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { ChevronDownIcon, PlusIcon, XIcon, BotIcon } from "lucide-react";
import { useState } from "react";
import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
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

export function ThreadDetailsArtifactRows({
  environmentId,
  projectId,
  threadId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
}) {
  const target = { environmentId, input: { projectId } };
  const result = useAtomValue(projectArtifacts.live(target));
  const artifacts = Option.getOrNull(AsyncResult.value(result));
  const canAdd = useAtomValue(projectArtifacts.add.permissionAtom(environmentId));
  const canRemove = useAtomValue(projectArtifacts.remove.permissionAtom(environmentId));
  const add = useAtomCommand(projectArtifacts.add);
  const remove = useAtomCommand(projectArtifacts.remove);
  const read = useAtomQueryRunner(projectArtifacts.list, { refresh: true });
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { refresh: true });
  const openPreview = useAtomCommand(previewEnvironment.open);
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const { resolvedTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
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
    if (isBrowserPreviewFile(fresh.path)) {
      if (!httpBaseUrl) return;
      const opened = await openFileInPreview({
        threadRef,
        filePath: fresh.resolvedPath,
        workspaceRoot: undefined,
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
                try {
                  const saved = await add({
                    environmentId,
                    input: {
                      projectId,
                      path: path.trim(),
                      ...(label.trim() ? { label: label.trim() } : {}),
                    },
                  });
                  if (saved._tag === "Success") {
                    setPath("");
                    setLabel("");
                    setAdding(false);
                  }
                } finally {
                  setBusy(false);
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
          {artifacts?.map((artifact) => {
            const missing = !(availability.get(artifact.id) ?? artifact.available);
            return (
              <div key={artifact.id} className="flex min-w-0 items-center gap-1 px-1.5">
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
                      {artifact.label ? `${artifact.label} · ${artifact.name}` : artifact.name}
                    </span>
                    {missing ? (
                      <span className="shrink-0 text-2xs text-muted-foreground">File missing</span>
                    ) : null}
                    {artifact.addedBy === "agent" ? (
                      <span aria-label="Added by an agent">
                        <BotIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
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
                  disabled={!canRemove}
                  aria-label={`Remove ${artifact.label ?? artifact.name}`}
                  onClick={() => {
                    void remove({ environmentId, input: { projectId, id: artifact.id } });
                  }}
                >
                  <XIcon aria-hidden className="size-3" />
                </Button>
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
