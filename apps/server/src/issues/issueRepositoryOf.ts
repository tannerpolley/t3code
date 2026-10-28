import type { RepositoryIdentity } from "@t3tools/contracts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

export function issueRepositoryOf(identity: RepositoryIdentity | null | undefined) {
  if (identity?.provider !== "github" && identity?.provider !== "forgejo") return null;
  const repository =
    identity.origin?.displayName ?? sourceControlDefinitions.repositorySelector(identity);
  if (repository === null) return null;
  return {
    host: sourceControlDefinitions.changeRequestHost(identity, identity.provider).toLowerCase(),
    repository,
  };
}
