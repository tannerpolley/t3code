import { ProjectId, ThreadId, type DiscoveredLocalServer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeServers } from "./useDiscoveredLocalServers";

const scannerServer = (
  overrides: Partial<DiscoveredLocalServer & { requestedUrl: string }>,
): DiscoveredLocalServer & { requestedUrl: string } => ({
  host: "localhost",
  port: 5173,
  url: "http://localhost:5173",
  requestedUrl: overrides.url ?? "http://localhost:5173",
  processName: "vite",
  pid: 1234,
  terminal: null,
  ...overrides,
});

describe("mergeServers", () => {
  it("ranks configured, then the active project's and thread's servers, then the rest", () => {
    const projectId = ProjectId.make("project-amine");
    const threadId = ThreadId.make("thread-1");
    const result = mergeServers({
      scanner: [
        scannerServer({ port: 3000 }),
        scannerServer({ port: 24_287, projectId: ProjectId.make("project-other") }),
        scannerServer({ port: 8770, projectId, reason: "systemd" }),
        scannerServer({ port: 5174, terminal: { threadId, terminalId: "default" } }),
        scannerServer({ port: 9000 }),
      ],
      configuredUrls: ["http://localhost:9000"],
      active: { projectId, threadId },
    });
    expect(result.map((server) => server.port)).toEqual([9000, 5174, 8770, 3000]);
  });

  it("shows a project's server only in that project, and project-less servers everywhere", () => {
    const amine = ProjectId.make("project-amine");
    const scanner = [
      scannerServer({ port: 8770, projectId: amine, reason: "systemd" }),
      scannerServer({ port: 3000 }),
    ];
    const ports = (projectId: ProjectId | null) =>
      mergeServers({ scanner, configuredUrls: [], active: { projectId, threadId: null } }).map(
        (server) => server.port,
      );
    expect(ports(amine)).toEqual([8770, 3000]);
    expect(ports(ProjectId.make("project-t3code"))).toEqual([3000]);
    expect(ports(null)).toEqual([3000, 8770]);
  });

  it("keeps the active thread's own terminal server even when attributed to another project", () => {
    const threadId = ThreadId.make("thread-1");
    const result = mergeServers({
      scanner: [
        scannerServer({
          port: 5174,
          projectId: ProjectId.make("project-parent-folder"),
          terminal: { threadId, terminalId: "default" },
        }),
      ],
      configuredUrls: [],
      active: { projectId: ProjectId.make("project-app"), threadId },
    });
    expect(result.map((server) => server.port)).toEqual([5174]);
  });
});
