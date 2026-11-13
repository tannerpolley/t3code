import { assert, describe, it } from "@effect/vitest";

import * as StallAttribution from "./StallAttribution.ts";

const s = (seconds: number) => BigInt(seconds * 1e9);

describe("StallAttribution", () => {
  it("names spans that lasted through the stall, innermost first", () => {
    const nowNs = s(10_000);
    const suspects = StallAttribution.stallSuspects(
      [
        { name: "ws.rpc.orchestration.subscribeThread", startNs: s(6_000) },
        { name: "ProjectionMaintenance.pruneEventStore", startNs: s(7_000) },
        { name: "ProjectionMaintenance.purgeDeletedThread", startNs: s(9_200), endNs: s(9_990) },
        // Too short to have lasted through the stall.
        { name: "ws.rpc.server.getThreadProcesses", startNs: s(9_985), endNs: s(9_990) },
        // Long, but it ended before the window the stall fell in.
        { name: "ProviderSession.start", startNs: s(1_000), endNs: s(9_000) },
      ],
      { stallMs: 778_000, windowMs: 808_000, nowNs },
    );
    assert.deepStrictEqual(suspects, [
      "ProjectionMaintenance.purgeDeletedThread 790.0 s",
      "ProjectionMaintenance.pruneEventStore 3000.0 s (open)",
      "ws.rpc.orchestration.subscribeThread 4000.0 s (open)",
    ]);
  });
});
