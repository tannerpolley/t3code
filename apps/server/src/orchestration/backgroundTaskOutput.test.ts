// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, assert, describe, it } from "vite-plus/test";

import {
  backgroundTaskOutputPath,
  initialOutputTailState,
  readOutputTail,
} from "./backgroundTaskOutput.ts";

const notice = (taskId: string, path: string) =>
  `Command running in background with ID: ${taskId}. Output is being written to: ${path}. You will be notified when it completes. To check interim output, use Read on that file path.`;

describe("backgroundTaskOutputPath", () => {
  const path = "/tmp/claude-1000/-home-me-project/3eb6d2ff/tasks/bzdkaire7.output";

  it("returns the file Claude reported for that task", () => {
    assert.equal(backgroundTaskOutputPath(notice("bzdkaire7", path), "bzdkaire7"), path);
    // A foreground command that hit its timeout reports the same path in different words.
    const moved = `Command did not complete within its 120s timeout and was moved to the background (ID: bzdkaire7). Output is being written to: ${path}. You will be notified when it completes.`;
    assert.equal(backgroundTaskOutputPath(moved, "bzdkaire7"), path);
  });

  it("serves nothing but the named task's absolute tasks/<id>.output file", () => {
    assert.isNull(backgroundTaskOutputPath(notice("bzdkaire7", path), "other1"));
    assert.isNull(backgroundTaskOutputPath(notice("x", "/home/me/.ssh/id_rsa"), "x"));
    assert.isNull(backgroundTaskOutputPath(notice("x", "relative/tasks/x.output"), "x"));
    assert.isNull(
      backgroundTaskOutputPath(notice("x", "/tmp/tasks/../../etc/tasks/x.output"), "x"),
    );
    assert.isNull(backgroundTaskOutputPath(notice("../x", "/tmp/tasks/../x.output"), "../x"));
  });
});

describe("readOutputTail", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bg-task-output-"));
  const file = NodePath.join(dir, "task.output");
  afterAll(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

  it("sends the capped tail first, then only what was appended", async () => {
    NodeFS.writeFileSync(file, "0123456789");
    const state = initialOutputTailState();
    assert.deepEqual(await readOutputTail(file, state, 4), { text: "6789", reset: true });
    assert.isNull(await readOutputTail(file, state, 4));
    NodeFS.appendFileSync(file, "ab");
    assert.deepEqual(await readOutputTail(file, state, 4), { text: "ab", reset: false });
    NodeFS.appendFileSync(file, "cdefgh");
    assert.deepEqual(await readOutputTail(file, state, 4), { text: "efgh", reset: true });
    NodeFS.writeFileSync(file, "new");
    assert.deepEqual(await readOutputTail(file, state, 4), { text: "new", reset: true });
  });

  it("keeps a multi-byte character split across reads intact", async () => {
    NodeFS.writeFileSync(file, Buffer.from("é").subarray(0, 1));
    const state = initialOutputTailState();
    assert.deepEqual(await readOutputTail(file, state), { text: "", reset: true });
    NodeFS.appendFileSync(file, Buffer.from("é").subarray(1));
    assert.deepEqual(await readOutputTail(file, state), { text: "é", reset: false });
  });
});
