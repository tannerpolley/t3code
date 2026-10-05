import { buildProjectGroups, selectProjectGroupingSettings } from "../../logicalProject";
import {
  useClientSettings,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** The primary environment's folder root, shared by manual organization and new section projects. */
export function SidebarProjectSettings() {
  const projects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectFolderRoot = usePrimarySettings((settings) => settings.projectFolderRoot);
  const addProjectBaseDirectory = usePrimarySettings(
    (settings) => settings.addProjectBaseDirectory,
  );
  const updatePrimarySettings = useUpdatePrimarySettings();
  const folderRoot =
    projectFolderRoot || (addProjectBaseDirectory.startsWith("/") ? addProjectBaseDirectory : "");

  const organize = () => {
    if (!folderRoot.startsWith("/")) {
      toastManager.add({
        type: "error",
        title: "Use a full folder path",
        description:
          "Organize by folder needs a path starting with /, such as /home/you/Workspaces.",
      });
      return;
    }
    const groups = buildProjectGroups({ projects, settings: groupingSettings });
    useUiStateStore.getState().organizeSidebarSectionsByFolder(
      groups.map((group) => ({
        projectKey: group.key,
        workspaceRoots: group.members.map((member) => member.project.workspaceRoot),
      })),
      folderRoot,
    );
    toastManager.add({
      type: "success",
      title: "Sections organized",
      description: `Projects under ${folderRoot} now follow its folders.`,
    });
  };

  return (
    <SettingsRow
      serverScoped
      settingKeys={["projectFolderRoot"]}
      {...searchableSetting("organize-by-folder")}
      description={
        'Mirror a folder\'s layout as sections: root/A/B/project goes to section A, subsection B. Projects inside another project stay with it; projects elsewhere keep their place. Safe to run again. Leave empty to use "Add project starts in" when that is a full path.'
      }
      control={
        <div className="flex w-full items-center gap-2 sm:w-96">
          <DraftInput
            aria-label="Folder to organize by"
            className="min-w-0 flex-1"
            onCommit={(next) => updatePrimarySettings({ projectFolderRoot: next })}
            placeholder={
              addProjectBaseDirectory.startsWith("/")
                ? addProjectBaseDirectory
                : "/home/you/Workspaces"
            }
            size="sm"
            spellCheck={false}
            value={projectFolderRoot}
          />
          <Button disabled={folderRoot.length === 0} onClick={organize} size="sm" variant="outline">
            Organize
          </Button>
        </div>
      }
    />
  );
}
