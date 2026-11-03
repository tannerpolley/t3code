/** What an issue host supports. T3 offers only these and refuses the rest before reaching the host. */
export interface IssueHostCapabilities {
  /** Parent and child issues, native or through body markers. */
  readonly subIssues: boolean;
  /** "Blocked by" relationships between issues. */
  readonly blockers: boolean;
  readonly milestones: boolean;
  readonly labels: boolean;
  readonly assignees: boolean;
  /** A merged change request closes the issues it names, done by the host or by T3. */
  readonly closesFromMergedChangeRequests: boolean;
  /** T3 can poll the host for new issue activity (the Issues inbox and its watcher). */
  readonly liveChanges: boolean;
}

export interface IssueHostRegistration {
  readonly capabilities: IssueHostCapabilities;
  /** The only hosts the issue host serves; any host of the provider when absent. */
  readonly hosts?: ReadonlyArray<string>;
}

const everything: IssueHostCapabilities = {
  subIssues: true,
  blockers: true,
  milestones: true,
  labels: true,
  assignees: true,
  closesFromMergedChangeRequests: true,
  liveChanges: true,
};

/** Issue hosts by kind (a source-control provider, or an opt-in); a kind absent here has no Issues. */
export const ISSUE_HOSTS: { readonly [kind: string]: IssueHostRegistration | undefined } = {
  github: { capabilities: everything, hosts: ["github.com"] },
  // Sub-issues are body markers and closing on merge is done by T3; see IssueForgejoHost.ts.
  forgejo: { capabilities: everything },
  // Blocking links depend on project tier; GitLab inbox polling is not implemented.
  gitlab: { capabilities: { ...everything, blockers: false, liveChanges: false } },
  // Issues stored in the repository itself; served under the host name "git-bug". IssueGitBugHost.ts.
  "git-bug": {
    capabilities: {
      subIssues: false,
      blockers: false,
      milestones: false,
      labels: true,
      assignees: false,
      closesFromMergedChangeRequests: false,
      liveChanges: false,
    },
    hosts: ["git-bug"],
  },
};

/** The kind of issue host serving a repository: its explicit opt-in, else its provider's. */
export const repositoryIssueHostKind = (
  identity: { readonly issueHost?: string; readonly provider?: string } | null | undefined,
) => identity?.issueHost ?? identity?.provider;

export const issueHostCapabilities = (kind: string | null | undefined) =>
  kind == null ? null : (ISSUE_HOSTS[kind]?.capabilities ?? null);
