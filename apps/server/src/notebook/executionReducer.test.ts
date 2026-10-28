import { expect, it } from "@effect/vitest";
import { NOTEBOOK_LIMITS } from "@t3tools/contracts";
import { ExecutionReducer } from "./executionReducer.ts";
import { parseNotebook, byteLength } from "./notebookDocument.ts";

it.each([true, false])("requires both reply and idle, reply first: %s", (replyFirst) => {
  const document = parseNotebook(
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          id: "a",
          cell_type: "code",
          source: "1",
          metadata: {},
          execution_count: null,
          outputs: [],
        },
      ],
    }),
  ).document;
  const reducer = new ExecutionReducer(document);
  reducer.begin("request", document.cells[0]!);
  const reply = {
    header: { msg_type: "execute_reply" },
    parent_header: { msg_id: "request" },
    channel: "shell",
    content: { status: "error" },
  };
  const idle = {
    header: { msg_type: "status" },
    parent_header: { msg_id: "request" },
    channel: "iopub",
    content: { execution_state: "idle" },
  };
  expect(reducer.reduce({ ...idle, parent_header: { msg_id: "other" } })).toBeUndefined();
  expect(reducer.reduce(replyFirst ? reply : idle)?.complete).toBe(false);
  expect(reducer.reduce(replyFirst ? idle : reply)).toMatchObject({ complete: true, failed: true });
});

it("updates displays across cells, defers clear, strips transient IDs, and bounds floods", () => {
  const document = parseNotebook(
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: ["a", "b"].map((id) => ({
        id,
        cell_type: "code",
        source: "",
        metadata: {},
        execution_count: null,
        outputs: [],
      })),
    }),
  ).document;
  const reducer = new ExecutionReducer(document);
  const send = (id: string, type: string, content: Record<string, unknown>) =>
    reducer.reduce({
      header: { msg_type: type },
      parent_header: { msg_id: id },
      channel: "iopub",
      content,
    });
  reducer.begin("one", document.cells[0]!);
  reducer.begin("two", document.cells[1]!);
  for (const id of ["one", "two"])
    send(id, "display_data", {
      data: { "text/plain": "old" },
      metadata: { keep: true },
      transient: { display_id: "display" },
    });
  send("two", "update_display_data", {
    data: { "text/plain": "new" },
    metadata: {},
    transient: { display_id: "display" },
  });
  for (const cell of document.cells)
    expect(cell.outputs).toEqual([
      { output_type: "display_data", data: { "text/plain": "new" }, metadata: {} },
    ]);
  send("one", "execute_input", { execution_count: 9 });
  send("one", "clear_output", { wait: true });
  expect(document.cells[0]?.outputs).toHaveLength(1);
  send("one", "stream", { name: "stdout", text: "next" });
  expect(document.cells[0]?.outputs).toEqual([
    { output_type: "stream", name: "stdout", text: "next" },
  ]);
  expect(document.cells[0]?.execution_count).toBe(9);
  for (let i = 0; i < 12; i++)
    send("one", "stream", { name: "stdout", text: "x".repeat(NOTEBOOK_LIMITS.frameBytes) });
  expect(byteLength(document)).toBeLessThanOrEqual(NOTEBOOK_LIMITS.bytes);
  expect(reducer.truncated).toBe(true);
  expect(document.cells[0]?.outputs?.at(-1)).toMatchObject({ t3_truncated: true });
  reducer.begin("replacement", document.cells[0]!);
  expect(send("one", "stream", { name: "stdout", text: "obsolete" })).toBeUndefined();
});

it("never exceeds the exact document bound while resetting or updating counts", () => {
  const value = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { padding: "" },
    cells: [
      { id: "a", cell_type: "code", source: "", metadata: {}, execution_count: 0, outputs: [] },
    ],
  };
  value.metadata.padding = "x".repeat(NOTEBOOK_LIMITS.bytes - byteLength(value));
  const document = parseNotebook(JSON.stringify(value)).document;
  const reducer = new ExecutionReducer(document);
  try {
    reducer.begin("one", document.cells[0]!);
  } catch {
    /* An explicit limit rejection preserves the document. */
  }
  expect(byteLength(document)).toBeLessThanOrEqual(NOTEBOOK_LIMITS.bytes);
  reducer.reduce({
    header: { msg_type: "execute_input" },
    parent_header: { msg_id: "one" },
    channel: "iopub",
    content: { execution_count: 123456789 },
  });
  expect(byteLength(document)).toBeLessThanOrEqual(NOTEBOOK_LIMITS.bytes);
  value.metadata.padding = value.metadata.padding.slice(0, -4);
  const nearLimit = parseNotebook(JSON.stringify(value)).document;
  const countReducer = new ExecutionReducer(nearLimit);
  countReducer.begin("two", nearLimit.cells[0]!);
  countReducer.reduce({
    header: { msg_type: "execute_input" },
    parent_header: { msg_id: "two" },
    channel: "iopub",
    content: { execution_count: 123456789 },
  });
  expect(byteLength(nearLimit)).toBeLessThanOrEqual(NOTEBOOK_LIMITS.bytes);
  expect(countReducer.truncated).toBe(true);
});
