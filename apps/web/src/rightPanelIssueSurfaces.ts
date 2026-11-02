import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

export type IssueSurface = {
  id: `issue:${string}`;
  kind: "issue";
  environmentId?: string;
  host: string;
  repository: string;
  number: number;
  url?: string;
};

/** The repository an issue-list surface is narrowed to. */
export type IssueListScope = { host: string; repository: string };

export const ISSUES_PANEL_REF = scopeThreadRef(
  EnvironmentId.make("issues-panel"),
  ThreadId.make("issues-panel"),
);

export const isIssuesPanelKey = (threadKey: string) => threadKey.endsWith(":issues-panel");

export function issueSurfaceId(
  target: Omit<IssueSurface, "id" | "kind" | "url">,
): IssueSurface["id"] {
  const scope =
    target.environmentId === undefined ? "" : `${encodeURIComponent(target.environmentId)}:`;
  return `issue:${scope}${encodeURIComponent(target.host.trim().toLowerCase())}:${encodeURIComponent(target.repository.trim().toLowerCase())}:${target.number}`;
}

export function issueSurface(target: Omit<IssueSurface, "id" | "kind">): IssueSurface {
  return {
    id: issueSurfaceId(target),
    kind: "issue",
    ...(target.environmentId === undefined ? {} : { environmentId: target.environmentId }),
    host: target.host.trim().toLowerCase(),
    repository: target.repository,
    number: target.number,
    ...(typeof target.url === "string" ? { url: target.url } : {}),
  };
}

/** Validates a persisted issue surface; drops it when its target is unusable. */
export function migratePersistedIssueSurface(surface: IssueSurface): IssueSurface[] {
  if (
    typeof surface.host !== "string" ||
    surface.host.trim().length === 0 ||
    typeof surface.repository !== "string" ||
    surface.repository.trim().length === 0 ||
    typeof surface.number !== "number" ||
    !Number.isSafeInteger(surface.number) ||
    surface.number < 1
  ) {
    return [];
  }
  return [
    issueSurface({
      ...(typeof surface.environmentId === "string"
        ? { environmentId: surface.environmentId }
        : {}),
      host: surface.host,
      repository: surface.repository,
      number: surface.number,
      ...(typeof surface.url === "string" ? { url: surface.url } : {}),
    }),
  ];
}
