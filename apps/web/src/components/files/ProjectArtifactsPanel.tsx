import { useAtomValue } from "@effect/atom-react";
import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  type ProjectArtifact,
  type ProjectId,
} from "@t3tools/contracts";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { useGT, useMessages } from "gt-react";
import { useRef, useState, type MouseEvent } from "react";

import { contextMenuSourceOf, openContextMenuFromKeyboard } from "~/contextMenuSource";
import { readLocalApi } from "~/localApi";
import { projectArtifacts } from "~/state/projectArtifacts";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useTheme } from "~/hooks/useTheme";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";

export function ProjectArtifactsPanel({
  environmentId,
  projectId,
  onOpenFile,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  onOpenFile: (path: string) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { resolvedTheme } = useTheme();
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canEdit = useAtomValue(projectArtifacts.update.permissionAtom(environmentId));
  const list = useEnvironmentQuery(
    canRead ? projectArtifacts.list({ environmentId, input: { projectId } }) : null,
    messages,
  );
  const update = useAtomCommand(projectArtifacts.update);
  const remove = useAtomCommand(projectArtifacts.remove);
  const [rename, setRename] = useState<{ id: string; value: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  const showMenu = async (event: MouseEvent<HTMLButtonElement>, artifact: ProjectArtifact) => {
    if (!canEdit) return;
    const api = readLocalApi();
    if (!api) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const action = await api.contextMenu.show(
      [
        { id: "rename", label: gt("Rename artifact") },
        { id: "remove", label: gt("Remove artifact") },
      ],
      event.clientX === 0 && event.clientY === 0
        ? { x: bounds.left, y: bounds.bottom }
        : { x: event.clientX, y: event.clientY },
      contextMenuSourceOf(event),
    );
    if (action === "rename") {
      setRename({ id: artifact.id, value: artifactName(artifact) });
    } else if (action === "remove") {
      await remove({ environmentId, input: { projectId, id: artifact.id } });
    }
  };

  const renameArtifact = async () => {
    if (!rename || saving) return;
    setSaving(true);
    const result = await update({
      environmentId,
      input: { projectId, id: rename.id, label: rename.value.trim() || null },
    });
    setSaving(false);
    if (result._tag === "Success") setRename(null);
  };

  return (
    <div className="h-full overflow-y-auto p-2">
      {!canRead ? (
        <p className="px-2 py-4 text-sm text-muted-foreground">{gt("File access is required.")}</p>
      ) : list.error !== null ? (
        <p role="alert" className="px-2 py-4 text-sm text-muted-foreground">
          {list.error}
        </p>
      ) : list.data === null ? (
        <p role="status" className="px-2 py-4 text-sm text-muted-foreground">
          {gt("Loading artifacts…")}
        </p>
      ) : list.data.length === 0 ? (
        <p className="px-2 py-4 text-sm text-muted-foreground">
          {gt("No saved artifacts. Right-click a file in Files or a file link in chat to save it.")}
        </p>
      ) : (
        <ul>
          {list.data.map((artifact) => (
            <li key={artifact.id}>
              <SharedTooltipTrigger
                label={
                  <span className="whitespace-pre-line wrap-anywhere">
                    {artifact.description
                      ? artifact.path + "\n" + artifact.description
                      : artifact.path}
                  </span>
                }
                render={
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent focus-visible:bg-accent"
                    onClick={() => onOpenFile(artifact.path)}
                    onContextMenu={(event) => void showMenu(event, artifact)}
                    onKeyDown={canEdit ? openContextMenuFromKeyboard : undefined}
                  />
                }
              >
                <PierreEntryIcon
                  pathValue={artifact.path}
                  kind="file"
                  theme={resolvedTheme}
                  className="size-4 shrink-0"
                />
                <span className="truncate">{artifactName(artifact)}</span>
              </SharedTooltipTrigger>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={rename !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setRename(null);
        }}
      >
        <DialogPopup initialFocus={nameInput} showCloseButton={!saving}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void renameArtifact();
            }}
          >
            <DialogHeader>
              <DialogTitle>{gt("Rename artifact")}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <Input
                ref={nameInput}
                aria-label={gt("Artifact name")}
                value={rename?.value ?? ""}
                maxLength={200}
                onChange={(event) => {
                  if (rename) setRename({ ...rename, value: event.target.value });
                }}
              />
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />} disabled={saving}>
                {gt("Cancel")}
              </DialogClose>
              <Button type="submit" disabled={saving || !canEdit}>
                {gt("Save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function artifactName(artifact: ProjectArtifact): string {
  const name = artifact.path.split(isWindowsAbsolutePath(artifact.path) ? /[\\/]/ : "/").at(-1);
  return artifact.label ?? (name || artifact.path);
}
