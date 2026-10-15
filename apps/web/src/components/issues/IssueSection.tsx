import type { EnvironmentId, IssueRepositoryRef } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { useIssueSectionCollapsed } from "./useIssueSectionCollapsed";

/** Keep collapse subscriptions local to each section instead of its containing list. */
export function IssueSection({
  scope,
  section,
  children,
}: {
  readonly scope: IssueRepositoryRef & { readonly environmentId: EnvironmentId };
  readonly section: string;
  readonly children: (collapsed: boolean, toggleCollapsed: () => void) => ReactNode;
}) {
  const [collapsed, toggleCollapsed] = useIssueSectionCollapsed(scope, section);
  return children(collapsed, toggleCollapsed);
}
