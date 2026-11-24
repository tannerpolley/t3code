import { useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { useRef } from "react";

import { isElectron } from "~/env";
import { IssuesRoadmapPage } from "../issues/IssuesRoadmapPage";
import { useIssuePageCopyShortcut } from "../issues/useIssueReferenceCopyTarget";
import { SidebarInset } from "../ui/sidebar";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { IssuesPage } from "./IssuesPage";
import { readIssueListPreferences } from "./issueListPreferences";
import { writeIssueView } from "./issueViewPreferences";

export function IssuesWorkspace() {
  const gt = useGT();
  const { view = "board" } = useSearch({ from: "/_chat/issues" });
  const navigate = useNavigate({ from: "/issues" });
  const headingRef = useRef<HTMLHeadingElement>(null);
  useIssuePageCopyShortcut();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel={gt("Issues breadcrumb")}>
          <WorkspaceBreadcrumbItem current>
            <h1 ref={headingRef} tabIndex={-1} className="truncate">
              <T context="page title, list of issues">Issues</T>
            </h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <ToggleGroup
          aria-label={gt("Issues view")}
          className="shrink-0 [-webkit-app-region:no-drag]"
          value={[view]}
          onValueChange={([next]) => {
            if ((next !== "board" && next !== "list") || next === view) return;
            writeIssueView(next);
            void navigate({
              search:
                next === "list" ? { ...readIssueListPreferences(), view: next } : { view: next },
            });
          }}
        >
          <ToggleGroupItem value="board">
            <T context="issue stage board view">Board</T>
          </ToggleGroupItem>
          <ToggleGroupItem value="list">
            <T context="issue list view">List</T>
          </ToggleGroupItem>
        </ToggleGroup>
      </WorkspacePageHeader>
      {view === "list" ? <IssuesPage /> : <IssuesRoadmapPage headingRef={headingRef} />}
    </SidebarInset>
  );
}
