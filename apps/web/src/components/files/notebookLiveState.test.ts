import { expect, it } from "vite-plus/test";
import type { NotebookEvent, NotebookSnapshot } from "@t3tools/contracts";
import { applyNotebookEvent } from "./notebookLiveState";

function notebookFixture(): NotebookSnapshot {
  return {
    handle: "handle",
    epoch: "epoch",
    sequence: 0,
    revision: 0,
    savedRevision: 0,
    diskHash: "disk",
    idleDeadline: null,
    availability: "available",
    environment: "unverified",
    executions: {},
    generation: 0,
    kernel: "stopped",
    runId: null,
    outcome: "none",
    truncated: false,
    document: {
      nbformat: 4,
      metadata: { language_info: { name: "python" } },
      cells: ["a", "b"].map((id) => ({
        id,
        cell_type: "code",
        source: "print(42)",
        execution_count: null,
        outputs: [],
      })),
    },
  };
}
it("updates only the affected cell, preserves aborted provenance, and rejects stream gaps", () => {
  const initial = notebookFixture();
  const execution = {
    runId: "run",
    generation: 1,
    sourceHash: "source",
    sourceRevision: 0,
    replyStatus: "aborted",
  };
  const { document: _, executions: __, handle: ___, ...meta } = initial;
  const event: NotebookEvent = {
    ...meta,
    type: "changed",
    sequence: 1,
    revision: 1,
    generation: 1,
    runId: "run",
    cellId: "a",
    outcome: "aborted",
    patches: [
      { type: "execution", cellId: "a", count: 3, execution },
      {
        type: "append",
        cellId: "a",
        output: { output_type: "stream", name: "stdout", text: "one" },
      },
      { type: "stream", cellId: "a", text: "two" },
    ],
  };
  const next = applyNotebookEvent(initial, event)!;
  const cells = next.document.cells as Record<string, unknown>[];
  expect(cells[1]).toBe((initial.document.cells as unknown[])[1]);
  expect(cells[0]).toMatchObject({ execution_count: 3, outputs: [{ text: "onetwo" }] });
  expect(next.executions.a).toEqual(execution);
  expect((initial.document.cells as Record<string, unknown>[])[0]!.outputs).toEqual([]);
  expect(applyNotebookEvent(next, event)).toBeNull();
  expect(applyNotebookEvent(next, { ...event, sequence: 3 })).toBeNull();
  expect(applyNotebookEvent(next, { ...event, epoch: "restarted", sequence: 2 })).toBeNull();
  expect(
    applyNotebookEvent(next, { type: "resync-required", epoch: "epoch", sequence: 2 }),
  ).toBeNull();
  expect(applyNotebookEvent(next, { type: "snapshot", snapshot: initial })).toBe(initial);
});
