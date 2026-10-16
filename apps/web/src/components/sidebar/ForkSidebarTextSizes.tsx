import type { CSSProperties, ReactNode } from "react";
import { useClientSettings } from "../../hooks/useSettings";

/** Keep size changes on the container so memoized rows need no settings subscription. */
export function ForkSidebarTextSizes(props: {
  readonly children: ReactNode;
  readonly className: string;
}) {
  const settings = useClientSettings((settings) => settings);
  const rem = (size: number | null) => (typeof size === "number" ? `${size / 16}rem` : undefined);
  return (
    <div
      className={`fork-sidebar-text-sizes ${props.className}`}
      data-sidebar-style={settings.codexStyleSidebar ? "codex" : "classic"}
      style={
        {
          "--fork-sidebar-section-size": rem(settings.sidebarSectionTextSize),
          "--fork-sidebar-project-size": rem(settings.sidebarProjectTextSize),
          "--fork-sidebar-thread-size": rem(settings.sidebarThreadTextSize),
          "--fork-sidebar-agent-size": rem(settings.sidebarAgentTextSize),
          "--fork-sidebar-process-size": rem(settings.sidebarProcessTextSize),
          "--fork-sidebar-detail-size": rem(settings.sidebarDetailTextSize),
        } as CSSProperties
      }
    >
      {props.children}
    </div>
  );
}
