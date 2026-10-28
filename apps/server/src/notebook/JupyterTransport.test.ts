// @effect-diagnostics nodeBuiltinImport:off
// A scoped loopback fixture drives actual frames, chunking, admission, and reducer correlation.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import type * as NodeStream from "node:stream";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import { NOTEBOOK_LIMITS, type NotebookError } from "@t3tools/contracts";
import * as JupyterTransport from "./JupyterTransport.ts";
import { ExecutionReducer } from "./executionReducer.ts";
import { parseNotebook, byteLength } from "./notebookDocument.ts";

const frame = (text: string, opcode = 1, final = true) => {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length <= 65535 ? 4 : 10);
  header[0] = (final ? 128 : 0) | opcode;
  if (payload.length < 126) header[1] = payload.length;
  else if (payload.length <= 65535) {
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
};
const json = (id: string, type: string, content: Record<string, unknown>) =>
  JSON.stringify({
    content,
    channel: type === "execute_reply" ? "shell" : "iopub",
    parent_header: { msg_id: id },
    header: { msg_type: type },
  });
const fixture = Effect.gen(function* () {
  let peer: NodeStream.Duplex | undefined;
  let interrupts = 0;
  const server = NodeHttp.createServer((_request, response) => {
    interrupts++;
    response.writeHead(204);
    response.end();
  });
  server.on("upgrade", (request, socket) => {
    peer = socket;
    const accept = NodeCrypto.createHash("sha1")
      .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n",
    );
    socket.on("data", () => {});
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          peer?.destroy();
          server.close(() => resolve());
        }),
    ),
  );
  yield* Effect.callback<void>((resume) => {
    server.listen(0, "127.0.0.1", () => resume(Effect.void));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  const transport = yield* JupyterTransport.JupyterTransport;
  const endpoint = {
    url: "http://127.0.0.1:" + address.port,
    token: "test",
    kernelName: "python3",
  };
  const channels = yield* transport.connect(endpoint, "owned");
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
  return {
    channels,
    reducer,
    document,
    transport,
    endpoint,
    interrupts: () => interrupts,
    write: (data: Buffer) => peer!.write(data),
  };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R | JupyterTransport.JupyterTransport>) =>
  effect.pipe(Effect.provide(JupyterTransport.layer));

it.live.each([
  "stream",
  "frame",
  "burst",
  "input64",
  "reply64",
  "reply9",
  "reply9-idleFirst",
  "reply64-replyFirst",
  "input64-replyFirst",
  "aborted",
  "aborted-replyFirst",
] as const)(
  "%s retains bounded data and normalized control fields across reordered, fragmented JSON",
  (variant) =>
    Effect.gen(function* () {
      const mode = variant.split("-")[0]!;
      const { channels, reducer, document, transport, endpoint, interrupts, write } =
        yield* fixture;
      reducer.begin("request", document.cells[0]!);
      yield* channels.execute("request", "code");
      if (mode === "stream")
        write(
          frame(
            json("request", "stream", {
              name: "stdout",
              text: "x".repeat(NOTEBOOK_LIMITS.frameBytes),
            }),
          ),
        );
      if (mode === "burst")
        write(
          Buffer.concat(
            Array.from({ length: 1000 }, () =>
              frame(json("request", "stream", { name: "stdout", text: "burst\n" })),
            ),
          ),
        );
      if (mode === "frame")
        write(
          frame(
            json("request", "display_data", {
              data: { "text/plain": "x".repeat(9 * 1024 * 1024) },
              metadata: {},
            }),
          ),
        );
      const echo = json("request", "execute_input", {
        code: mode === "input64" ? "x".repeat(65536) : "",
        execution_count: 7,
      });
      // Both field order and JSON tokens cross WebSocket fragment boundaries.
      for (let offset = 0; offset < echo.length; offset += 7)
        write(
          frame(echo.slice(offset, offset + 7), offset === 0 ? 1 : 0, offset + 7 >= echo.length),
        );
      const idle = frame(json("request", "status", { execution_state: "idle" }));
      const error = mode === "reply64" || mode === "reply9";
      const replyStatus = mode === "aborted" ? "aborted" : error ? "error" : "ok";
      const reply = json("request", "execute_reply", {
        traceback: error ? ["x".repeat(mode === "reply9" ? 9 * 1024 * 1024 : 65536)] : [],
        status: replyStatus,
      });
      const split = Math.floor(reply.length / 2);
      const replies = Buffer.concat([
        frame(reply.slice(0, split), 1, false),
        frame("ping", 9),
        frame(reply.slice(split), 0),
      ]);
      write(
        variant === "reply9" || variant.endsWith("-replyFirst")
          ? Buffer.concat([replies, idle])
          : Buffer.concat([idle, replies]),
      );
      const complete = yield* Deferred.make<void, NotebookError>();
      let deliveredBytes = 0;
      const received: JupyterTransport.Message[] = [];
      yield* channels.messages.pipe(
        Stream.runForEach((message) =>
          Effect.gen(function* () {
            received.push(message);
            deliveredBytes += byteLength(message);
            if (reducer.reduce(message)?.complete) yield* Deferred.succeed(complete, undefined);
          }),
        ),
        Effect.catch((error) => Deferred.fail(complete, error)),
        Effect.forkScoped,
      );
      yield* Deferred.await(complete);
      yield* transport.control(endpoint, "owned", "interrupt");
      expect(interrupts()).toBe(1);
      expect(document.cells[0]?.execution_count).toBe(7);
      expect(reducer.truncated).toBe(["stream", "frame", "burst"].includes(mode));
      expect(received.find((m) => m.header.msg_type === "execute_input")?.content).toEqual({
        execution_count: 7,
      });
      expect(received.find((m) => m.header.msg_type === "execute_reply")?.content).toEqual({
        status: replyStatus,
      });
      expect(deliveredBytes).toBeLessThan(NOTEBOOK_LIMITS.frameBytes + 65536);
      expect(byteLength(document)).toBeLessThanOrEqual(NOTEBOOK_LIMITS.bytes);
    }).pipe(Effect.scoped, provide),
);

it.live("late A overflow during B retains A correlation and never truncates B", () =>
  Effect.gen(function* () {
    const { channels, reducer, document, write } = yield* fixture;
    reducer.begin("A", document.cells[0]!);
    yield* channels.execute("A", "a");
    const aDone = yield* Deferred.make<void>();
    const aReader = yield* channels.messages.pipe(
      Stream.runForEach((message) =>
        Effect.gen(function* () {
          if (reducer.reduce(message)?.complete) yield* Deferred.succeed(aDone, undefined);
        }),
      ),
      Effect.forkScoped,
    );
    write(
      Buffer.concat([
        frame(json("A", "execute_reply", { status: "ok" })),
        frame(json("A", "status", { execution_state: "idle" })),
      ]),
    );
    yield* Deferred.await(aDone);
    yield* Fiber.interrupt(aReader);
    reducer.begin("B", document.cells[1]!);
    yield* channels.execute("B", "b");
    write(
      Buffer.concat([
        ...Array.from({ length: 1000 }, () =>
          frame(json("A", "stream", { name: "stdout", text: "late\n" })),
        ),
        frame(json("B", "execute_reply", { status: "ok" })),
        frame(json("B", "status", { execution_state: "idle" })),
      ]),
    );
    const bDone = yield* Deferred.make<void>();
    const lossParents: Array<string | undefined> = [];
    yield* channels.messages.pipe(
      Stream.runForEach((message) =>
        Effect.gen(function* () {
          if (message.header.msg_type === "t3_output_lost")
            lossParents.push(message.parent_header.msg_id);
          if (reducer.reduce(message)?.complete && message.parent_header.msg_id === "B")
            yield* Deferred.succeed(bDone, undefined);
        }),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(bDone);
    expect(lossParents).toContain("A");
    expect(lossParents).not.toContain("B");
    expect(document.cells[0]?.outputs).toContainEqual(
      expect.objectContaining({ t3_truncated: true }),
    );
    expect(document.cells[1]?.outputs).toEqual([]);
  }).pipe(Effect.scoped, provide),
);

it.live("incomplete oversized JSON never becomes a valid partial output or completion", () =>
  Effect.gen(function* () {
    const { channels, write } = yield* fixture;
    yield* channels.execute("request", "code");
    const received: JupyterTransport.Message[] = [];
    const malformed = json("request", "execute_reply", {
      traceback: ["x".repeat(9 * 1024 * 1024)],
      status: "ok",
    }).slice(0, -1);
    write(frame(malformed));
    const error = yield* channels.messages.pipe(
      Stream.tap((message) =>
        Effect.sync(() => {
          received.push(message);
        }),
      ),
      Stream.runDrain,
      Effect.flip,
    );
    expect(error).toMatchObject({ reason: "disconnected" });
    expect(received).toEqual([]);
  }).pipe(Effect.scoped, provide),
);
