# Source control

T3 Code integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, and GitCafe to clone
and publish repositories, create pull requests, and review changes.

## Review turn changes

A turn's changed files and diff show only the turn's own work. When a turn pulls, merges, or
rebases, the files Git brought in are left out. A file stays in the list when the turn edited it,
committed it, or fixed a conflict in it. Use the branch comparison to review everything that changed
against your base branch. Restore still returns the complete saved workspace.

## Connect an account

Install Git and configure authentication on the machine running your T3 Code server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source Control**
and choose **Rescan**.

### GitHub

T3 Code talks to GitHub's API directly and only needs a token. Any of these works, in this
order of precedence:

1. A token saved in **Settings → Source Control → GitHub**. It is kept in the server's secret
   store, and works without the GitHub CLI.
2. `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` with `GH_HOST` for GitHub Enterprise Server) in the
   server's environment.
3. [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, signed in with `gh auth login`.

If `gh` is signed in to several accounts or hosts, expand **GitHub** in the same place to pick
the account each host uses or turn a host off. A saved token or `GH_TOKEN` takes precedence
over that choice; a host turned off stays off either way.

For GitHub Enterprise, sign in with `gh auth login --hostname YOUR_HOST`. T3 Code treats a
custom server name as GitHub once it has a credential for that host.

### Forgejo and Gitea

Install [Forgejo CLI (`fj`)](https://codeberg.org/forgejo-contrib/forgejo-cli) or
[Gitea CLI (`tea`)](https://gitea.com/gitea/tea) 0.16 or later on your T3 Code server.
Sign in with `fj --host https://your-server auth add-token` or `tea login add`.
Repeat for each server you use, including Codeberg.

T3 Code prefers a matching `fj` login and falls back to `tea` when `fj` is unavailable
or has no login for that server. Once an account is selected, failed actions stay on that
account. Settings shows the detected CLI. Forgejo and Gitea share one integration entry.
Servers hosted under a URL subpath, such as `https://example.com/forgejo`, use `tea` because
fj 0.6 does not preserve the subpath when checking its account.

When cloning or publishing, use a full repository URL to select a specific server.
You can use `owner/repo` when only one fj server is configured, or with your default `tea`
login when fj is unavailable or unconfigured. With multiple fj servers, use the full URL.
If you have multiple `tea` accounts on one server, select one with
`tea login default <login-name>`. Git push and clone also need Git credentials or an SSH key
for that server.

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

### Bitbucket

Open **Settings → Source Control**, expand **Bitbucket**, and enter one of:

- **Access token**: a token created for one repository, project, or workspace. It can only reach
  what it was created for.
- **Atlassian account email** and **API token**: an Atlassian API token for your account. It can
  reach every repository you can. Give it read/write access to repositories and pull requests, plus
  user read access (`read:user:bitbucket`).

A field saves when you leave it, and applies right away. The access token wins when both are saved.
Credentials are saved on the environment's server, so select a remote environment to configure
it. Saved tokens can't be viewed again; enter a new one to replace it, or choose **Remove** to clear
everything saved for Bitbucket.

If no credentials are saved, T3 Code falls back to these variables in the server's environment.
Restart the server after changing them:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
# or
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

### GitCafe

Install the GitCafe CLI and sign in:

```bash
bun install -g @gitcafe/cli
cafe auth login --host https://git.cafe/api
```

Alternatively, open **Settings → Source Control**, expand **GitCafe**, and enter a token. It is
kept in the server's secret store, applies right away, and is used before `CAFE_TOKEN` and the
`cafe` login. Or set `CAFE_TOKEN` in the server's environment and restart it. Both tokens are only
sent to `git.cafe`; `CAFE_TOKEN` follows `CAFE_HOST` if you set it. Repositories on
`staging.git.cafe` need their own login with `--host https://staging.git.cafe/api`.

Line comments, reviewer requests, and labels are not available for GitCafe pull requests yet.
Merging a stack lands it through GitCafe, and updating a branch restacks the layers above it.

## Start, clone, or publish a project

To start from nothing, choose **New project** in the command palette (`Cmd/Ctrl+K`), or
**New project** under **Add Project** on any client, and type a name. T3 Code makes a Git
repository in `~/.t3/projects` (the `projects` folder of your T3 data directory) with a README,
an icon, and a first commit, then opens a new thread in it. Until the project has a thread, new
threads work in its folder, even when your default is a new worktree. The folder is named after the project,
like `pinball-stats` for "Pinball Stats". Turn on **Create private repository on GitHub** to also
publish it. If Git has no name or email on that machine, the project is created without the
first commit.

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it. The project opens right away while the
clone runs in the background: you can write your first prompt, and sending waits until the files
are in place. A toast tracks progress and lets you cancel; if the clone fails, retry it from the
toast or from the banner above the composer.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. T3 Code can generate commit
messages, review titles, and descriptions from your changes.

An existing fork PR can appear beside the branch even if you pushed without setting an upstream.
If its badge is missing because several remotes hold that branch, set the branch's upstream to
the intended remote with `git branch --set-upstream-to=<remote>/<branch>`.

Choose the writing style and model in **Settings → Source Control**. **Repository conventions**
uses the project's instructions and recent commit subjects.

## Review and merge

Open **Pull requests** to review changes and comments, request reviewers, check out a branch,
or merge. You can edit review titles and descriptions and your own comments where the host allows it.
GitLab calls these merge requests.

On mobile, **Pull requests** lists reviews across your connected environments. Open a review
to read its description, activity, commits, and changed files. Line comments stay as drafts
until you submit the review. **Work on PR** opens a chat with the review attached; sending
the first message prepares a worktree from the review's branch.

Previously loaded lists, review details, guides, and diff pages remain readable on mobile
without a connection, including after restarting the app. Saved content refreshes when the
environment reconnects; submitting changes requires a connection.

Enable **Remove agent credits when merging** in Settings → Source Control to remove recognized
agent co-author and generated-by lines from GitHub merge and squash commit messages. Human
co-authors stay credited. The setting is off by default and projects can override it. It also
applies to auto-merge, but not merge queues or native stack merges. Original commits keep their
messages, so merge and rebase can still retain agent credits in those commits.

On web and desktop, hold **Shift** in the GitHub pull request list for quick actions.
To close several, press **Close**, drag across the rows in the same group, and release.
Press **Escape** before releasing to cancel. Failed closes stay in the list so you can retry them.

GitHub, GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also
supports approving waiting fork workflows and opening a revert pull request for a merged change.

GitHub sharing is off by default. In Settings → Connections → GitHub sharing (Environments on mobile), choose
**Read PRs** or **Read and act** for each environment you trust to share GitHub access.
Enable both the original environment and the environment answering its requests on this client.
**Read and act** can use broader GitHub permissions than the original environment's credential;
only enable it for environments you control and trust. Changing a saved endpoint or removing an
environment clears its permission.

GitHub review details, linked PR status, and permitted review actions can then use another
connected environment signed in to the same GitHub account. Each needs a project on that host.
A connected local environment is preferred for actions and can answer slow or failed reads.
Browsers and mobile clients need a paired environment to use its GitHub credentials.
Credentials stay on their machines. Previously verified credentials remain usable for routing
for ten minutes during a GitHub outage; new credentials must be verified first. An action with
an uncertain result is never automatically retried elsewhere. Listings, diffs, and checkout or
PR creation from Git actions continue to use the project's environment.

For Azure DevOps, use the host website to change comments. Bitbucket does not support reopening a
declined pull request.

### Review guides

Review guides are in beta. Turn on **Review guides** in Settings → Source Control to add the
**Guide** tab to pull requests on that server. On mobile, move between stops with **Next**
and the back button; a stale guide offers a rewrite and hides excerpts that no longer match
the current change.

The **Guide** tab gives you a tour of a pull request without reading it line by line: stops
through the change in reading order. Each stop points at the lines worth reading, and a stop marked
**Look closely** has a call only a maintainer can make. Mechanical changes such as renames and
snapshots are grouped at the end, and every changed file appears somewhere on the tour.
Conversations already resolved in review are left out. For a pull request in a stack, the guide
covers that layer only, and may point out what a lower layer introduced or what a higher one uses.

Choose **Write guide** to have the review guide model from Settings → Source Control read the
change in a temporary checkout; without one set, the source control writer model is used. Nothing
in the checkout is changed, and a large pull request takes a few minutes; you can go elsewhere in
the app. On web, you are told when the guide is ready; on mobile, return to the guide to check
its progress. Claude and Codex can write guides. The guide is
kept for everyone using this server. To write it again, for example after a push or after changing
the model or instructions, choose **Rewrite guide** from the pull request's **⋯** menu.

On web, while reading a stop, select lines in an excerpt to add a comment to your review or ask an agent
about them; comments wait with the ones from the **Code** tab until you send the review. Choose a
suggested question, or **Ask about this stop**, to open a thread that already knows which stop you
are on. **Finish review** on the last stop opens the review with everything you collected.

Agents can write guides too: ask one to prepare guides for a set of pull requests, and it starts
them for you. Each is read through the project whose checkout has that repository.

To shape guides to your taste, write **Review guide instructions** in Settings → Source Control,
such as what to show first or what to skip; projects can override them. They change emphasis and
ordering, not the guide's layout or which files it covers.

### Mark files as viewed

Tick a file off in the **Code** tab once you have read it and it collapses; the toolbar keeps a
running count. A tick belongs to the pull request rather than to a commit, so scoping the tab to a
single commit keeps them. A file pushed to after you cleared it comes back marked **Changed**.

On GitHub these are GitHub's own viewed marks, so a review carries between T3 Code and github.com
in either direction. Forgejo, GitLab, Bitbucket, and Azure DevOps expose no record T3 Code can read, so the
server you are connected to keeps them instead: they follow you across the apps connected to that
server, but the host's own site will not show them, and the count reads **viewed in T3 Code**.

On mobile, open a changed file and mark it viewed from its header. Viewed files collapse,
and their marks follow the same rules as on web and desktop.

## Browse GitHub issues

When a connected environment has GitHub Issues support, open **Issues** from the sidebar. It lists
issues from every repository your GitHub account owns and every organization repository you
administer, whether or not the repository is a T3 Code project. Repositories you only collaborate
on, including the upstream of a fork, are left out. The Milestones view groups issues by owner,
then repository and milestone; your own account comes first.

Use **Filter** to choose what is shown: open and closed issues; archived, forked, empty, public,
private, personal, and organization repositories; milestone and assignment; and how issues are
sorted. Open issues are shown by default, with archived, forked, and empty repositories hidden.
Filter choices are remembered in that browser. The search box matches repository names and issue
details.

In the Issues pane, turn on **Roadmap view** for a repository (at the top of **Filter** when the
pane shows one repository) for its open issues in dependency order, with **In progress**,
**Ready**, and **Blocked** sections. Within a section, open blockers and sub-issues come before
the issues that depend on them; closed blockers no longer hold work back. The view choice is
remembered per repository. An issue with any linked thread stays **In progress**, including when
that thread is idle. A thread’s own linked pull request also associates it with the issues that
GitHub identifies that pull request as closing.
Select a work indicator to open its linked thread; hover to see the thread's branch, worktree and
pull requests. To include work started outside **Start agent**, ask the agent to link the issue it
is working on. Ordinary threads and delegated workers can both link issues.

To keep one repository visible while its kind is hidden, such as a single fork, show it once, then
use the pin button on its row. A pinned repository ignores the repository filters but still follows
the issue filters and search. Pins are remembered with your filter choices.

Select an issue to open it in a resizable panel: **Summary** shows its description and the pull
requests linked to it, **Timeline** its comments. A linked pull request opens in the pull request
panel, and its back arrow returns to the issue. A link to a GitHub issue in a pull request, issue
or chat message opens the same issue panel. **Prepare draft** opens a new thread for the issue's
project in a worktree on a branch named after the issue, with an unsent prompt.
Select the issue number at the top to comment or make other changes on GitHub.

To run issue work, open an issue, choose **Start agent**, then a model role and the
matching repository project. Use a model role with an available Codex or Claude target.
**Start agent on issue…** in the command palette opens the current
repository’s issues beside the thread, or the Issues page when there is no current repository.
If no repository orchestrator is registered, choose an existing lead in the matching project or
explicitly choose **Create first orchestrator**. When you open issues beside a thread, its lead
is selected for you. The repository orchestrator stays on the default branch in the main checkout.
Start agent registers the selected lead and starts or queues an issue worker, following the issue
parent tree. Later starts use that orchestrator's project. Every worker gets a new worktree and
branch named after the issue, created from the default branch; there is no checkout choice.
Starting allows T3 to update one status comment and publish a closeout comment for each finished
attempt; the publishing policy is shown before you start. When a worker has been created, select
its name to open its conversation with the issue beside it. A queued start can appear before a
worker exists; use the repository's orchestrator link on the Issues page to open the lead.
**Linked issue** in thread details opens the issue beside that thread. A worker marked done may
still need review, publishing, or merge approval; T3 does not automatically close the GitHub issue.

Issue agents can create issues, split work into sub-issues, and move issues between milestones.
To require approval for these too, turn on **Ask before agents create, split or move issues** in
**Settings → Source Control → Version control & issues** for the server. This applies to new
proposals; existing proposals keep their approval decision. Body edits, closing or reopening issues,
and other parent changes also apply right away, unless the agent thread is in **Approval required**
mode; then they wait for you. Review a waiting change in the issue's detail on
the Issues page, then approve or reject it. Results stay visible there, and failed changes can retry
their remaining steps. If the issue changed since the
preview, the agent must propose a new change. If GitHub may have created an issue but T3 cannot
recover it, the change needs your attention. Check GitHub, then choose **Mark resolved** to stop
its remaining writes. Propose another create only when you intend to create another issue.

To replace the orchestrator's conversation, open the repository on the Issues page, use
**Hand off to fresh thread** beside its orchestrator, and provide a summary. Your approval pauses new issue admissions until existing
workers and their final results finish; the fresh thread receives your summary and a recovery
inventory. These controls also let you cancel a pending handoff and open the current or previous
roots. For a routine provider or model change, keep the same thread.

To restore orchestration to another existing thread, first use **Pause repository work**. The
current orchestrator must be stopped, with no active issue workers or unclaimed start requests.
Then use **Use another thread as orchestrator** to select a top-level thread in the same project.
Only you can approve this restore. Existing issue workers keep their threads, and the repository
remains paused after the change. Use **Resume repository work** when you are ready to continue.

A thread's details also list its repository's open issues in an **Issues** section, grouped by
collapsible milestones, and open them beside the thread. For a fork checkout, these are the fork's
issues. Turn either view off in **Settings → Source Control**.

To browse all of the repository's issues without leaving a thread, choose **Browse all issues** in
that section, pick **Issues** (shortcut `I`) from the empty right panel or its **+** menu, or run
**Show issues beside thread** from the command palette. The list opens in the right panel with the
same grouping and filters, and an issue you select opens in a tab next to it. **Show all
repositories** widens it to every repository you can read.

### Cross-project issue inbox

A repository with a repository orchestrator gets an inbox of outside issue activity. About every
two minutes T3 records new issues and comments, closes and reopens, label and milestone changes,
and title renames made by another project's agents or by you on GitHub. Edits to issue and comment
text are not tracked. Its own agents' writes and bots are left out. If T3 was offline long enough
to miss more than one catch-up can read, the inbox says so once; check the repository on GitHub.
An issue another project's agent opens or comments on gets the `external`, `priority: high` and
`from:<project>` labels; an issue you open yourself gets none unless that happens. T3 labels each issue once, so a label you remove stays
removed. A paused repository's inbox is not read or labeled until you resume it, then it catches up.

The orchestrator reads unread events in one line at the start of its next turn. Untagged events
wait for that turn and never start one. Tagged events also wake an idle orchestrator with a short
digest, at most once every 15 minutes, queued behind a running turn. An event is tagged when the
issue has the `cross-project` label, the text mentions `@orchestrator`, or another project's agent
wrote it.

The orchestrator's sidebar row shows its unread count. Open the repository on the **Issues** page
for its **Inbox**, high-priority events first, with links and **Mark read**. Agents read the inbox
with the `t3_issue_inbox` tool, and write to another project's issues with `t3_issue_post`, which
marks and labels the write so that repository's orchestrator is notified.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  check the credentials saved in Settings → Source Control, or confirm the running server received
  the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0, or save a token in Settings → Source Control.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

## Linked pull requests

A thread can hold several pull requests, including reviews from another repository on the same host.
Use **Link pull request** in the command palette or **Linked pull requests** panel, or right-click a
pull request link in the conversation. Creating a pull request from Git actions links it automatically.
Agents can link their pull requests with the `link_pull_request` tool.

Use **Link this PR** in a branch-detected badge's tooltip to keep it with the thread. From a review
on the Pull Requests page, **Link to thread** lets you search for an active thread. The review header
also lists the threads that link to it, including archived threads, so you can return to their context.

Thread badges show a stack's layer count or the current review number with a count of additional
links. Clicking a badge with more than one review opens the **Linked pull requests** panel. On mobile, the Git overview lists linked reviews and their stacks; tap a review to open it.
Linking and unlinking are available in the web and desktop clients.

The **Linked pull requests** panel lists every review and groups stacks. Unlink a review from its
row menu. An unlinked stack layer stays out of later syncs. Open linked reviews refresh on the server;
closed reviews refresh periodically so reopening one on the host is detected. Merged reviews refresh
when requested. A settled thread's reviews stop refreshing until you unsettle it. With **Auto-settle merged threads** enabled, a thread can settle after every linked
review is terminal. An open or unsynced link keeps it active.

Ask the agent to watch, monitor, or babysit a pull request and it calls `watch_pull_request`. While
the thread is active, the server checks the pull request every two minutes and wakes the agent when a
check fails, the required checks pass, someone else comments or reviews, or the branch starts to
conflict. Threads in a project that watch the same pull request share one check. On GitHub, a check
first asks whether anything changed and reads the pull request only when it did, which keeps
watching inside GitHub's rate limit. Comments from your own account do not wake it. Watching ends
when the pull request merges or closes, after 10 wakes in a row that bring only comments, after 8
failed reads in a row, or when you press Stop on the thread. A rate limit only pauses watching.
Settling or archiving a thread also ends all its watches. Unsettle the thread before starting a new
watch. Subagents cannot watch pull requests; the thread that delegated to them does. To start or stop
it yourself, use the row menu in the **Linked pull requests** panel. In the thread details card, a
watched pull request shows an eye; click it to stop watching.

A watched thread counts as working between wakes, so it stays in the **Working** section and does
not auto-settle. Agents stop watching when they hand the work back to you, and the thread then
returns to your inbox.

Cross-repository links use a project on the same host. Azure DevOps reviews require a project checked
out from the matching organization and repository.

## GitHub stacks

The Pull Requests page shows each PR's position in its GitHub stack. Open the stack badge in a
review to navigate its layers. **Merge stack** submits the selected pull request and every unmerged
layer below it to GitHub together, respecting branch rules and merge queues. The confirmation shows
the scope and merge strategy. GitHub rebases the remaining stack after merging.

**Rebase stack** updates remote branches from bottom to top without changing your local checkout.
It can rewrite history and restart checks. If a layer fails, earlier updates remain; resolve that
layer before retrying. GitHub may require manual conflict resolution after a lower layer is amended,
even when its changes look independent. Stack actions require an environment that supports them.
