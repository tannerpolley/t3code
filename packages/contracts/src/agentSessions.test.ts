import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AgentSessionScanResult } from "./agentSessions.ts";

const decodeScanResult = Schema.decodeUnknownSync(AgentSessionScanResult);

const candidate = {
  path: "/projects/repo",
  title: "repo",
  sources: ["codex"],
  threadCount: 3,
  lastActiveAt: "2026-08-20T12:00:00.000Z",
  alreadyImported: false,
} as const;

describe("AgentSessionScanResult", () => {
  it("decodes the Codex project settings preview", () => {
    const result = decodeScanResult({
      candidates: [
        {
          path: "/repo",
          title: "repo",
          sources: ["codex"],
          threadCount: 1,
          lastActiveAt: null,
          alreadyImported: false,
          codexSettings: {
            trustLevel: "trusted",
            defaultRuntimeMode: "auto-accept-edits",
            unsupportedKeys: ["custom_setting"],
          },
        },
      ],
      scannedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(result.candidates[0]?.codexSettings).toEqual({
      trustLevel: "trusted",
      defaultRuntimeMode: "auto-accept-edits",
      unsupportedKeys: ["custom_setting"],
    });
  });

  it("decodes candidates from servers that predate the git scan", () => {
    const result = decodeScanResult({
      candidates: [candidate],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toBeUndefined();
  });

  it("preserves reported git identity", () => {
    const git = { remoteKey: "github.com/pingdotgg/t3code", repository: "pingdotgg/t3code" };
    const result = decodeScanResult({
      candidates: [{ ...candidate, git }],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toEqual(git);
  });
});
