// @effect-diagnostics nodeBuiltinImport:off
// Node UUIDs identify kernel protocol requests at this adapter boundary.
import * as NodeCrypto from "node:crypto";
import { fetch, WebSocket } from "undici";
import { NOTEBOOK_LIMITS, NotebookError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const Message = Schema.Struct({
  header: Schema.Struct({ msg_type: Schema.String }),
  parent_header: Schema.Struct({ msg_id: Schema.optional(Schema.String) }),
  channel: Schema.String,
  content: Schema.Record(Schema.String, Schema.Unknown),
  buffers: Schema.optional(Schema.Array(Schema.Unknown)),
});
const mimeContent = {
  data: Schema.Record(Schema.String, Schema.Unknown),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
};
const contentValidators: Record<string, (value: unknown) => boolean> = {
  stream: Schema.is(
    Schema.Struct({ name: Schema.Literals(["stdout", "stderr"]), text: Schema.String }),
  ),
  display_data: Schema.is(Schema.Struct(mimeContent)),
  update_display_data: Schema.is(Schema.Struct(mimeContent)),
  execute_result: Schema.is(Schema.Struct({ ...mimeContent, execution_count: Schema.Int })),
  error: Schema.is(
    Schema.Struct({
      ename: Schema.String,
      evalue: Schema.String,
      traceback: Schema.Array(Schema.String),
    }),
  ),
  clear_output: Schema.is(Schema.Struct({ wait: Schema.Boolean })),
};
const decodeMessage = Schema.decodeSync(Schema.fromJsonString(Message));
const decodeKernel = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }));
export type Message = typeof Message.Type;
export type Endpoint = {
  readonly url: string;
  readonly token: string;
  readonly kernelName: string;
};
export type Channels = {
  readonly messages: Stream.Stream<Message, NotebookError>;
  readonly execute: (id: string, code: string) => Effect.Effect<void, NotebookError>;
  readonly close: Effect.Effect<void>;
};
export class JupyterTransport extends Context.Service<
  JupyterTransport,
  {
    readonly create: (endpoint: Endpoint, cwd: string) => Effect.Effect<string, NotebookError>;
    readonly control: (
      endpoint: Endpoint,
      id: string,
      action: "interrupt" | "restart" | "shutdown",
    ) => Effect.Effect<void, NotebookError>;
    readonly connect: (
      endpoint: Endpoint,
      id: string,
    ) => Effect.Effect<Channels, NotebookError, Scope.Scope>;
  }
>()("t3/notebook/JupyterTransport") {}

function endpointUrl(endpoint: Endpoint, suffix: string) {
  const url = new URL(endpoint.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !endpoint.token
  )
    throw new Error();
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/kernels${suffix}`;
  return url;
}
const request = Effect.fn("JupyterTransport.request")(function* (
  endpoint: Endpoint,
  suffix: string,
  method: string,
  body?: unknown,
) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(endpointUrl(endpoint, suffix), {
        method,
        headers: { Authorization: `token ${endpoint.token}`, "Content-Type": "application/json" },
        redirect: "error",
        signal,
        ...(body === undefined ? {} : { body: encodeJson(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      if (response.status === 204) return undefined;
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      let text = "";
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
          if (Buffer.byteLength(text) > NOTEBOOK_LIMITS.frameBytes) throw new Error();
        }
        return decodeJson(text) as unknown;
      } finally {
        await reader.cancel();
      }
    },
    catch: () => new NotebookError({ reason: "kernel-failure" }),
  });
});

export const layer = Layer.sync(JupyterTransport, () => {
  const create = Effect.fn("JupyterTransport.create")(function* (endpoint: Endpoint, cwd: string) {
    const result = yield* request(endpoint, "", "POST", { name: endpoint.kernelName, path: cwd });
    return yield* decodeKernel(result).pipe(
      Effect.map((r) => r.id),
      Effect.mapError(() => new NotebookError({ reason: "kernel-failure" })),
    );
  });
  const control = Effect.fn("JupyterTransport.control")(function* (
    endpoint: Endpoint,
    id: string,
    action: "interrupt" | "restart" | "shutdown",
  ) {
    yield* request(
      endpoint,
      `/${encodeURIComponent(id)}${action === "shutdown" ? "" : `/${action}`}`,
      action === "shutdown" ? "DELETE" : "POST",
    );
  });
  const connect = Effect.fn("JupyterTransport.connect")(function* (endpoint: Endpoint, id: string) {
    const messages = yield* Queue.dropping<Message, NotebookError>(64);
    const socket = yield* Effect.try({
      try: () => {
        const url = endpointUrl(endpoint, `/${encodeURIComponent(id)}/channels`);
        url.protocol = "ws:";
        url.searchParams.set("session_id", NodeCrypto.randomUUID());
        return new WebSocket(url, { headers: { Authorization: `token ${endpoint.token}` } });
      },
      catch: () => new NotebookError({ reason: "unavailable" }),
    });
    const fail = () => {
      Queue.failCauseUnsafe(messages, Cause.fail(new NotebookError({ reason: "disconnected" })));
      socket.close();
    };
    socket.addEventListener("message", (event) => {
      try {
        if (
          typeof event.data !== "string" ||
          Buffer.byteLength(event.data) > NOTEBOOK_LIMITS.frameBytes
        ) {
          fail();
          return;
        }
        const message = decodeMessage(event.data);
        if (
          message.buffers?.length ||
          contentValidators[message.header.msg_type]?.(message.content) === false ||
          !Queue.offerUnsafe(messages, message)
        )
          fail();
      } catch {
        fail();
      }
    });
    socket.addEventListener("close", fail);
    socket.addEventListener("error", fail);
    const close = Effect.sync(() => {
      socket.removeEventListener("close", fail);
      socket.removeEventListener("error", fail);
      socket.close();
      Queue.shutdownUnsafe(messages);
    });
    yield* Effect.addFinalizer(() => close);
    yield* Effect.callback<void, NotebookError>((resume) => {
      const opened = () => resume(Effect.void);
      const failed = () => resume(Effect.fail(new NotebookError({ reason: "disconnected" })));
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
      return Effect.sync(() => {
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
      });
    });
    const execute = Effect.fn("JupyterTransport.execute")(function* (id: string, code: string) {
      yield* Effect.try({
        try: () =>
          socket.send(
            encodeJson({
              header: {
                msg_id: id,
                msg_type: "execute_request",
                username: "t3",
                session: "t3",
                version: "5.3",
              },
              parent_header: {},
              metadata: {},
              channel: "shell",
              content: {
                code,
                silent: false,
                store_history: true,
                user_expressions: {},
                allow_stdin: false,
                stop_on_error: true,
              },
            }),
          ),
        catch: () => new NotebookError({ reason: "disconnected" }),
      });
    });
    return { messages: Stream.fromQueue(messages), execute, close };
  });
  return JupyterTransport.of({ create, control, connect });
});
