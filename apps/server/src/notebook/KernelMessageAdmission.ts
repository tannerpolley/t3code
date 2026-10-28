import { NOTEBOOK_LIMITS, NotebookError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { none, type Many } from "stream-chain/defs.js";
import * as StreamJson from "stream-json/core/parser.js";
import type { ParserOptions, Token } from "stream-json/core/parser.js";

const Message = Schema.Struct({
  header: Schema.Struct({ msg_type: Schema.String }),
  parent_header: Schema.Struct({ msg_id: Schema.optional(Schema.String) }),
  channel: Schema.String,
  content: Schema.Record(Schema.String, Schema.Unknown),
  buffers: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type Message = typeof Message.Type;
const decodeMessage = Schema.decodeSync(Schema.fromJsonString(Message));
const mime = {
  data: Schema.Record(Schema.String, Schema.Unknown),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
};
const validators: Record<string, (value: unknown) => boolean> = {
  stream: Schema.is(
    Schema.Struct({ name: Schema.Literals(["stdout", "stderr"]), text: Schema.String }),
  ),
  display_data: Schema.is(Schema.Struct(mime)),
  update_display_data: Schema.is(Schema.Struct(mime)),
  execute_result: Schema.is(Schema.Struct({ ...mime, execution_count: Schema.Int })),
  error: Schema.is(
    Schema.Struct({
      ename: Schema.String,
      evalue: Schema.String,
      traceback: Schema.Array(Schema.String),
    }),
  ),
  clear_output: Schema.is(Schema.Struct({ wait: Schema.Boolean })),
};
const normalized = Schema.Struct({
  type: Schema.String,
  channel: Schema.String,
  parent: Schema.optional(Schema.String),
  count: Schema.optional(Schema.Unknown),
  status: Schema.optional(Schema.Unknown),
  state: Schema.optional(Schema.Unknown),
});
const decodeEnvelope = Schema.decodeUnknownSync(normalized);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// The synchronous tokenizer is used elsewhere in this server; 3.6.0 omits its type declaration.
const { jsonParser } = StreamJson as typeof StreamJson & {
  jsonParser: (
    options: ParserOptions,
  ) => (input: string | typeof none) => Many<Token> | typeof none;
};

function messageReader(raw: Buffer) {
  const tokenize = jsonParser({ packValues: false });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let rawSize = 0,
    oversized = false,
    key = "",
    scalar = "",
    readingKey = false;
  let field: string | undefined;
  let scalarOverflow = false;
  const envelope: Record<string, unknown> = {};
  const stack: Array<{ container: string | undefined; key: string; array: boolean }> = [];
  let rootComplete = false;
  let buffers = false;
  const selected = () => {
    const parent = stack.at(-1);
    if (stack.length === 1 && parent?.key === "channel") return "channel";
    if (stack.length !== 2) return undefined;
    if (parent?.container === "header" && parent.key === "msg_type") return "type";
    if (parent?.container === "parent_header" && parent.key === "msg_id") return "parent";
    if (parent?.container !== "content") return undefined;
    return (
      { execution_count: "count", status: "status", execution_state: "state" } as Record<
        string,
        string
      >
    )[parent.key];
  };
  const tokens = (input: string | typeof none) => {
    const batch = tokenize(input);
    if (batch === none) return;
    for (const token of batch.values) {
      const parent = stack.at(-1);
      if (parent?.container === "buffers" && token.name !== "endArray") buffers = true;
      switch (token.name) {
        case "startObject":
        case "startArray": {
          if (rootComplete || stack.length >= 128) throw new Error();
          const container = stack.length === 1 ? parent?.key : undefined;
          if (container === "header") delete envelope.type;
          if (container === "parent_header") delete envelope.parent;
          if (container === "content") {
            delete envelope.count;
            delete envelope.status;
            delete envelope.state;
          }
          stack.push({ container, key: "", array: token.name === "startArray" });
          break;
        }
        case "endObject":
        case "endArray":
          stack.pop();
          if (!stack.length) rootComplete = true;
          break;
        case "startKey":
          key = "";
          readingKey = true;
          break;
        case "endKey":
          if (parent) parent.key = key;
          readingKey = false;
          break;
        case "startString":
        case "startNumber":
          field = selected();
          scalar = "";
          scalarOverflow = false;
          break;
        case "stringChunk":
        case "numberChunk":
          if (readingKey) {
            if (key.length <= 64) key = (key + token.value).slice(0, 65);
          } else if (field && !scalarOverflow) {
            scalar += token.value;
            if (scalar.length > 128) {
              scalar = "";
              scalarOverflow = true;
            }
          }
          break;
        case "endString":
        case "endNumber":
          if (field) {
            if (scalarOverflow) delete envelope[field];
            else envelope[field] = token.name === "endNumber" ? Number(scalar) : scalar;
          }
          field = undefined;
          break;
        case "nullValue":
        case "trueValue":
        case "falseValue": {
          const target = selected();
          if (target) envelope[target] = token.value;
          break;
        }
      }
    }
  };
  return {
    write(chunk: Uint8Array) {
      if (rawSize + chunk.length > raw.length) oversized = true;
      if (!oversized) {
        raw.set(chunk, rawSize);
        rawSize += chunk.length;
      }
      tokens(decoder.decode(chunk, { stream: true }));
    },
    finish() {
      tokens(decoder.decode());
      tokens(none);
      if (!rootComplete || stack.length || buffers) throw new Error();
      const e = decodeEnvelope(envelope);
      const base = {
        header: { msg_type: e.type },
        parent_header: e.parent === undefined ? {} : { msg_id: e.parent },
        channel: e.channel,
      };
      if (e.type === "execute_input") {
        if (typeof e.count !== "number" || !Number.isInteger(e.count)) throw new Error();
        return {
          message: { ...base, content: { execution_count: e.count } } as Message,
          lost: false,
        };
      }
      if (e.type === "execute_reply") {
        if (typeof e.status !== "string" || !["ok", "error", "abort"].includes(e.status))
          throw new Error();
        return { message: { ...base, content: { status: e.status } } as Message, lost: false };
      }
      if (e.type === "status") {
        if (typeof e.state !== "string" || !["busy", "idle", "starting"].includes(e.state))
          throw new Error();
        return {
          message: { ...base, content: { execution_state: e.state } } as Message,
          lost: false,
        };
      }
      if (oversized) return { message: { ...base, content: {} } as Message, lost: true };
      const message = decodeMessage(
        new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, rawSize)),
      );
      if (message.buffers?.length || validators[e.type]?.(message.content) === false)
        throw new Error();
      return { message, lost: false };
    },
  };
}

export const make = Effect.gen(function* () {
  const wake = yield* Queue.sliding<void, NotebookError>(1);
  const output: Message[] = [];
  const controls = new Map<string, Message>();
  const losses = new Set<string>();
  let unattributed = false,
    retained = 0;
  let active: string | undefined;
  const raw = Buffer.allocUnsafe(NOTEBOOK_LIMITS.frameBytes);
  let reader = messageReader(raw);
  const loss = (parent: string | undefined) => {
    if (parent === undefined || (!losses.has(parent) && losses.size === 64)) unattributed = true;
    else losses.add(parent);
  };
  const end = () => {
    const { message, lost } = reader.finish();
    reader = messageReader(raw);
    const parent = message.parent_header.msg_id;
    const type = message.header.msg_type;
    if (lost) loss(parent);
    else if (
      parent === active &&
      active &&
      (type === "execute_input" ||
        type === "execute_reply" ||
        (type === "status" && message.content.execution_state === "idle"))
    )
      controls.set(type, message);
    else {
      const size = Buffer.byteLength(encodeJson(message));
      if (output.length === 64 || retained + size > NOTEBOOK_LIMITS.frameBytes) loss(parent);
      else {
        output.push(message);
        retained += size;
      }
    }
    Queue.offerUnsafe(wake, undefined);
  };
  const messages = Stream.fromQueue(wake).pipe(
    Stream.flatMap(() => {
      const batch = output.splice(0);
      retained = 0;
      const input = controls.get("execute_input");
      if (input) batch.unshift(input);
      for (const parent of losses)
        batch.push({
          header: { msg_type: "t3_output_lost" },
          parent_header: { msg_id: parent },
          channel: "iopub",
          content: {},
        });
      if (unattributed)
        batch.push({
          header: { msg_type: "t3_output_lost" },
          parent_header: {},
          channel: "iopub",
          content: {},
        });
      for (const type of ["execute_reply", "status"]) {
        const message = controls.get(type);
        if (message) batch.push(message);
      }
      controls.clear();
      losses.clear();
      unattributed = false;
      return Stream.fromIterable(batch);
    }),
  );
  return {
    write: (bytes: Uint8Array) => {
      for (let offset = 0; offset < bytes.length; offset += 8192)
        reader.write(bytes.subarray(offset, offset + 8192));
    },
    end,
    execute: (id: string) => {
      active = id;
    },
    messages,
    fail: () =>
      Queue.failCauseUnsafe(wake, Cause.fail(new NotebookError({ reason: "disconnected" }))),
    close: Effect.sync(() => {
      Queue.shutdownUnsafe(wake);
    }),
  };
});
