// @effect-diagnostics nodeBuiltinImport:off
// Node UUIDs identify kernel protocol requests at this adapter boundary.
import * as NodeCrypto from "node:crypto";
import { fetch } from "undici";
import { NOTEBOOK_LIMITS, NotebookError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { connectKernelSocket } from "./kernelSocket.ts";
import * as KernelMessageAdmission from "./KernelMessageAdmission.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSpecs = Schema.decodeUnknownEffect(
  Schema.Struct({ kernelspecs: Schema.Record(Schema.String, Schema.Unknown) }),
);
const decodeKernel = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }));
export type { Message } from "./KernelMessageAdmission.ts";
export type Endpoint = {
  readonly url: string;
  readonly token: string;
  readonly kernelName: string;
  readonly interpreter?: string;
  readonly imports?: readonly string[];
};
export type Channels = {
  readonly messages: Stream.Stream<KernelMessageAdmission.Message, NotebookError>;
  readonly execute: (id: string, code: string) => Effect.Effect<void, NotebookError>;
  readonly close: Effect.Effect<void>;
};
export class JupyterTransport extends Context.Service<
  JupyterTransport,
  {
    readonly probe: (endpoint: Endpoint) => Effect.Effect<void, NotebookError>;
    readonly verify: (
      endpoint: Endpoint,
      id: string,
      cwd: string,
    ) => Effect.Effect<void, NotebookError>;
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

export function endpointUrl(endpoint: Endpoint, suffix: string) {
  const url = new URL(endpoint.url);
  if (
    !/^http:\/\/127\.0\.0\.1:[0-9]+(?:\/|$)/.test(endpoint.url) ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !endpoint.token
  )
    throw new Error();
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/${suffix === "specs" ? "kernelspecs" : `kernels${suffix}`}`;
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
      if (method === "DELETE" && response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
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
    const admission = yield* KernelMessageAdmission.make;
    const url = yield* Effect.try({
      try: () => {
        const url = endpointUrl(endpoint, "/" + encodeURIComponent(id) + "/channels");
        url.searchParams.set("session_id", NodeCrypto.randomUUID());
        return url;
      },
      catch: () => new NotebookError({ reason: "unavailable" }),
    });
    const socket = yield* connectKernelSocket(url, endpoint.token, admission, admission.fail);
    const close = Effect.sync(() => socket.close()).pipe(Effect.andThen(admission.close));
    yield* Effect.addFinalizer(() => close);
    const execute = Effect.fn("JupyterTransport.execute")(function* (id: string, code: string) {
      admission.execute(id);
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
    return { messages: admission.messages, execute, close };
  });
  const probe = Effect.fn("JupyterTransport.probe")(function* (endpoint: Endpoint) {
    const value = yield* request(endpoint, "specs", "GET");
    const result = yield* decodeSpecs(value).pipe(
      Effect.mapError(() => new NotebookError({ reason: "unavailable" })),
    );
    if (!Object.hasOwn(result.kernelspecs, endpoint.kernelName))
      return yield* new NotebookError({ reason: "unavailable" });
  });
  const verify = Effect.fn("JupyterTransport.verify")(function* (
    endpoint: Endpoint,
    id: string,
    cwd: string,
  ) {
    if (!endpoint.interpreter) return yield* new NotebookError({ reason: "unavailable" });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const channels = yield* connect(endpoint, id);
        const requestId = NodeCrypto.randomUUID();
        const result = yield* Deferred.make<string, NotebookError>();
        yield* channels.messages.pipe(
          Stream.runForEach((message) => {
            if (message.parent_header.msg_id !== requestId) return Effect.void;
            if (message.header.msg_type === "stream" && typeof message.content.text === "string")
              return Deferred.succeed(result, message.content.text).pipe(Effect.asVoid);
            if (message.header.msg_type === "error")
              return Deferred.fail(result, new NotebookError({ reason: "unavailable" })).pipe(
                Effect.asVoid,
              );
            return Effect.void;
          }),
          Effect.catch(() => Deferred.fail(result, new NotebookError({ reason: "disconnected" }))),
          Effect.forkScoped,
        );
        yield* channels.execute(
          requestId,
          `import sys, os, json, importlib
for name in json.loads(${encodeJson(encodeJson(endpoint.imports ?? []))}): importlib.import_module(name)
print(json.dumps([os.path.realpath(sys.executable), os.path.realpath(os.getcwd())]))`,
        );
        const text = yield* Deferred.await(result).pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(() => new NotebookError({ reason: "unavailable" })),
        );
        const actual = yield* Effect.try({
          try: () => decodeJson(text),
          catch: () => new NotebookError({ reason: "unavailable" }),
        });
        if (!Array.isArray(actual) || actual[0] !== endpoint.interpreter || actual[1] !== cwd)
          return yield* new NotebookError({ reason: "unavailable" });
      }),
    );
  });
  return JupyterTransport.of({ create, control, connect, probe, verify });
});
