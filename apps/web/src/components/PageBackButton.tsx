import { ArrowLeftIcon } from "lucide-react";
import { useCallback } from "react";
import { useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";

import { useClientSettings } from "../hooks/useSettings";
import { Button } from "./ui/button";
import { useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * The page a Back leaves: Settings, a project's settings, Usage, Pull Requests or Issues.
 * Null on thread pages, which have nothing to go back from.
 */
export function usePageBack() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const page = useLocation({
    select: (location) =>
      /^\/settings(?:\/|$)/.test(location.pathname)
        ? "settings"
        : /^\/projects\/[^/]+\/?$/.test(location.pathname)
          ? "project-settings"
          : location.pathname === "/usage"
            ? "usage"
            : location.pathname === "/pull-requests"
              ? "pull-requests"
              : location.pathname === "/issues"
                ? "issues"
                : null,
  });
  const goBack = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, isMobile, navigate, setOpenMobile]);
  return { page, goBack };
}

/** Back at the top-left of a page's header, when the "top back button" customization is on. */
export function PageBackButton() {
  const topBackButton = useClientSettings((settings) => settings.topBackButton);
  const back = usePageBack();
  if (!topBackButton || back.page === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Back"
            className="size-[var(--workspace-titlebar-control-size)]! shrink-0"
            onClick={back.goBack}
            size="icon"
            variant="ghost"
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
        }
      />
      <TooltipPopup side="bottom">Back</TooltipPopup>
    </Tooltip>
  );
}
