import { useUiStateStore } from "../../uiStateStore";
import { sidebarWorkExpanded } from "./SidebarThreadProcesses.logic";

export function useSidebarWorkExpansion(threadKey: string, hasRunningAgents: boolean) {
  const explicit = useUiStateStore((state) => state.sidebarWorkExpandedById[threadKey]);
  const setExpanded = useUiStateStore((state) => state.setSidebarWorkExpanded);
  const open = sidebarWorkExpanded(explicit, hasRunningAgents);
  return { open, onToggle: () => setExpanded(threadKey, !open) };
}
