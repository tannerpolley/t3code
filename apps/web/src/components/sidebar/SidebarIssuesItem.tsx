import { useNavigate } from "@tanstack/react-router";
import { CircleDotIcon } from "lucide-react";

import { useClientSettings } from "../../hooks/useSettings";
import { useIssuesSupported } from "../../state/environments";
import { useIssuePageScope } from "../issues/useIssuePageScope";
import { SidebarUtilityItem } from "./SidebarChrome";

export function SidebarIssuesItem(props: { onNavigate: () => void }) {
  const navigate = useNavigate();
  const issuesPageEnabled = useClientSettings((settings) => settings.issuesPage);
  const issuesSupported = useIssuesSupported() && issuesPageEnabled;
  const issuePageScope = useIssuePageScope();
  if (!issuesSupported) return null;
  const handleIssuesClick = () => {
    props.onNavigate();
    void navigate({ to: "/issues", search: issuePageScope });
  };
  return <SidebarUtilityItem icon={<CircleDotIcon />} label="Issues" onClick={handleIssuesClick} />;
}
