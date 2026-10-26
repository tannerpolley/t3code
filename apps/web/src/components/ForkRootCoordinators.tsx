import { useEffect } from "react";
import { useClientSettings } from "../hooks/useSettings";
import { BackgroundProcessPopupHost } from "./chat/BackgroundProcessOutput";
import { ResetCreditReminderCoordinator } from "./ResetCreditReminderCoordinator";
import { SidebarLayoutSync } from "./SidebarLayoutSync";
import { QuestionPopup } from "./QuestionPopup";

export function ForkRootCoordinators() {
  const fastShimmer = useClientSettings((settings) => settings.fastShimmer);
  // oxlint-disable-next-line t3code/react-effect-budget -- Synchronizes the fork setting with the document attribute used by CSS.
  useEffect(() => {
    document.documentElement.toggleAttribute("data-fast-shimmer", fastShimmer);
  }, [fastShimmer]);
  return (
    <>
      <SidebarLayoutSync />
      <ResetCreditReminderCoordinator />
      <QuestionPopup />
      <BackgroundProcessPopupHost />
    </>
  );
}
