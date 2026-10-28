// @effect-diagnostics nodeBuiltinImport:off
// A loopback protocol fixture exercises framing and admission without a Jupyter process.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import type * as NodeStream from "node:stream";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import { NOTEBOOK_LIMITS } from "@t3tools/contracts";
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

it.live.each(["stream", "frame", "burst"] as const)(
  "%s overflow retains bounded data without losing completion or control",
  (mode) =>
    Effect.gen(function* () {
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
          cells: [
            {
              id: "a",
              cell_type: "code",
              source: "",
              metadata: {},
              execution_count: null,
              outputs: [],
            },
          ],
        }),
      ).document;
      const reducer = new ExecutionReducer(document);
      const message = (type: string, content: Record<string, unknown>) =>
        frame(
          JSON.stringify({
            header: { msg_type: type },
            parent_header: { msg_id: "request" },
            channel: type === "execute_reply" ? "shell" : "iopub",
            content,
          }),
        );
      reducer.begin("request", document.cells[0]!);
      yield* channels.execute("request", "print('flood')");
      if (mode === "stream")
        peer!.write(
          message("stream", { name: "stdout", text: "x".repeat(NOTEBOOK_LIMITS.frameBytes) }),
        );
      if (mode === "burst")
        peer!.write(
          Buffer.concat(
            Array.from({ length: 1000 }, () =>
              message("stream", { name: "stdout", text: "burst\\n" }),
            ),
          ),
        );
      if (mode === "frame")
        peer!.write(
          message("display_data", {
            data: { "text/plain": "x".repeat(NOTEBOOK_LIMITS.bytes + 65536) },
            metadata: {},
          }),
        );
      const reply = JSON.stringify({
        header: { msg_type: "execute_reply" },
        parent_header: { msg_id: "request" },
        channel: "shell",
        content: { status: "ok" },
      });
      const split = Math.floor(reply.length / 2);
      peer!.write(
        Buffer.concat([
          message("status", { execution_state: "idle" }),
          frame(reply.slice(0, split), 1, false),
          frame("ping", 9),
          frame(reply.slice(split), 0),
        ]),
      );
      const complete = yield* Deferred.make<void>();
      let deliveredBytes = 0;
      yield* channels.messages.pipe(
        Stream.runForEach((message) =>
          Effect.gen(function* () {
            deliveredBytes += byteLength(message);
            if (reducer.reduce(message)?.complete) yield* Deferred.succeed(complete, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(complete);
      yield* transport.control(endpoint, "owned", "interrupt");
      expect(interrupts).toBe(1);
      expect(reducer.truncated).toBe(true);
      expect(document.cells[0]?.outputs).toContainEqual(
        expect.objectContaining({ text: "[T3 output truncated]\n" }),
      );
      expect(deliveredBytes).toBeLessThan(NOTEBOOK_LIMITS.frameBytes + 65536);
      expect(byteLength(document)).toBeLessThanOrEqual(NOTEBOOK_LIMITS.bytes);
    }).pipe(Effect.scoped, Effect.provide(JupyterTransport.layer)),
);
