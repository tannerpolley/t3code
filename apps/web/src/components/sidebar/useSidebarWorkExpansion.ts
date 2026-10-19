import { useState } from "react";
import { sidebarWorkExpanded } from "./SidebarThreadProcesses.logic";

export function useSidebarWorkExpansion(hasRunningAgents: boolean) {
  const [explicit, setExplicit] = useState<boolean>();
  const open = sidebarWorkExpanded(explicit, hasRunningAgents);
  return { open, onToggle: () => setExplicit(!open) };
}
