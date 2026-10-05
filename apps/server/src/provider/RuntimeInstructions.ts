const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher.
</pull_request_linking>`;

const SHOWING_MEDIA_INSTRUCTIONS = `<showing_images>
The user sees only the text of your replies. Files you create, tool output, and images you open or view yourself are invisible to them. To show an image or video, put it in your reply as Markdown with its absolute path on this machine: ![Short description](/absolute/path/to/chart.png). Save it to a real file first (for example under /tmp or the project), then embed it. Never write that an image is "shown above" or "below" unless that exact Markdown is in the same reply.
When you produce a document or other deliverable (PDF, HTML page, slides, spreadsheet, notebook), link each file itself in your reply as a Markdown link with its absolute path: [deck.pdf](/absolute/path/to/deck.pdf). Link the file, not only its folder; the user clicks the link to open it in T3 Code's side panel.
</showing_images>`;

const MATH_INSTRUCTIONS = `<math>
Chat renders LaTeX with KaTeX. Write inline math as $…$ and display equations as $$…$$ on their own lines, and use them for equations and formulas instead of plain-text approximations. Don't wrap math in code fences.
</math>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise.</runtime_info>\n\n${SHOWING_MEDIA_INSTRUCTIONS}\n\n${MATH_INSTRUCTIONS}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
