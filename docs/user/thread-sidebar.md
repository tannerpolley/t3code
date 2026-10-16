# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

To move a worktree thread back to the project's main checkout on web or desktop,
choose **Move to main checkout** from its workspace control. This ends the live agent
session; your next message resumes the conversation in the main checkout on its
current branch. The previous worktree stays on disk.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from **New thread in...** in the command
palette, or press `mod+alt+n`. On mobile, pick **No project** from the project
list. It starts on your current machine; before sending, pick another machine
from the machine menu to move it there. To move a draft into a project, pick the
project in the heading.

Each thread without a project works in its own folder under `~/.t3/scratch` (the
`scratch` folder of your T3 data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git project.

## Organize projects

On web and desktop, use the folder button beside search to switch between
**Projects** and **Activity**. Projects keeps sections, projects, and their
threads together. Expanding a project leaves other projects available. Activity
keeps the pinned, active, Working, snoozed, and settled lists; its project menu
explicitly filters the list, with **All projects** as the default. In Projects, each
project's threads follow **Settings → General → Thread order**: last user message
or creation time.

Choose **New section** to group projects. A section's menu can add a subsection,
choose its color or folder icons, add an existing project, or create a new project
folder. Move a project between sections by dragging its row or choosing a section
from its menu. Removing a project clears its saved conversations after confirmation
and keeps its files on disk.

Sections, their order and nesting, project placement, and section and project
expansion are shared by every web or desktop window connected to the same
environment. Changes appear immediately in the window you are using and sync to your other windows shortly afterward. Projects remain in
their section when a clone finishes or you change project grouping. Each
environment owns its sections; place a project in a section on its own environment.

After upgrading, the first connected window with a saved layout imports it if this
environment has not imported one before. Earlier sidebar edits do not prevent the
import, and sections created since the upgrade are kept. Only sections containing
this environment's projects, including their parent sections, are imported; empty
sections go only to the primary environment. If two
windows have different saved layouts, the first accepted layout wins; the other
window adopts it. Later windows cannot overwrite it, even after every section is
removed. Your old saved copy is kept while any of your environments still needs it.

Your Projects/Activity choice, project filter, grouping preferences, and other
thread view preferences stay local to each window. Older servers keep a local
layout, including expansion choices. Read-only connections to environments with
shared sections show the shared layout and receive updates. Saving changes requires
permission to save settings.

Agents can read section IDs from the environment and place a project when creating
or updating it. Ask an agent to put a new project in a named section and expand it;
placement is saved as part of creating the project.

In **Settings → General**, **Organize by folder** builds sections and subsections
from a root folder, and **Keep projects organized by folder** places new, unsorted
projects there; projects you move by hand stay where you put them. The same page
controls the Projects view, project row style, and revealing the thread you open.
Folder colors, default icons, and the sidebar toggle position live in **Settings → Appearance**.
Adjust the title text size for each Projects view row type under **Settings → General → Sidebar & projects**; choose **Default** to restore that row’s text size.

Drag a thread from Projects onto the composer to add it as context for your next
message; subagent rows in Projects and rows in **Lineage** drag the same way.
Running subagents and background tasks appear beneath their parent
thread: its own background tasks first, then its native subagents, then app-owned
children, each followed by its own work.

With **Codex-style sidebar** on, each project lists its threads grouped by the
location they work in: the project's own checkout first, then each worktree. A
child agent working in a worktree is listed with that worktree even when its
parent works in the local checkout, with the agents working alongside it nested
under it. It keeps its family's tint color.

Within a location, only its lead thread shows the checkout icon: the implementor
in a worktree; in the local checkout, the orchestrator if there is one, otherwise
the implementor or top-level thread. Hover the icon to see **Local** or the
worktree folder, led by the environment's name when it is elsewhere. A child's
question or approval also appears on the parent.
An amber spinner means the thread is waiting on its background work. Times show
how long the work has run, such as **05m 09s** or **01h 05m 09s**, rather than time
since the last message.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show
a notification with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position, and reopens an archived thread you were
viewing. Discarding an unsent draft from the sidebar works the same way: Undo brings
back its text and attachments. `mod+z` triggers the most recent Undo when no text field is focused; see
[Keybindings](./keybindings.md#commands-with-special-behavior).

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; **Done** returns to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the T3 Code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

To retitle a thread after what it is working on now, open its menu and choose
**Regenerate title**. It uses GPT-6 Luna through the server's Codex provider, tells you when the
current title still fits, and makes a title you typed automatic again. The action is unavailable
while title generation is in progress or when the connected environment needs a server update.

**Keep thread titles current** in **Settings → General** (on by default) does the same about
every ten minutes for top-level threads with new messages. Titles you typed are never changed
automatically, and nothing runs when the server has no Codex provider.

Agents connected through T3 Code can use the same server-owned metadata workflow to
rename a thread, regenerate its title, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

### Fold working threads (beta)

Turn on **Settings → General → Working section (beta)** on web and desktop, or **Settings →
Thread behavior → Working section** on iOS and Android, to move threads that are working or
monitoring into a collapsed **Working** section below the active list. A thread returns to the top
of the active list when it finishes, fails, or needs an approval or answer. The Working section
lists the thread you last sent work to first. Pinned threads stay in the pinned section. Each
device keeps its own choice.

While this is on, the active list is ordered by when each thread last came back to you, so you
cannot drag or move threads within it. Your saved order returns when you turn it off.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the thread's
terminals that wait at an idle prompt, and keeps their output. A terminal that
runs a command, such as a dev server, stays open.

To reclaim disk space from settled work, turn on **Run in the thread's worktree when the
thread settles** for one of the project's actions, or set `"runOnSettle": true` on a
`t3.json` script, for example `cargo clean`. It runs each time a thread in its own
worktree settles, manually or automatically, even if a terminal there still runs a
command such as a dev server. Threads in the project's main checkout skip it. Its terminal
closes when the command succeeds and stays open when it fails.

On web and desktop, press a thread's **Settle** button and drag up or down to
settle every thread in that section between it and the one you release on.
The **Un-settle** and **Wake** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement unless you turn on **Keep threads with a PR** in **Settings → General**,
but an old closed or merged pull request does not settle work you
resumed after it closed. Only your own messages count as resuming. A turn that
finished background work or a pull request watch starts on its own does not.

To keep one thread out of the settled shelf no matter how long it sits idle, open its menu,
choose **Auto-settle behavior**, and pick **Disabled**. The current option is checked. Pick
**Enabled** to return to the usual rules. Manual settle, snooze, and archive still work while it
is disabled.

Change these rules in **Settings → General** on web and desktop, or **Settings → Thread behavior** on mobile.
They continue to run when your apps are closed. On web and desktop, choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
On web and desktop, press **Resume** in an empty composer to continue a limited
or interrupted turn manually.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

On web and desktop, choose **Usage limit recovery** in **Settings → General**:

- **Off** leaves recovery to you.
- **Wait for reset** snoozes and continues limited threads when the reported allowance returns.
- **Switch provider** moves the limited thread between Codex and Claude and sends
  “Continue where you left off.” with a context handoff. Other threads and children keep running.
  Switching proceeds without asking, including in Don't ask mode.

A thread uses its role's available alternatives, ordered by weekly headroom. Implementor threads
use the profile matching their current model and effort, or the first configured Implementor
profile if none matches. If the role has no available choice on another provider, the thread
uses the fallback model configured for that provider.
Set each fallback's effort separately; efforts are not translated.
If no alternative is available, the thread says so and waits for reset. Without a reported reset
time, retry manually.

The thread stays on its new provider after the original allowance returns. Its recovery notice
has **Switch back** to restore the original model and effort. You can also change the provider
through the normal model picker.

When a delegated child hits a limit, Off and Wait for reset report the failure to its parent
immediately. Switch provider allows up to two minutes for the continuation to start; otherwise
it reports the failure. A reset-time resume after that is separate follow-up work on the child.

Choose **Resume at reset** or **Snooze until reset** in an individual thread to override its
waiting behavior. Snooze and auto-resume remain independent per thread; **Wake now** cancels
snooze. Existing saved defaults keep their previous resume/snooze behavior under **Wait for reset**.
Mobile retains its existing thread behavior controls.
The environment must be running when the reset arrives; it resumes overdue continuations after
a restart. Sending a new message, archiving, or settling prevents a pending continuation.

On web and desktop, open **Agents** to follow delegated work and **Lineage** to see
parent and fork relationships. Stop on a thread also stops the subagents it delegated to.
You can stop a running native Codex or Claude subagent from its row while its
parent keeps working. Codex Stop interrupts the child's current turn and its
descendants; Claude Stop uses its native task control.
Use **Clear** under **Previous agents** to hide finished agents, and **Show** to restore
them. To clear them automatically, set **Settings → General → Clear finished agents
automatically** to 30 minutes or 1 hour. Turn off **Redesigned Lineage** there for the
original rows.

Click a Codex or Claude background command or monitor in Projects to open a popup
beside it with its command, whether it is still running, a Stop control and its live
output, which follows new lines until you scroll up. When the task ends, the popup
stays open and says so; click outside it or press Escape to close it. In Lineage and the
background-work line above the composer, **Show output** opens the output in place.
Turn off **Settings → General → Background process output** to disable this.

In Projects, a thread's background tasks fold into one summary row above its subagents,
such as `1 task · 3 commands · 5 processes`. It starts collapsed; click it to list them.
With the experimental **Show running commands and processes** setting on, the row also
counts the commands the thread's agent is running now and the processes those commands and
background tasks started. When open, processes of the same program share one row, such as
`python ×10`, with hover showing the full command, and each thread shows up to five such
rows. Claude shows a foreground command's output only when it finishes, and cannot stop it
on its own; Codex streams it and can.

To stop one background task, open its thread's summary row, hover the task's row and use
its Stop control. **Stop** above
the composer stops all the thread's background work. Finished and stopped tasks
leave the running list; stopped commands keep their stopped state in the conversation.
Claude can also report background monitors, while Codex reports terminal commands.
A non-server shell running for
over two hours is marked as possibly stuck.

To tell agents which model and effort suit each kind of delegated work, edit
**Model roles** in **Settings → Customizations** on web and desktop. Agents use these
roles at their own discretion; your explicit instructions in a thread win. The
standard roles are Orchestrator, Implementor, Reviewer, Investigator and Checker.
Implementor has separate Fast and Thorough profiles, each with its own model and
effort choices. Choices are ranked by available weekly usage; unavailable choices
are marked. Codex agents see changes on their next turn and
Claude agents in their next session. Reset model roles to get the latest
defaults; this replaces your customizations.

Every thread has a role. Threads that start in a worktree, or move into one, are
Implementors. Other threads you start are Orchestrators. Child agents are
Implementors unless their parent gives them another role. Forks keep their source's
role. A native provider subagent takes its role from its agent type: Codex's manager
is an Orchestrator; reviewer types are Reviewers; explorer or researcher types are
Investigators; tester or checker types are Checkers; and every other type, including
the default agents, is an Implementor. Role icons appear in thread rows and the chat
header.

Native provider subagents have a bot icon before their role icon and run on their
own. They cannot take messages; use **Open parent** to direct them. App-owned child
threads accept messages like other threads. Questions and approvals from either kind are routed
to their parent.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

To free resources from idle agents, set **Settings → General → Idle agent timeout**
on web or desktop. It is off by default. Working agents and pending questions stay
connected; the next message resumes a disconnected session. Finished native Codex
subagents are unloaded after the same interval.

## Snooze until later

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.

## Compare threads in Projects

With **Codex-style sidebar** enabled on web and desktop, the Projects view aligns each thread's location,
role, provider, model, effort, name, time, and work status. Model names show up to six
characters, with versions such as 5.5 and 6.1 lined up; hover the model for its full
name. Expand a thread to follow
its child agents. Child rows keep the same columns as their parent. A thread with
child agents and everything under it share one tint color, so each group stands out;
deeper rows take a slightly stronger shade. A thread without children has no tint.
Turn it off in **Settings → General** to use the classic rows and flat child list.
The Activity view keeps its cards.

Rows are titled by what each thread does rather than its task name: a thread working
on an issue shows the issue, such as **#42 Fix login**; every other thread shows its
role (Orchestrator, Implementor, Reviewer, Investigator, Checker), matching its role
icon. Hover a title to see the thread's name.

Widen the sidebar to compare all columns. As it narrows, effort disappears
first, followed by model. The caret, name, and work status remain.
