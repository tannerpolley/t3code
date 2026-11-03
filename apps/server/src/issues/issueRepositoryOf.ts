import { issueHostCapabilities, type RepositoryIdentity } from "@t3tools/contracts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

export function issueRepositoryOf(identity: RepositoryIdentity | null | undefined) {
  if (identity == null || issueHostCapabilities(identity.provider) === null) return null;
  const repository =
    identity.origin?.displayName ?? sourceControlDefinitions.repositorySelector(identity);
  const host = sourceControlDefinitions.changeRequestHost(identity, identity.provider);
  return repository === null || host === undefined
    ? null
    : { host: host.toLowerCase(), repository };
}
