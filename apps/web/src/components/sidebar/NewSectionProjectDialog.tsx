import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState, type FormEvent } from "react";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { usePrimarySettings } from "../../hooks/useSettings";
import { newProjectId } from "../../lib/utils";
import { placeAddedProject, setAddProjectSection } from "../../projectSectionPlacement";
import { projectFolderNameProblem, sectionFolderPath } from "../../sectionProjectPath";
import { waitForProject } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

/** The section a new project folder is created in; a subsection names its parent too. */
export interface NewSectionProjectTarget {
  readonly sectionId: string;
  readonly sectionName: string;
  readonly parentName?: string | undefined;
}

/**
 * Creates a project folder inside a section's folder on the primary environment, optionally as a
 * git repository, adds it to T3 in that section, and opens a new thread in it. Mount with a fresh
 * `key` per opening so the form starts empty.
 */
export function NewSectionProjectDialog(props: {
  readonly target: NewSectionProjectTarget;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { target } = props;
  const environmentId = usePrimaryEnvironmentId();
  // The same root Organize by folder reads, falling back to where Add project starts.
  const root = usePrimarySettings(
    (settings) => settings.projectFolderRoot || settings.addProjectBaseDirectory,
  );
  const folder = sectionFolderPath(
    root,
    target.parentName === undefined
      ? [target.sectionName]
      : [target.parentName, target.sectionName],
  );
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const initRepository = useAtomCommand(vcsEnvironment.init, { reportFailure: false });
  const { handleNewThread } = useHandleNewThread();
  const [name, setName] = useState("");
  const [initGit, setInitGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const problem = projectFolderNameProblem(name);
  const path = folder === null ? null : `${folder}/${name.trim()}`;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (environmentId === null || path === null || problem !== null || busy) return;
    setBusy(true);
    const projectId = newProjectId();
    const created = await createProject({
      environmentId,
      input: {
        projectId,
        title: name.trim(),
        workspaceRoot: path,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
      },
    });
    if (created._tag === "Failure") {
      setBusy(false);
      if (!isAtomCommandInterrupted(created)) {
        const error = squashAtomCommandFailure(created);
        toastManager.add({
          type: "error",
          title: "Couldn't create the project",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      return;
    }
    const projectRef = scopeProjectRef(environmentId, projectId);
    setAddProjectSection(target.sectionId);
    placeAddedProject(projectRef);
    if (initGit) {
      const initialized = await initRepository({ environmentId, input: { cwd: path } });
      if (initialized._tag === "Failure" && !isAtomCommandInterrupted(initialized)) {
        toastManager.add({
          type: "warning",
          title: "Project created without git",
          description: "The folder was created, but git init failed. Run it yourself when needed.",
        });
      }
    }
    props.onOpenChange(false);
    await waitForProject(projectRef, 3_000).catch(() => null);
    await settlePromise(() => handleNewThread(projectRef));
  };

  const where = target.parentName
    ? `${target.parentName} / ${target.sectionName}`
    : target.sectionName;
  return (
    <Dialog onOpenChange={props.onOpenChange} open={props.open}>
      <DialogPopup className="max-w-md">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>New project in {where}</DialogTitle>
            <DialogDescription>
              {folder === null
                ? "Set a full folder path under Settings → Customizations → Organize by folder, so sections know where their projects live."
                : "Creates the folder and adds it to this section."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3">
            <Input
              aria-label="Project folder name"
              autoFocus
              disabled={folder === null}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. new-model"
              spellCheck={false}
              value={name}
            />
            {path !== null && name.trim().length > 0 ? (
              <p className="break-all text-xs text-muted-foreground">
                {problem ?? `Creates ${path}`}
              </p>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={initGit} onCheckedChange={(checked) => setInitGit(checked)} />
              Initialize git repository
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => props.onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={folder === null || problem !== null || busy} type="submit">
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
