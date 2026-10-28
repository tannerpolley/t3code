import { NOTEBOOK_LIMITS, NotebookError, type NotebookOutputPatch } from "@t3tools/contracts";
import type { Message } from "./JupyterTransport.ts";
import { byteLength, type Document, type NotebookCell } from "./notebookDocument.ts";

type Owner = {
  cell: NotebookCell;
  reply: boolean;
  idle: boolean;
  failed: boolean;
  clear: boolean;
  replyStatus?: string;
};
export class ExecutionReducer {
  readonly owners = new Map<string, Owner>();
  displays = new WeakMap<object, string>();
  truncated = false;
  readonly document: Document;
  constructor(document: Document) {
    this.document = document;
  }
  resetGeneration() {
    this.owners.clear();
    this.displays = new WeakMap();
  }
  begin(id: string, cell: NotebookCell) {
    const previous = { outputs: cell.outputs, count: cell.execution_count };
    cell.outputs = [];
    cell.execution_count = null;
    if (byteLength(this.document) > NOTEBOOK_LIMITS.bytes) {
      if (previous.outputs === undefined) delete cell.outputs;
      else cell.outputs = previous.outputs;
      if (previous.count === undefined) delete cell.execution_count;
      else cell.execution_count = previous.count;
      throw new NotebookError({ reason: "output-limit" });
    }
    for (const [key, owner] of this.owners) if (owner.cell === cell) this.owners.delete(key);
    this.owners.set(id, { cell, reply: false, idle: false, failed: false, clear: false });
  }
  reduce(message: Message) {
    if (
      message.header.msg_type === "t3_output_lost" &&
      message.parent_header.msg_id === undefined
    ) {
      this.truncated = true;
      return { patches: [], cellId: null, complete: false, failed: false, replyStatus: undefined };
    }
    const owner = this.owners.get(message.parent_header.msg_id ?? "");
    if (!owner) return undefined;
    const { cell } = owner;
    const patches: NotebookOutputPatch[] = [];
    const content = message.content;
    const type = message.header.msg_type;
    if (type === "t3_output_lost" || content.t3_truncated === true) this.truncated = true;
    if (type === "execute_reply" && message.channel === "shell") {
      owner.reply = true;
      owner.failed = content.status !== "ok";
      if (typeof content.status === "string") owner.replyStatus = content.status;
    }
    if (type === "status" && message.channel === "iopub" && content.execution_state === "idle")
      owner.idle = true;
    if (message.channel === "iopub") {
      if (type === "execute_input" && typeof content.execution_count === "number") {
        const previous = cell.execution_count;
        cell.execution_count = content.execution_count;
        if (byteLength(this.document) > NOTEBOOK_LIMITS.bytes) {
          if (previous === undefined) delete cell.execution_count;
          else cell.execution_count = previous;
          this.truncated = true;
        } else patches.push({ type: "count", cellId: cell.id, count: content.execution_count });
      }
      if (type === "clear_output") {
        if (content.wait === true) owner.clear = true;
        else {
          cell.outputs = [];
          patches.push({ type: "clear", cellId: cell.id });
          owner.clear = false;
        }
      }
      if (
        [
          "stream",
          "display_data",
          "execute_result",
          "error",
          "update_display_data",
          "t3_output_lost",
        ].includes(type)
      ) {
        if (owner.clear) {
          cell.outputs = [];
          patches.push({ type: "clear", cellId: cell.id });
          owner.clear = false;
        }
        const transient = content.transient as { display_id?: unknown } | undefined;
        const displayId =
          typeof transient?.display_id === "string" ? transient.display_id : undefined;
        const { transient: _transient, t3_truncated: _truncated, ...saved } = content;
        if (type === "update_display_data") {
          if (displayId)
            for (const other of this.document.cells)
              for (const output of other.outputs ?? []) {
                if (this.displays.get(output) !== displayId) continue;
                const prior = { ...output };
                Object.assign(output, { data: saved.data, metadata: saved.metadata });
                if (byteLength(this.document) > NOTEBOOK_LIMITS.bytes - 256) {
                  Object.assign(output, prior);
                  this.truncated = true;
                } else
                  patches.push({
                    type: "replace",
                    cellId: other.id,
                    index: other.outputs!.indexOf(output),
                    output: structuredClone(output),
                  });
              }
        } else {
          const outputs = (cell.outputs ??= []);
          const previous = outputs.at(-1);
          if (
            type === "stream" &&
            typeof saved.text === "string" &&
            previous?.output_type === "stream" &&
            previous.name === saved.name
          ) {
            const text = previous.text;
            previous.text = String(text) + saved.text;
            if (byteLength(this.document) > NOTEBOOK_LIMITS.bytes - 256) {
              previous.text = text;
              this.truncated = true;
            } else patches.push({ type: "stream", cellId: cell.id, text: saved.text });
          } else if (type !== "t3_output_lost") {
            const output = { ...saved, output_type: type };
            outputs.push(output);
            if (
              outputs.length > NOTEBOOK_LIMITS.outputs - 1 ||
              byteLength(this.document) > NOTEBOOK_LIMITS.bytes - 256
            ) {
              outputs.pop();
              this.truncated = true;
            } else {
              patches.push({ type: "append", cellId: cell.id, output: structuredClone(output) });
              if (displayId) this.displays.set(output, displayId);
            }
          }
          if (this.truncated && !outputs.some((o) => o.t3_truncated === true)) {
            const marker = {
              output_type: "stream",
              name: "stderr",
              text: "[T3 output truncated]\n",
              t3_truncated: true,
            };
            outputs.push(marker);
            if (byteLength(this.document) > NOTEBOOK_LIMITS.bytes) outputs.pop();
            else patches.push({ type: "append", cellId: cell.id, output: marker });
          }
        }
      }
    }
    return {
      patches,
      cellId: cell.id,
      complete: owner.reply && owner.idle,
      failed: owner.failed,
      replyStatus: owner.replyStatus,
    };
  }
}
