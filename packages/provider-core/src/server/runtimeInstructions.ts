const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: one link_pull_request per PR, full URL, every stack layer, as your next call. Host tools do not link for you. If linking fails, say so. Skip PRs you only read or review, and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. Never wait with sleep, loops, gh --watch, Monitor, or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch.
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
