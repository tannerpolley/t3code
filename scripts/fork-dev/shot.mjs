// Screenshot the dev sidebar (Projects view, Codex-style rows, 32rem wide), opened threads and
// the GitHub sandbox's Issues views into ~/Workspaces-Dev/.t3-dev-fixture/shots/. `node shot.mjs issues` takes only the Issues ones.
// Pairs with the newest pairing URL in the t3-dev journal; the token is never printed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const pnpm = NodePath.join(import.meta.dirname, "../../node_modules/.pnpm");
const pkg = NodeFS.readdirSync(pnpm).find((name) => name.startsWith("playwright-core@"));
const { chromium } = NodeModule.createRequire(import.meta.url)(
  NodePath.join(pnpm, pkg, "node_modules/playwright-core"),
);
const journal = NodeChildProcess.execFileSync(
  "journalctl",
  ["--user", "-u", "t3-dev", "-o", "cat", "--no-pager"],
  {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  },
);
const pairUrl = [...journal.matchAll(/pairingUrl: (\S+\/pair#token=\S+)/g)].at(-1)?.[1];
if (!pairUrl) throw new Error("No pairing URL in the t3-dev journal");
const out = NodePath.join(NodeOS.homedir(), "Workspaces-Dev/.t3-dev-fixture/shots");
// Finished children remain reachable by route even when Projects hides their inactive rows.
const userdata = NodePath.join(
  NodeOS.homedir(),
  "Workspaces/Applications/t3code/.worktrees/fork-sandbox/.t3/userdata",
);
const environmentId = NodeFS.readFileSync(NodePath.join(userdata, "environment-id"), "utf8").trim();
const threadIdsByTitle = new Map(
  JSON.parse(
    NodeChildProcess.execFileSync(
      "python3",
      [
        "-c",
        "import json, sqlite3, sys; from pathlib import Path; " +
          "db = sqlite3.connect(Path(sys.argv[1]).as_uri() + '?mode=ro', uri=True); " +
          "print(json.dumps(db.execute('SELECT title, thread_id FROM orchestration_v2_projection_threads').fetchall()))",
        NodePath.join(userdata, "statev2.sqlite"),
      ],
      { encoding: "utf8" },
    ),
  ),
);
const OPEN_THREADS = [
  [
    "orchestrator",
    "Check: Claude task list above composer; single-choice and multi-select questions; proposed plan and plan mode",
  ],
  ["plan", "Check: plan mode: proposed plugin plan and Implement action; action starts real work"],
  ["question", "Check: Claude single-choice: two questions, recommendations and custom answer"],
  ["multi-select", "Check: Codex multi-select: choose several release gates before submitting"],
  ["approval", "Check: Approval: pending branch-delete command; inspect permission card"],
  ["usage-limited", "Check: Limited: usage-limit card and reset time; auto-resume is off"],
  ["failed", "Check: Failed: disconnected provider, error card and retry action"],
  // Last: it leaves the Diff panel open.
  [
    "login-timeout",
    "Check: open PR: passing checks, review required; inspect checkpoint Diff and inline shell result",
  ],
];

// A thread's own row button, named "<title>, <status>"; rows may show a role instead of the title,
// and a row's middle can be a nested child or task row.
const threadRow = (page, title) =>
  page
    .locator('[data-sidebar="sidebar"]')
    .first()
    .locator(`button[aria-label^="${title.replaceAll('"', '\\"')}, "]`)
    .first();

const browser = await chromium.launch().catch((error) => {
  if (!String(error).includes("Executable doesn't exist")) throw error;
  const cache = NodePath.join(NodeOS.homedir(), ".cache/ms-playwright");
  const executablePath = NodeFS.globSync("chromium_headless_shell-*/**/chrome-headless-shell", {
    cwd: cache,
  })
    .map((path) => NodePath.join(cache, path))
    .sort((a, b) => NodeFS.statSync(b).mtimeMs - NodeFS.statSync(a).mtimeMs)[0];
  if (!executablePath) throw error;
  return chromium.launch({ executablePath });
});
const onlyIssues = process.argv[2] === "issues";
// Projects view is what the owner reviews; Activity view also shows branch labels.
for (const mode of onlyIssues ? [] : ["projects", "activity"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 2200 } });
  await page.addInitScript((sidebarMode) => {
    const key = "t3code:client-settings:v1";
    const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(
      key,
      JSON.stringify({ ...settings, projectsView: true, codexStyleSidebar: true }),
    );
    localStorage.setItem("chat_thread_sidebar_width", "512");
    // The Projects/Activity switch is UI state, not a client setting.
    const ui = JSON.parse(localStorage.getItem("t3code:ui-state:v1") ?? "{}");
    localStorage.setItem("t3code:ui-state:v1", JSON.stringify({ ...ui, sidebarMode }));
  }, mode);
  await page.goto(pairUrl);
  await page.waitForSelector("[data-sidebar-thread-key]", { timeout: 60_000 });
  await page.waitForTimeout(2_000);
  const sidebarEl = page.locator('[data-sidebar="sidebar"]').first();
  await sidebarEl.screenshot({ path: NodePath.join(out, `sidebar-${mode}.png`) });
  console.log(`${mode}: ${await page.locator("[data-sidebar-thread-key]").count()} thread rows`);
  if (mode === "projects") {
    for (const [file, title] of OPEN_THREADS) {
      const row = threadRow(page, title);
      if (await row.count()) {
        await row.click();
      } else {
        const threadId = threadIdsByTitle.get(title);
        if (!threadId) throw new Error(`Seeded thread missing: ${title}`);
        await page.goto(
          new URL(`/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`, pairUrl)
            .href,
        );
        await page.waitForSelector("[data-sidebar-thread-key]");
      }
      await page.waitForTimeout(2_500);
      // Open the collapsed work log so tool calls, diffs and commands show.
      const worked = page.getByText(/^Worked for /).first();
      if (await worked.isVisible().catch(() => false)) await worked.click();
      const group = page.getByText(/^Ran \d+ commands?/).first();
      if (await group.isVisible().catch(() => false)) await group.click();
      // The turn's changed files open the Diff panel; expand one file in it.
      const openDiff = page.getByRole("button", { name: "Open diff" }).last();
      if (await openDiff.isVisible().catch(() => false)) {
        await openDiff.click();
        await page.waitForTimeout(6_000);
        await page.getByRole("button", { name: "Expand src/login.ts" }).click();
      }
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: NodePath.join(out, `thread-${file}.png`) });
    }
  }
  await page.close();
}

// The Issues views need GitHub data, so they use the real test repository. The full Issues page
// always shows milestones (closed issues gray with the Closed filter); the roadmap view, with
// blockers (red) and live work (blue), exists only in the panel beside a thread and lists open
// issues only.
const SANDBOX = "github.com/tannerpolley/t3code-sandbox";
const ORCHESTRATOR =
  "Check: real issues #6/#7 Working/Input, #15 open PR #24; roadmap and dependency colors; repository work paused";
const filters = (closed) => ({
  open: true,
  closed,
  archived: false,
  forks: false,
  empty: false,
  public: true,
  private: true,
  personal: true,
  organizations: true,
  milestone: "all",
  assignee: "all",
  sort: "number",
  pinned: [],
});
async function openWith(storage) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
  await page.addInitScript(
    (entries) => {
      for (const [key, value] of entries) localStorage.setItem(key, JSON.stringify(value));
    },
    Object.entries({
      "t3code:client-settings:v1": { projectsView: true, codexStyleSidebar: true },
      chat_thread_sidebar_width: 512,
      "t3code:ui-state:v1": { sidebarMode: "projects" },
      ...storage,
    }),
  );
  await page.goto(pairUrl);
  await page.waitForSelector("[data-sidebar-thread-key]", { timeout: 60_000 });
  return page;
}
/** Each issue's state mark, read from its aria-label, with the nearest issue number. */
const issueStates = (page, scope = "body") =>
  page
    .locator(scope)
    .first()
    .evaluate((root) =>
      [
        ...root.querySelectorAll(
          '[aria-label="Closed"],[aria-label="Blocked"],[aria-label="In progress"],[aria-label="Open"]',
        ),
      ].map((icon) => {
        for (let el = icon, depth = 0; el && depth < 6; el = el.parentElement, depth++) {
          const match = /#(\d+)/.exec(el.textContent ?? "");
          if (match) return `#${match[1]} ${icon.getAttribute("aria-label")}`;
        }
        return `? ${icon.getAttribute("aria-label")}`;
      }),
    );
const openOrchestrator = (page) => threadRow(page, ORCHESTRATOR).click();
{
  const page = await openWith({ "t3code:issues-filters": filters(true) });
  await page.goto(
    new URL("/issues?host=github.com&repository=tannerpolley/t3code-sandbox", pairUrl).href,
  );
  await page.waitForTimeout(8_000);
  await page.screenshot({ path: NodePath.join(out, "issues-page.png") });
  console.log(`issues-page: ${(await issueStates(page, "main")).join(", ")}`);
  await page.close();
}
{
  const page = await openWith({
    "t3code:issue-views": { [SANDBOX]: "roadmap" },
    "t3code:issues-filters": filters(false),
    "t3code:thread-issues-expanded": { [SANDBOX]: true },
  });
  await openOrchestrator(page);
  await page.waitForTimeout(8_000);
  await page.screenshot({ path: NodePath.join(out, "thread-details-issues.png") });
  await page.getByText("Browse all issues", { exact: true }).first().click();
  await page.waitForTimeout(8_000);
  await page.screenshot({ path: NodePath.join(out, "issues-panel-roadmap.png") });
  console.log(`issues-panel-roadmap: ${(await issueStates(page, "main")).join(", ")}`);
  await page.close();
}
await browser.close();
