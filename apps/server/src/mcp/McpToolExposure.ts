import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { McpInvocationContext } from "./McpInvocationContext.ts";

export const TOOL_SEARCH = "tool_search";

/** Tools a fresh deferring client needs to discover work or act before discovery. */
export const DIRECT_TOOLS: ReadonlySet<string> = new Set([
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  "request_secret",
  "send_to_user",
  "t3_request_user_input",
  "t3_background_wait",
  "t3_thread_wait",
  TOOL_SEARCH,
]);

const MAX_RESULTS = 10;
// Sessions that ended are never reported here, so keep only the newest.
const MAX_SESSIONS = 256;

export interface ListedTool {
  readonly name: string;
  readonly description: string;
}

export class McpToolExposure extends Context.Service<
  McpToolExposure,
  {
    /** Finds tools for the query and lists them to the session from now on. */
    readonly search: (
      providerSessionId: string,
      query: string,
    ) => Effect.Effect<ReadonlyArray<ListedTool>, never, McpInvocationContext>;
    readonly isListed: (providerSessionId: string, tool: string) => boolean;
  }
>()("t3/mcp/McpToolExposure") {}

const score = (tool: ListedTool, terms: ReadonlyArray<string>) => {
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (term === name) total += 100;
    else if (name.includes(term)) total += 3;
    else if (description.includes(term)) total += 1;
  }
  return total;
};

export function searchCatalog(tools: ReadonlyArray<ListedTool>, query: string) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter(Boolean);
  return tools
    .filter((tool) => tool.name !== TOOL_SEARCH)
    .map((tool) => ({ tool, score: score(tool, terms) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .map((match) => match.tool);
}

export const make = (
  tools: Effect.Effect<ReadonlyArray<ListedTool>, never, McpInvocationContext>,
  announceListChanged: () => Effect.Effect<void>,
) => {
  const loaded = new Map<string, Set<string>>();
  const load = (providerSessionId: string, names: ReadonlyArray<string>) => {
    const listed = loaded.get(providerSessionId) ?? new Set<string>();
    loaded.delete(providerSessionId);
    loaded.set(providerSessionId, listed);
    for (const name of names) listed.add(name);
    for (const oldest of loaded.keys()) {
      if (loaded.size <= MAX_SESSIONS) break;
      loaded.delete(oldest);
    }
  };
  return McpToolExposure.of({
    search: Effect.fn("McpToolExposure.search")(function* (providerSessionId, query) {
      const found = searchCatalog(yield* tools, query);
      if (found.length > 0) {
        load(
          providerSessionId,
          found.map((tool) => tool.name),
        );
        yield* announceListChanged();
      }
      return found;
    }),
    isListed: (providerSessionId, tool) =>
      DIRECT_TOOLS.has(tool) || loaded.get(providerSessionId)?.has(tool) === true,
  });
};
