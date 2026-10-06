import type {
  ClientSettings,
  DiscoveredLocalServer,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { useMemo } from "react";

import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { useClientSettings } from "~/hooks/useSettings";
import { useDiscoveredPortsState } from "~/portDiscoveryState";
import { isLocalServerHidden } from "./localServerHideRules";

export interface PreviewableServer extends DiscoveredLocalServer {
  source: "scanner" | "configured";
  /**
   * Pre-resolution loopback url. `url` is the resolved navigation target
   * (volatile on a remote environment); history must key off this instead.
   */
  requestedUrl: string;
}

/** The thread the list is shown for; its project's and terminals' servers rank first. */
interface ActiveScope {
  projectId: ProjectId | null;
  threadId: ThreadId | null;
}

interface UseDiscoveredLocalServersInput {
  environmentId: EnvironmentId;
  configuredUrls?: ReadonlyArray<string> | undefined;
  active?: ActiveScope;
}

const selectHideRules = (settings: ClientSettings) => settings.browserLocalServerHideRules;

/**
 * Enrich the environment-level live server snapshot with matching configured
 * URLs, drop servers the user's hide rules cover, and return a stable ranked list.
 */
export function useDiscoveredLocalServers(input: UseDiscoveredLocalServersInput): {
  servers: ReadonlyArray<PreviewableServer>;
  hiddenCount: number;
} {
  const scannerState = useDiscoveredPortsState(input.environmentId, input.configuredUrls);
  const hideRules = useClientSettings(selectHideRules);
  const activeProjectId = input.active?.projectId ?? null;
  const activeThreadId = input.active?.threadId ?? null;

  return useMemo(() => {
    const visible = scannerState.servers.filter(
      (server) => !isLocalServerHidden(server, hideRules),
    );
    return {
      servers: mergeServers({
        scanner: visible.map((server) => ({
          ...server,
          url: resolveDiscoveredServerUrl(input.environmentId, server.url),
          requestedUrl: server.url,
        })),
        configuredUrls: input.configuredUrls ?? [],
        configuredUrlProbing: scannerState.configuredUrlProbing,
        active: { projectId: activeProjectId, threadId: activeThreadId },
      }),
      hiddenCount: scannerState.servers.length - visible.length,
    };
  }, [
    input.environmentId,
    scannerState,
    input.configuredUrls,
    hideRules,
    activeProjectId,
    activeThreadId,
  ]);
}

export function mergeServers(input: {
  scanner: ReadonlyArray<DiscoveredLocalServer & { requestedUrl: string }>;
  configuredUrls: ReadonlyArray<string>;
  configuredUrlProbing?: boolean;
  active?: ActiveScope;
}): ReadonlyArray<PreviewableServer> {
  const configuredByServer = new Map<string, { host: string; port: number; url: string }>();

  for (const url of input.configuredUrls) {
    const parsed = parseLocalUrl(url);
    if (!parsed) continue;
    const key = canonicalKey(parsed.host, parsed.port);
    if (!configuredByServer.has(key)) configuredByServer.set(key, parsed);
  }

  const live: PreviewableServer[] = [];
  for (const server of input.scanner) {
    const key = canonicalKey(server.host, server.port);
    const configured = configuredByServer.get(key);
    live.push({
      ...server,
      requestedUrl:
        configured && input.configuredUrlProbing === false ? configured.url : server.requestedUrl,
      source: configured ? "configured" : "scanner",
    });
  }

  // Configured URLs come from the active project's scripts, then the active
  // project's and thread's own servers, then everything else; by port within each.
  const rank = (server: PreviewableServer): number => {
    if (server.source === "configured") return 0;
    const projectId = input.active?.projectId;
    const threadId = input.active?.threadId;
    if (projectId && server.projectId === projectId) return 1;
    if (threadId && server.terminal?.threadId === threadId) return 1;
    return 2;
  };
  return live.toSorted((a, b) => rank(a) - rank(b) || a.port - b.port);
}

function canonicalKey(host: string, port: number): string {
  const normalizedHost = host.toLowerCase();
  return `${isLoopbackHost(normalizedHost) ? "loopback" : normalizedHost}:${port}`;
}

function parseLocalUrl(raw: string): { host: string; port: number; url: string } | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!isLoopbackHost(parsed.hostname)) return null;
    const port = parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === "http:"
        ? 80
        : 443;
    if (!Number.isFinite(port) || port <= 0) return null;
    return { host: parsed.hostname, port, url: parsed.href };
  } catch {
    return null;
  }
}
