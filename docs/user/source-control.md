# Source control

T3 Code integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, GitCafe, and Cursor
Origin to clone and publish repositories, create pull requests, and review changes.

## Review turn changes

A turn's changed files and diff show only the turn's own work. When a turn pulls, merges, or
rebases, the files Git brought in are left out. A file stays in the list when the turn edited it,
committed it, or fixed a conflict in it. Use the branch comparison to review everything that changed
against your base branch. Restore still returns the complete saved workspace.

In a [project with several repositories](multi-repo-projects.md),
the Diff pane shows every repository the turn changed. Use the repository picker next to the source picker to narrow the diff to one of
them. Paths in the diff start at the thread's folder, so the same file name in two repositories
stays apart. This works when the project folder itself is not a Git repository; the branch
comparison and uncommitted changes read one repository at a time, chosen from the same picker.

The thread details panel lists each repository the thread has changed, most recent first, with its
branch and uncommitted changes. Expand one to commit, push, or open a pull request in that
repository; a pull request opened there, or already open for its branch when a turn ends, is linked
to the thread. **Other repositories...** adds any other repository of the project to the list until you
reload. In a worktree thread of a project with several repositories it adds a worktree of that
repository to the thread instead; see [Worktree threads](multi-repo-projects.md#worktree-threads). A
worktree thread of a single repository does not offer it.

On web and desktop, open the Diff pane source picker and choose **Commits** to review one local
commit at a time. The list shows the newest 100 commits in the branch comparison. A merge commit
shows its changes against its first parent.

A commit link from a supported code host opens in the Diff pane when the thread's repository has
that commit locally, on any branch. Otherwise a pull request commit link opens the pull request. Other
commit links follow your **Open links in** setting; on web, when that opens a new tab, T3 Code first
shows an **Open link** button. Command/Ctrl+Click always opens the link in your browser. Commit links follow the **Open pull requests in T3 Code**
setting in **Settings → Diffs**.

## Connect an account

Install Git and configure authentication on the machine running your T3 Code server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source control & issues**
and choose **Rescan**.

### GitHub

T3 Code talks to GitHub's API directly and only needs a token. Any of these works, in this
order of precedence:

1. A token saved in **Settings → Source control & issues → GitHub**. It is kept in the server's secret
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
fj does not preserve the subpath when checking its account.

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

Open **Settings → Source control & issues**, expand **Bitbucket**, and enter one of:

- **Access token**: a token created for one repository, project, or workspace. It can only reach
  what it was created for.
- **Atlassian account email** and **API token**: an Atlassian API token for your account. It can
  reach every repository you can. Give it read/write access to repositories and pull requests, plus
  user read access (`read:user:bitbucket`) and workspace read access (`read:workspace:bitbucket`).

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

For a background service, put these `KEY=VALUE` entries in
[`service.env`](./background-service.md#configure-the-service-environment)
under T3 home, then run `t3 service restart`. Service installation and updates
preserve that file.

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

Alternatively, open **Settings → Source control & issues**, expand **GitCafe**, and enter a token. It is
kept in the server's secret store, applies right away, and is used before `CAFE_TOKEN` and the
`cafe` login. Or set `CAFE_TOKEN` in the server's environment and restart it. Both tokens are only
sent to `git.cafe`; `CAFE_TOKEN` follows `CAFE_HOST` if you set it. Repositories on
`staging.git.cafe` need their own login with `--host https://staging.git.cafe/api`.

Line comments are not available for GitCafe pull requests yet.
Merging a stack lands it through GitCafe, and updating a branch restacks the layers above it.

### TanStack Source

TanStack Source is in private beta, so the server shows it only when its environment turns the flag
on: `export T3CODE_FEATURE_FLAGS=tanstack_source` in your shell profile, then restart T3 Code. Separate
several flags with commas. A value already set in the server's own environment, such as a service
definition, is used instead of the profile. Install its CLI and sign in:

```sh
curl -fsSL https://source.tanstack.com/install | sh
src auth login --web
```

Alternatively, open **Settings → Source control & issues**, expand **TanStack Source**, and enter a token
from `https://source.tanstack.com/settings/tokens`. A saved token is used before `SRC_TOKEN`, which is
used before the `src` login. With several `src` logins, pick the account there too.

Pull requests show the runs of TanStack Source CI with their logs, and update live while open. An
agent can open a private pull request on a public repository when you ask for one: its branch goes
to the repository's private companion and never to the repository itself. Issues
can be listed, filed, edited, commented on and closed. Reactions and picking reviewers or assignees
from a list are not available yet.

### Cursor Origin

Install the [Origin CLI](https://cursor.com/docs/origin/cli) and sign in. Signing in also sets up Git
credentials for `origin.cursor.com`:

```bash
curl -fsSL https://downloads.cursor.com/origin/install.sh | sh
origin auth login
```

If cloning or pushing asks for a username, run `origin auth setup-git` to point Git at the CLI's
credentials again. Origin repositories use HTTPS and are published privately. Repositories mirrored
from GitHub keep their pull requests on GitHub; open those from the GitHub remote.

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
provider or paste a Git URL, then choose where to save it. Only GitHub is listed at first. To list
another provider here and in **Publish Repository**, turn on its switch under
**Settings → Source control & issues**. A branch or file page copied from GitHub,
GitLab, GitCafe, Codeberg or Bitbucket also works: T3 Code clones that repository's default branch.
On other hosts, paste the repository's clone URL. The project opens right away while the
clone runs in the background: you can write your first prompt, and sending waits until the files
are in place. A toast tracks progress and lets you cancel; if the clone fails, retry it from the
toast or from the banner above the composer. When the host refuses the machine's SSH key, T3 Code
clones over HTTPS with Git's credentials for that host instead, and the project's remote uses the
HTTPS URL.

To lay clones out like [ghq](https://github.com/x-motemen/ghq), turn on **Clone into host folders**
under **Settings → Threads** (or **Source control** on mobile). Clones then default to
`<host>/<owner>/<repo>` under **Add project starts in**, so set that to `~/ghq` to share ghq's
folders. You can still change the destination before cloning.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. T3 Code can generate commit
messages, review titles, and descriptions from your changes. Descriptions also draw on the work in
the thread, including the checks it ran.

An existing fork PR can appear beside the branch even if you pushed without setting an upstream.
If its badge is missing because several remotes hold that branch, set the branch's upstream to
the intended remote with `git branch --set-upstream-to=<remote>/<branch>`.

Choose how commit messages and pull request titles and descriptions are written in
**Settings → Source control & issues → Commits & pull requests**. **Repository conventions** uses the
project's instructions and recent commit subjects. **Custom instructions** applies your own
instructions to commits and pull requests.

## Review and merge

Open **Pull requests** to review changes and comments, request reviewers, check out a branch,
or merge. You can edit review titles and descriptions and your own comments where the host allows it.
Where you can edit a description, you can also tick its checkboxes from the Summary tab
(the Overview tab on mobile).
GitLab calls these merge requests.

A merge or review applies to the commits you opened the pull request on. When someone pushes
meanwhile, the web and desktop apps offer **Load new commits**; until you do, a merge or review is refused and your
review draft is kept. Merging from a thread's pull request row, or from the list, lands the head that
row had when you confirmed.

Save a filter setup with **Views → Save current view** on the Pull Requests page. For example, choose
**Reviewing** (**Your review** on mobile) and save it as "PRs Requesting My Review". Choose a saved view to restore its search,
filters, sort order, and server/project scope. After changing filters, use **Update saved view** to
keep the changes, or save another view. You can also rename or delete views from the same menu.
Saved views stay in the browser or app where you created them and do not sync across devices.

A link to part of a pull request opens that part: a comment or review is marked in the activity, a
changed-line link opens the file at those lines, a checks link opens the checks, and a commit link
opens that commit's changes. On web and desktop, hovering a comment or commit link previews it.

On mobile, **Pull requests** lists reviews across your connected environments. Open a review
to read its description, activity, commits, and changed files. Line comments stay as drafts
until you submit the review. **Work on PR** opens a chat with the review attached; sending
the first message prepares a worktree from the review's branch.

Previously loaded lists, review details, guides, and diff pages remain readable on mobile
without a connection, including after restarting the app. Saved content refreshes when the
environment reconnects; submitting changes requires a connection.

Enable **Remove agent credits when merging** in Settings → Source control & issues to remove recognized
agent co-author and generated-by lines from GitHub merge and squash commit messages. Human
co-authors stay credited. The setting is off by default and projects can override it. It also
applies to auto-merge, but not merge queues or native stack merges. Original commits keep their
messages, so merge and rebase can still retain agent credits in those commits.

On web and desktop, hold **Shift** in the GitHub pull request list for quick actions.
To close several, press **Close**, drag across the rows in the same group, and release.
Press **Escape** before releasing to cancel. Failed closes stay in the list so you can retry them.

GitHub, GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also
supports approving waiting fork workflows and opening a revert pull request for a merged change.

Pull request sharing is off by default. In Settings → Environments → Pull request sharing (Pull
request routing under Environments on mobile), choose **Read PRs** or **Read and act** for each
environment you trust to share its source control access.
Enable both the original environment and the environment answering its requests on this client.
**Read and act** can use broader permissions than the original environment's credential;
only enable it for environments you control and trust. Changing a saved endpoint or removing an
environment clears its permission.

Review details, linked PR status, and permitted review actions can then use another connected
environment signed in to the same account on the same host. Each needs a project on that host.
A connected local environment is preferred for actions and can answer slow or failed reads.
Browsers and mobile clients need a paired environment to use its GitHub credentials.
Credentials stay on their machines. Previously verified credentials remain usable for routing
for ten minutes during a GitHub outage; new credentials must be verified first. An action with
an uncertain result is never automatically retried elsewhere. Listings, diffs, and checkout or
PR creation from Git actions continue to use the project's environment.

For Azure DevOps, use the host website to change comments. Bitbucket does not support reopening a
declined pull request.

### Review guides

Review guides are in beta. Turn on **Review guides** in Settings → Source control & issues to add the
**Guide** tab to pull requests on that server. On mobile, move between stops with **Next**
and the back button; a stale guide offers a rewrite and hides excerpts that no longer match
the current change.

The **Guide** tab gives you a tour of a pull request without reading it line by line: stops
through the change in reading order. Each stop points at the lines worth reading, and a stop marked
**Look closely** has a call only a maintainer can make. Mechanical changes such as renames and
snapshots are grouped at the end, and every changed file appears somewhere on the tour.
Conversations already resolved in review are left out. For a pull request in a stack, the guide
covers that layer only, and may point out what a lower layer introduced or what a higher one uses.

Choose **Write guide** to have the review guide model from Settings → Source control & issues read the
change in a temporary checkout; without one set, the source control writer model is used. Nothing
in the checkout is changed, and a large pull request takes a few minutes; you can go elsewhere in
the app. On web, you are told when the guide is ready; on mobile, return to the guide to check
its progress. Claude and Codex can write guides. Claude writes them with your user settings, but
tool approvals in those settings do not apply: it reads files and runs `git diff`, `git log` and
`git show`, nothing else. The guide is
kept for everyone using this server. To write it again, for example after a push or after changing
the model or instructions, choose **Rewrite guide** from the pull request's **⋯** menu.

On web, while reading a stop, select lines in an excerpt to add a comment to your review or ask an agent
about them; comments wait with the ones from the **Code** tab until you send the review. Choose a
suggested question, or **Ask about this stop**, to open a thread that already knows which stop you
are on. **Finish review** on the last stop opens the review with everything you collected.

Agents can write guides too: ask one to prepare guides for a set of pull requests, and it starts
them for you. Each is read through the project whose checkout has that repository.

To shape guides to your taste, write **Review guide instructions** in Settings → Source control & issues,
such as what to show first or what to skip; projects can override them. They change emphasis and
ordering, not the guide's layout or which files it covers.

### Mark files as viewed

Tick a file off in the **Code** tab once you have read it and it collapses; the toolbar keeps a
running count. A tick belongs to the pull request rather than to a commit, so scoping the tab to a
single commit keeps them. A file pushed to after you cleared it comes back marked **Changed**.

On GitHub these are GitHub's own viewed marks, so a review carries between T3 Code and github.com
in either direction. Forgejo, GitLab, Bitbucket, Azure DevOps, and Cursor Origin expose no record
T3 Code can read, so the server you are connected to keeps them instead: they follow you across the
apps connected to that server, but the host's own site will not show them, and the count reads **viewed in T3 Code**.

On mobile, open a changed file and mark it viewed from its header. Viewed files collapse,
and their marks follow the same rules as on web and desktop.

## Roadmap and issue work

The roadmap shows a GitHub repository's issues by the state of their work. Use it to start, queue
and follow agent work on issues. To read and edit issues across all your projects and trackers,
switch to the [List view](#issues).

The roadmap needs a connected environment with GitHub Issues support. It appears in two places:

- **The Issues panel** shows one repository beside a thread: the repository of that thread's
  project (for a fork checkout, the fork itself). Open it with **Issues** (shortcut `I`) from the
  empty right panel or its **+** menu, or with **Show issues beside thread** in the command
  palette. A thread's details list the same roadmap in a shorter **Issues** section; **Browse all
  issues** there opens the panel. To hide that section, turn off **Issues in thread details** in
  **Settings → Source control & issues → Issue work & branch picker**.
- **Board** is the default view on the Issues page. It lists the repositories your GitHub account owns and the organization repositories
  you administer, grouped by owner with your own account first. Repositories you only collaborate
  on, including the upstream of a fork, are left out. Select a repository to open its own board.
  Use **Repositories** to return to the directory. Add the repository as a project in T3 Code to
  see its issues.

Select an issue to open it in a tab next to the Issues panel or beside the board. Its work section holds **Start agent**,
**Add to queue**, **Prepare draft**, the issue's work state, GitHub Project fields, sub-issues,
blockers, pending decisions and changes. A linked pull request opens in the pull request panel,
and its back arrow returns to the issue. A link to an issue in one of your projects' repositories
opens the same panel. **Prepare draft** opens a new thread for the issue's project in a worktree
on a branch named after the issue, with an unsent prompt. You can also drag an issue onto the
composer, or type `#` there, to reference it in chat.

Use **Filter** to choose what is shown: open and closed issues, assignment, and how issues are
sorted. In the Board view it also chooses among archived, forked, empty, public, private,
personal and organization repositories. Open issues are shown by default, with archived, forked
and empty repositories hidden. Filter choices are remembered in that browser. The search box
matches issue numbers, titles and other issue details. The roadmap updates by itself when T3
Code changes an issue or its work, and within a few minutes of a change made on GitHub;
**Refresh** reads it again at once.

To keep one repository visible on the Board while its kind is hidden, such as a single
fork, show it once, then use the pin button on its row. A pinned repository ignores the
repository filters but still follows the issue filters and search. Pins are remembered with your
filter choices.

The board shows one repository's cards by GitHub issue status. Cards show labels, blockers,
linked pull requests and live worker state. Open the board in the right panel while you work in
a thread. When the panel is narrow, statuses stack with **Todo** at the top and the closed
statuses collapsed. The **Issues** section in thread details
groups the same issues by work stage so you can find running, queued and reviewable work while
you chat. Hover an issue to see its author and comments.
A thread’s own linked pull request also associates it with the issues that GitHub identifies
that pull request as closing.

Include **Closed** in Filter to see completed issues alongside issues closed as not planned or as
duplicates. Archived worker links remain available
on closed issues. Open a worker from its row, or confirm **Remove worktree** to remove its local
checkout while keeping its branch. Removal checks for active workers, shared worktrees, open terminals
and provider sessions, and local changes; a refusal appears on the row. This explicit action does not
wait for Storage cleanup's age or policy thresholds. Confirm **Delete local branch** to remove a branch
after its PR is merged. A branch checked out in any worktree cannot be deleted;
remove the worktree or switch its branch first. Unmerged work, including local commits added after
the PR merged, needs a separate explicit confirmation before deletion. These actions affect only
the local repository; they do not delete remote branches.

Select a pull request on an issue row to open it, or select the count to choose among several.
These links follow **Open pull requests in T3 Code**; middle-click opens them in the browser.
Select a work indicator to open its linked thread; hover to see the thread's branch, worktree and
pull requests. To include work started outside **Start agent**, ask the agent to link the issue it
is working on. Ordinary threads and delegated workers can both link issues.

To assign the repository orchestrator, right-click an unarchived top-level thread in its project
and choose **Make repository orchestrator**, or use that action in the command palette.
Choosing another thread moves the role after live issue work drains. If none is registered when
an issue is queued or a marked cross-project item reaches the Inbox, T3 selects the most recently
active eligible Orchestrator thread in the repository's project. Without one, work waits.

To stop coordinating a repository permanently, open its project settings and choose **End repository
orchestration** from the orchestrator actions. Finish or cancel outstanding work, remove queued
issues, and cancel any pending handoff first. Deleting a project ends its repository orchestration and drops queued issues and unclaimed start requests.
Archiving or deleting an idle orchestrator thread also ends orchestration; live work must finish or be cancelled first. You can set up orchestration again through Start agent or Make repository orchestrator.

To run issue work, open an issue, choose **Start agent**, then a model role and the
matching repository project. Use a model role with an available Codex or Claude target.
**Start agent on issue…** in the command palette opens the Issues panel for the current
repository, or the Board view on the Issues page when there is no current repository.
If no repository orchestrator is registered, choose an existing lead in the matching project or
explicitly choose **Create first orchestrator**. When you open issues beside a thread, its lead
is selected for you. A thread becomes the repository orchestrator only from the main checkout on the
default branch. While no issue workers run, it may switch that checkout to its own branch and use
native subagents for its own work; issue work still goes to workers.
Start agent registers the selected lead and starts or queues an issue worker, following the issue
parent tree. Later starts use that orchestrator's project. Managed issue workers share a pool
of reusable worktrees at `.worktrees/slot-1`, `.worktrees/slot-2`, and so on, with one slot per
allowed worker. Each worker starts on its own issue branch from the freshly fetched remote
default branch. When existing workers hold every slot, new workers wait in the queue. A settled
worker's slot can return to the pool once the checkout is safe to clean and its work is included in
the default branch or its pull request has merged.
On a closed issue, **Remove worktree** can return a clean slot while keeping the local issue branch.
If Git can't clean a slot because it contains a nested repository, move that repository out of the
slot or list its path in `issueWorktreeKeepPaths` in the default branch's `t3.json`.
Starting allows T3 to update one status comment and publish a closeout comment for each finished
attempt; the publishing policy is shown before you start. When a worker has been created, select
its name to open its conversation with the issue beside it. A queued start can appear before a
worker exists; use the **Orchestrator** link in **Settings → Projects → Repository orchestration** to open the lead.
**Linked issue** in thread details opens the issue beside that thread. A worker labeled **Done**
has a closed issue or a merged pull request. A merged pull request can leave the GitHub issue open.

The Issues board follows GitHub status: **Backlog**, **Todo**, **In progress**, **In review**,
**Done**, **Not planned**, and **Duplicate**. Move a card with its handle or the issue’s state
menu. Owner and agent drafts default to **Todo**. Use **Backlog** for triage or redesign.

**Todo** is the starting point for managed workers. **Add to queue** gives a Todo issue priority.
Queued issues go first in queue order, then other Todo issues go oldest first as worker slots
open. A blocker, an existing claim, **Needs you**, or **Needs orchestrator** holds admission.
The optional GitHub labels `writer`, `designer` and `routine` set the worker role or level.
Unlabeled work uses the complex Implementor role.

A claim moves the card to **In progress**. A ready pull request moves it to **In review**.
Use a closing reference on a code PR so merging into the default branch closes the issue as
**Done**. Moving the card leaves any existing worker running.
After a failed attempt, T3 retries once and then applies **Needs you** with a failure note.
An owner reply changes the hold to **Needs orchestrator**. The orchestrator reviews the reply,
updates the issue, clears the hold, and returns actionable work to **Todo**.

Repository orchestration is managed in **Settings → Projects**, under the project that holds the
repository's checkout; the section is named **Repository orchestration**. It shows the
orchestrator, the limits and the repository **Status**. Until a repository has
an orchestrator the section only says so, because the limits need one. The roadmap keeps no
such controls. It shows a single status line with a **Project settings** link while repository work
has a pending handoff or issues on hold.

To change how much issue work runs at once, edit **Workers** in that section. The limit starts at 4 and can be set from 1 to 32; **Workers** shows how many slots
are in use. Raising it starts eligible queued work. Lowering it lets current workers finish and
holds new starts until there is room. A slot covers a managed worker preparing, running, waiting,
or awaiting your response. Queued workers and completed workers, including those with an open PR,
do not hold slots. The repository orchestrator also runs outside the worker limit. Read-only
Designers and Reviewers use a separate **Read-only** limit in the same section, initially
4 and adjustable from 1 to 32. It covers children throughout the repository's thread tree, including
restart continuations. Excess requests wait in order until a slot frees. Raising the limit starts
queued children; lowering it lets current children finish. Agents can set either limit through
`set_repository_worker_limit`, using `workerLimit` or `readOnlyLimit` and the current revision.
Read-only children share their parent's checkout unless another isolation is requested; an issue
link gives visibility without claiming its work.

An issue worker paused by an open GitHub blocker resumes by itself within about a minute after
all its blockers close.
If an issue closes during work, cancel or finish its remaining work, then use **Close out attempt**
under the repository's **Status** to finish the retained attempt and clear its hold.

Issue agents can create issues, split work into sub-issues, and move cards between GitHub statuses.
To require approval for these too, turn on **Ask before agents create, split or move issues** in
**Settings → Source control & issues → Issue work & branch picker** for the server. This applies to new
proposals; existing proposals keep their approval decision. Body edits, closing or reopening issues,
and other parent changes also apply right away, unless the agent thread is in **Approval required**
mode; then they wait for you. Review a waiting change in the issue's panel, then approve or
reject it. Results stay visible there, and failed changes can retry
their remaining steps. If the issue changed since the
preview, the agent must propose a new change. If GitHub may have created an issue but T3 cannot
recover it, the change needs your attention. Check GitHub, then choose **Mark resolved** to stop
its remaining writes. Propose another create only when you intend to create another issue.

By default, T3 automatically hands off a Claude or Codex repository orchestrator at the first
safe idle boundary after its eighth provider compaction of a full context. Idle and manual
`/compact` are excluded. The count starts at zero in the successor. T3 archives the old thread
after the successor verifies it can continue.
Open **Settings → Threads → Orchestration** to turn this off or change the count for the
environment or a project.

To replace the orchestrator's conversation manually, open **Repository orchestration** in the project's
settings, choose **Hand off to a fresh thread** from the menu beside its orchestrator, and provide a
summary. Starting the handoff pauses new issue admissions while existing workers and their final
results finish. The fresh thread receives your summary and a recovery inventory. T3 transfers
ownership and archives the previous orchestrator after the fresh thread verifies it can continue.
Saved requests
from an older build proceed when their source thread has full access and is in default mode.
You can cancel a pending handoff in Settings. Open **Previous orchestrators** in the same
menu to read archived conversations. The server's **Archived worker retention** setting
also controls when it removes these conversations. The default is 14 days.
For a routine provider or model change, keep the same thread.

To restore orchestration, choose **Use another thread as orchestrator** and select a top-level
thread in the same project. T3 waits for active workers and pending deliveries before transferring
ownership. Cancel any unclaimed start requests to unblock the transfer. Existing worker threads stay
available and the new orchestrator takes over Todo admission.

### Cross-project issue inbox

The **Inbox** section of a repository's roadmap holds issues opened and comments posted by
another project through `t3_issue_post`, as well as owner replies on issues marked **Needs you**.
T3 checks repositories with an orchestrator every five minutes and other project repositories every
15 minutes. It notifies the orchestrator of unacknowledged items at most once every 15 minutes.

The orchestrator reviews each item, revises it if needed with `propose_issue_change`, then
acknowledges it with `t3_issue_inbox` `mark_read`. You can also acknowledge it with **Mark read**.
An open issue stays only in Inbox until its opening is acknowledged, and appears on the board under its GitHub status. A comment leaves its issue in its current section.
Cross-project writes keep their `external`, `priority: high`, and `from:<project>` labels.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  check the credentials saved in Settings → Source control & issues, or confirm the running server received
  the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0, or save a token in Settings → Source control & issues.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

## Linked pull requests

A thread can hold several pull requests, including reviews from another repository on the same host.
Use **Link pull request** in the command palette or **Linked items** panel, or right-click a
pull request link in the conversation. Creating a pull request from Git actions links it automatically,
and so does an agent creating one with `gh pr create` or `glab mr create`. Agents can link other
pull requests with the `link_pull_request` tool.

Agents can also read, open, update, reply on, and merge pull requests in the thread's repository
through T3 Code's own tools, which use the same sign-in as the Pull requests page. An agent merges
only the commit it last read: if someone pushed since, the merge is refused. On github.com an
agent can also land a GitHub stack in one merge, like **Merge stack** below.

Use **Link pull request to thread** in the command palette to keep a pull request with the thread. From a review
on the Pull requests page, **Link to thread** lets you search for an active thread. The review header
also lists the threads that link to it, including archived threads, so you can return to their context.

Thread badges show a stack's layer count or the current review number with a count of additional
links. Clicking a badge with more than one review opens the **Linked items** panel. On mobile, the Git overview lists linked reviews and their stacks; tap a review to open it.
Linking and unlinking are available in the web and desktop clients.

The **Linked items** panel lists every review and groups stacks. Unlink a review from its
row menu. An unlinked stack layer stays out of later syncs. Open linked reviews refresh on the server;
closed reviews refresh periodically so reopening one on the host is detected. Merged reviews refresh
when requested. Settling a thread refreshes its open and closed reviews once; after that they stop refreshing until you unsettle it. With **Auto-settle merged threads** enabled, a thread can settle after every linked
review is terminal. An open or unsynced link keeps it active.

Ask the agent to watch, monitor, or babysit a pull request and it calls `watch_pull_request`. While
the thread is active, the server checks the pull request every two minutes and wakes the agent when a
check fails or waits for a maintainer's approval, the required checks pass, the other checks finish after a failure, someone else comments or reviews, or the branch starts to
conflict. On github.com it also wakes the agent, with GitHub's reason, when the merge queue drops
the pull request without merging it. Threads in a project that watch the same pull request share one check. On GitHub, a check
first asks whether anything changed and reads the pull request only when it did, which keeps
watching inside GitHub's rate limit. Comments from your own account do not wake it. When the pull
request merges or closes, watching ends, and the agent is woken once unless it merged or closed the
pull request itself with the host's CLI. A reopened pull request needs a new watch. Watching also ends after 10 wakes in a row that bring only comments, after 8
failed reads in a row, or when you press Stop on the thread. A rate limit only pauses watching.
Settling or archiving a thread also ends all its watches. Unsettle the thread before starting a new
watch. Watching a pull request again does not repeat check or conflict news its last
watch already reported; unlinking the pull request clears that. Subagents cannot watch pull requests; the thread that delegated to them does. To start or stop
it yourself, use the row menu in the **Linked items** panel. In the thread details card, a
watched pull request shows an eye; click it to stop watching.

A watched thread counts as working while the pull request still has checks running, so it stays in
the **Working** section, including after the agent pushes a fix. Once every check has finished,
including review bots that report as checks, the thread returns to your inbox: what happens next is
up to a person. That includes a workflow waiting for a maintainer to approve it, which runs only
once someone does. If you ask the agent to act on the pull request itself, such as merging it once
a teammate approves, the thread stays in **Working** until the pull request merges or closes. The
watch stays on and still wakes the agent on new comments, failed checks or conflicts, and a watched
thread never auto-settles.

Cross-repository links use a project on the same host. Azure DevOps reviews require a project checked
out from the matching organization and repository.

## Issues

Open **Issues** from the sidebar or choose **Open issues** in the command palette. Switch between
the GitHub **Board** and the full **List**. T3 Code remembers your choice.

**List** shows the issues of every project whose remote is on GitHub, GitLab, Azure DevOps or
Forgejo, grouped per tracker account. Filter by open or closed, by your involvement (assigned, opened by you, mentioning you), and
by tracker. Under **Projects**, uncheck the projects you do not want to see; the list remembers
them, and a project you add later shows. The search box asks the tracker itself where it can
search. Press **Load more** at the end of a group to read further back.
The **Views** menu saves and restores a search, filter, and sort setup, as it does for pull
requests.

To list Linear issues beside a project's, connect Linear with an API key under
Settings → Source control & issues, then pick one or more teams for that project there. Pick
another team at any time to add it; uncheck every team to unbind the project. Each team's
issues appear in the Linear group of the issue list, sorted with the rest by last update, and
each can be loaded further on its own. Agents file new issues in the first team picked unless you name another bound team. To
connect another Linear workspace or user, add another account in the same place; each project
reads its teams through the account you picked them under.

Select an issue to open it beside the list: description, comments, state changes, linked pull
requests, labels, assignees, and reactions. Linked pull requests open in the same panel. You can
comment, edit the title and description, change labels and assignees, react, and move it to
another state when the tracker and your account allow it. Where a GitHub repository has issue
statuses (Backlog, Todo, In progress, and so on), those are the states you move between, as a
Linear team's workflow states are; elsewhere you close or reopen, with a close reason where the
tracker records one. An issue read through a project that does not own its repository is shown read-only.

An issue can be kept with a thread the way a pull request can: open it beside the thread (issue
links in the conversation open there) and use **Link to this thread** in its header; **Unlink**
undoes it. Click the issue badge in the thread sidebar to see its issues and pull requests in
**Linked items**. Select an issue there to open it beside the thread. Agents link the issues they
work on with the `link_issue` tool.

Writing to a tracker over a remote connection requires the `source-control:write` scope.

## GitHub stacks

The Pull requests page shows each PR's position in its GitHub stack. Open the stack badge in a
review to navigate its layers. **Merge stack** submits the selected pull request and every unmerged
layer below it to GitHub together, respecting branch rules and merge queues. The confirmation shows
the scope and merge strategy. GitHub rebases the remaining stack after merging.

**Rebase stack** updates remote branches from bottom to top without changing your local checkout.
It can rewrite history and restart checks. If a layer fails, earlier updates remain; resolve that
layer before retrying. GitHub may require manual conflict resolution after a lower layer is amended,
even when its changes look independent. Stack actions require an environment that supports them.

## Owner decisions

When Don't ask mode is on, agents can request a decision on a GitHub issue or pull request instead of asking you in the thread, with two to four choices, a recommendation, evidence, and the consequence of each choice. Open **Decisions** in the Board view on the Issues page, a thread's Issues panel, or the Pull requests page, or answer from the issue or pull request detail. The all-projects view gathers decisions from connected environments and warns when an environment is unavailable.

Only T3's signed-in owner interface accepts a choice. Agents and Ask mode cannot choose. T3 records the choice in a GitHub comment, then notifies the requesting thread. Temporary publication or delivery failures retry automatically. Comment mismatches and unavailable requesters without a successor stay visible and stop retrying. While Ask mode is on, agents ask you with their question tool and T3 refuses new decision requests; decisions already open stay available. A decision does not approve a separate issue-change preview. This identity guarantee uses the owner login boundary: it cannot prove a physical person clicked if someone else has the owner's credentials.
