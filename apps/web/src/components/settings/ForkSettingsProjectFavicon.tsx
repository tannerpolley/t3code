import type { ComponentProps } from "react";
import { useProjectFolderAppearance } from "../../projectFolderAppearance";
import { ProjectFavicon } from "../ProjectFavicon";

/** Settings project icons inherit the same section colors and folder choice as the sidebar. */
export function ForkSettingsProjectFavicon({
  projectKey,
  ...props
}: ComponentProps<typeof ProjectFavicon> & { readonly projectKey: string | null }) {
  const appearance = useProjectFolderAppearance(projectKey);
  return <ProjectFavicon {...props} {...appearance} />;
}
