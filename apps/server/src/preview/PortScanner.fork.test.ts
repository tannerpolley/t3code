import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { ProjectId, ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import {
  LSOF_TEST_PORT,
  makeLsofScannerLayer,
  makeLsofScannerWithoutSettings,
} from "./PortScanner.testHarness.ts";
import * as PortScanner from "./PortScanner.ts";

for (const platform of ["linux", "darwin", "win32"] as const) {
  const unrelatedListener = { pid: 9876, port: 57_343 };
  const childListener = { pid: 1234, port: LSOF_TEST_PORT };
  const parents = () =>
    new Map([
      [unrelatedListener.pid, 1],
      [childListener.pid, 1233],
      [1233, process.pid],
      [process.pid, 1],
    ]);

  for (const scenario of [
    "unrelated",
    "descendant",
    "common dev port",
    "configured URL",
  ] as const) {
    effectIt.effect(`${platform}: probes only eligible listeners (${scenario})`, () => {
      const requests: string[] = [];
      const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
        requests.push(String(input));
        return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
      }) as typeof globalThis.fetch;
      const configuredUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
      const listeners = [
        unrelatedListener,
        ...(scenario === "descendant"
          ? [childListener, { pid: process.pid, port: 43_124 }]
          : scenario === "common dev port"
            ? [{ pid: unrelatedListener.pid, port: 3000 }]
            : scenario === "configured URL"
              ? [{ pid: unrelatedListener.pid, port: LSOF_TEST_PORT }]
              : []),
      ];
      const layer = makeLsofScannerLayer({
        pid: () => childListener.pid,
        fetch: fetchFn,
        platform,
        listeners,
        parents,
      });

      return Effect.gen(function* () {
        const scanner = yield* PortScanner.PortDiscovery;
        const servers = yield* scanner.scan(scenario === "configured URL" ? [configuredUrl] : []);
        const expectedUrls =
          scenario === "descendant"
            ? [`http://localhost:${LSOF_TEST_PORT}/`, "http://localhost:43124/"]
            : scenario === "common dev port"
              ? ["http://localhost:3000/"]
              : scenario === "configured URL"
                ? [configuredUrl]
                : [];
        expect(requests.toSorted()).toEqual(expectedUrls.toSorted());
        expect(servers.map((server) => server.port)).toEqual(
          expectedUrls.map((url) => Number(new URL(url).port)).toSorted((a, b) => a - b),
        );
      }).pipe(Effect.provide(layer));
    });
  }

  effectIt.effect(
    `${platform}: probes terminal listeners, dev ports and configured URLs if ancestry fails`,
    () => {
      const requests: string[] = [];
      const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
        requests.push(String(input));
        return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
      }) as typeof globalThis.fetch;
      const configuredUrl = "http://localhost:43125/docs";
      const layer = makeLsofScannerLayer({
        pid: () => childListener.pid,
        fetch: fetchFn,
        platform,
        listeners: [unrelatedListener, childListener, { pid: unrelatedListener.pid, port: 3000 }],
        parents,
        parentFailure: true,
      });

      return Effect.gen(function* () {
        const scanner = yield* PortScanner.PortDiscovery;
        yield* scanner.registerTerminalProcesses({
          threadId: "thread-1",
          terminalId: "terminal-1",
          processIds: [childListener.pid],
        });
        const servers = yield* scanner.scan([configuredUrl]);
        expect(servers.map((server) => server.port)).toEqual([3000, LSOF_TEST_PORT, 43125]);
        expect(requests.toSorted()).toEqual(
          [
            "http://localhost:3000/",
            `http://localhost:${LSOF_TEST_PORT}/`,
            configuredUrl,
          ].toSorted(),
        );
      }).pipe(Effect.provide(layer));
    },
  );
}

describe("listener attribution", () => {
  const amine = ProjectId.make("project-amine");
  const engineering = ProjectId.make("project-engineering");
  const cse = ProjectId.make("project-cse");
  const projects = [
    { id: engineering, workspaceRoot: "/home/u/Engineering/" },
    { id: amine, workspaceRoot: "/home/u/Engineering/Amine" },
    { id: cse, workspaceRoot: "/home/u/plugins/cse" },
  ];

  it("reads the user systemd service from a cgroup", () => {
    expect(
      PortScanner.systemdUnitFromCgroup(
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/cse-preview-Amine-daf39727.service\n",
      ),
    ).toBe("cse-preview-Amine-daf39727.service");
    expect(
      PortScanner.systemdUnitFromCgroup(
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-steam-229798.scope",
      ),
    ).toBeNull();
    expect(PortScanner.systemdUnitFromCgroup("0::/system.slice/cups.service")).toBeNull();
  });

  it("attributes a working directory to the deepest containing project root", () => {
    expect(PortScanner.projectIdForCwd("/home/u/Engineering/Amine/analyses", projects)).toBe(amine);
    expect(PortScanner.projectIdForCwd("/home/u/Engineering/Amine", projects)).toBe(amine);
    expect(PortScanner.projectIdForCwd("/home/u/Engineering/Amine-Old", projects)).toBe(
      engineering,
    );
    expect(PortScanner.projectIdForCwd("/home/u/Engineering", projects)).toBe(engineering);
    expect(PortScanner.projectIdForCwd("/home/u/.steam", projects)).toBeNull();
    expect(
      PortScanner.projectIdForCwd("/home/u/plugins/cse/.worktrees/gone (deleted)", projects),
    ).toBeNull();
  });

  effectIt.effect("probes and labels systemd and project listeners, not other programs", () => {
    const requests: string[] = [];
    const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      requests.push(String(input));
      return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
    }) as typeof globalThis.fetch;
    const userSlice = "0::/user.slice/user-1000.slice/user@1000.service";
    const layer = makeLsofScannerLayer({
      pid: () => 501,
      fetch: fetchFn,
      listeners: [
        { pid: 501, port: 8770 },
        { pid: 502, port: 24_282 },
        { pid: 503, port: 23_119 },
        { pid: 504, port: 57_343 },
      ],
      parents: () => new Map([501, 502, 503, 504].map((pid) => [pid, 1] as const)),
      cgroups: new Map([
        [501, `${userSlice}/app.slice/cse-preview-Amine-daf39727.service`],
        [502, `${userSlice}/agents.slice/serena-502.scope`],
        [504, `${userSlice}/app.slice/app-gnome-steam-504.scope`],
      ]),
      cwds: new Map([
        [501, "/home/u/Engineering/Amine/analyses"],
        [502, "/home/u/Engineering/Amine"],
        [503, "/home/u/plugins/cse/.worktrees/gone (deleted)"],
        [504, "/home/u/.steam"],
      ]),
      projects,
    });

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      const servers = yield* scanner.scan();
      expect(requests.toSorted()).toEqual(["http://localhost:24282/", "http://localhost:8770/"]);
      expect(
        servers.map(({ port, reason, systemdUnit, projectId }) => ({
          port,
          reason,
          systemdUnit,
          projectId,
        })),
      ).toEqual([
        {
          port: 8770,
          reason: "systemd",
          systemdUnit: "cse-preview-Amine-daf39727.service",
          projectId: amine,
        },
        { port: 24_282, reason: "project", systemdUnit: undefined, projectId: amine },
      ]);
    }).pipe(Effect.provide(layer));
  });

  effectIt.effect(
    "matches symlinked project roots by their target, first registration first",
    () => {
      const linked = ProjectId.make("project-linked");
      const layer = makeLsofScannerLayer({
        pid: () => 501,
        fetch: (() =>
          Promise.resolve(
            new Response("app", { headers: { "content-type": "text/html" } }),
          )) as typeof globalThis.fetch,
        listeners: [{ pid: 501, port: 8770 }],
        parents: () => new Map([[501, 1]]),
        cwds: new Map([[501, "/home/u/Engineering/Amine/analyses"]]),
        projects: [
          { id: linked, workspaceRoot: "/home/u/links/amine" },
          { id: amine, workspaceRoot: "/home/u/Engineering/Amine" },
        ],
        realPaths: new Map([["/home/u/links/amine", "/home/u/Engineering/Amine"]]),
      });

      return Effect.gen(function* () {
        const scanner = yield* PortScanner.PortDiscovery;
        const servers = yield* scanner.scan();
        expect(servers.map(({ port, projectId }) => ({ port, projectId }))).toEqual([
          { port: 8770, projectId: linked },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  effectIt.effect(
    "attributes a linked worktree to its main checkout's project, not a registered parent folder",
    () => {
      const home = ProjectId.make("project-home");
      const app = ProjectId.make("project-app");
      const layer = makeLsofScannerLayer({
        pid: () => 501,
        fetch: (() =>
          Promise.resolve(
            new Response("app", { headers: { "content-type": "text/html" } }),
          )) as typeof globalThis.fetch,
        listeners: [{ pid: 501, port: 5173 }],
        parents: () => new Map([[501, 1]]),
        cwds: new Map([[501, "/home/u/.t3/worktrees/app/feature/apps/web"]]),
        projects: [
          { id: home, workspaceRoot: "/home/u" },
          { id: app, workspaceRoot: "/home/u/Code/app/apps/web" },
        ],
        gitFiles: new Map([
          [
            "/home/u/.t3/worktrees/app/feature/.git",
            "gitdir: /home/u/Code/app/.git/worktrees/feature\n",
          ],
        ]),
      });

      return Effect.gen(function* () {
        const scanner = yield* PortScanner.PortDiscovery;
        const servers = yield* scanner.scan();
        expect(servers.map(({ port, projectId }) => ({ port, projectId }))).toEqual([
          { port: 5173, projectId: app },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it("hides one port, a process family, or a port range", () => {
    const serena = { port: 24_290, processName: "serena" };
    const preview = { port: 8770, processName: "deno" };
    const onePort = [{ kind: "ports", from: 8770, to: 8770 }] as const;
    expect(PortScanner.isLocalServerHidden(preview, onePort)).toBe(true);
    expect(PortScanner.isLocalServerHidden({ ...preview, port: 8771 }, onePort)).toBe(false);
    const family = [{ kind: "process", processName: "Serena" }] as const;
    expect(PortScanner.isLocalServerHidden(serena, family)).toBe(true);
    expect(PortScanner.isLocalServerHidden(preview, family)).toBe(false);
    expect(PortScanner.isLocalServerHidden({ port: 3000, processName: null }, family)).toBe(false);
    const range = [{ kind: "ports", from: 24_282, to: 24_304 }] as const;
    expect(PortScanner.isLocalServerHidden({ ...serena, port: 24_282 }, range)).toBe(true);
    expect(PortScanner.isLocalServerHidden({ ...serena, port: 24_304 }, range)).toBe(true);
    expect(PortScanner.isLocalServerHidden({ ...serena, port: 24_305 }, range)).toBe(false);
  });

  effectIt.effect("a saved hide rule keeps listeners unprobed across rescans until removed", () => {
    const requests: string[] = [];
    const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      requests.push(String(input));
      return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
    }) as typeof globalThis.fetch;
    const layer = makeLsofScannerWithoutSettings({
      pid: () => 501,
      fetch: fetchFn,
      listeners: [
        { pid: 501, port: 8770, name: "deno" },
        { pid: 502, port: 24_282, name: "serena" },
        { pid: 503, port: 24_283, name: "serena" },
      ],
      parents: () => new Map([501, 502, 503].map((pid) => [pid, 1] as const)),
      cgroups: new Map([[501, "0::/user.slice/app.slice/cse-preview-Amine-daf39727.service"]]),
      cwds: new Map([
        [502, "/home/u/Engineering/Amine"],
        [503, "/home/u/Engineering/Amine"],
      ]),
      projects,
    }).pipe(
      Layer.provideMerge(
        ServerSettingsModule.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
          Layer.provideMerge(
            Layer.fresh(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3code-port-scanner-test-" }),
            ),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const visiblePorts = scanner.scan().pipe(Effect.map((servers) => servers.map((s) => s.port)));
      const serenaRule = { kind: "process", processName: "serena" } as const;

      yield* settings.updateSettings({ localServerHideRules: [serenaRule] });
      const saved = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) => fileSystem.readFileString(settingsPath)),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings))),
        Effect.provide(NodeServices.layer),
      );
      expect(saved.localServerHideRules).toEqual([serenaRule]);
      expect(yield* visiblePorts).toEqual([8770]);
      expect(yield* visiblePorts).toEqual([8770]);
      expect(requests.filter((url) => !url.includes(":8770"))).toEqual([]);

      yield* settings.updateSettings({ localServerHideRules: [] });
      expect(yield* visiblePorts).toEqual([8770, 24_282, 24_283]);
    }).pipe(Effect.provide(layer));
  });
});
