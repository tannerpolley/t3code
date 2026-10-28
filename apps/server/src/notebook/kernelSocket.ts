// @effect-diagnostics nodeBuiltinImport:off
// Streaming frame admission must discard oversized messages before allocating their declared length.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import { NotebookError, NOTEBOOK_LIMITS } from "@t3tools/contracts";

export const connectKernelSocket = Effect.fn("JupyterTransport.connectSocket")(
  (url: URL, token: string, receive: (text: string | null) => void, fail: () => void) =>
    Effect.callback<{ send: (text: string) => void; close: () => void }, NotebookError>(
      (resume) => {
        const key = NodeCrypto.randomBytes(16).toString("base64");
        let connected = false;
        const request = NodeHttp.request(url, {
          headers: {
            Authorization: `token ${token}`,
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Key": key,
            "Sec-WebSocket-Version": "13",
          },
        });
        const failed = () => {
          fail();
          resume(Effect.fail(new NotebookError({ reason: "disconnected" })));
        };
        request.on("error", failed);
        request.on("response", (response) => {
          response.destroy();
          failed();
        });
        request.on("upgrade", (response, socket, head) => {
          const accept = NodeCrypto.createHash("sha1")
            .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
            .digest("base64");
          if (
            response.statusCode !== 101 ||
            response.headers["sec-websocket-accept"] !== accept ||
            response.headers["sec-websocket-extensions"]
          ) {
            socket.destroy();
            failed();
            return;
          }
          const capacity = NOTEBOOK_LIMITS.bytes + 65536;
          const message = Buffer.allocUnsafe(capacity);
          const header = Buffer.alloc(10);
          let headerSize = 0,
            headerNeeded = 2,
            remaining = 0n,
            opcode = 0,
            final = false;
          let messageSize = 0,
            fragmented = false,
            discarded = false;
          const ping = Buffer.alloc(125);
          let pingSize = 0;
          let closed = false;
          const sendFrame = (opcode: number, payload: Buffer) => {
            if (closed || socket.writableLength + payload.length > 2 * capacity) throw new Error();
            const mask = NodeCrypto.randomBytes(4);
            const prefix = Buffer.alloc(
              payload.length < 126 ? 6 : payload.length <= 65535 ? 8 : 14,
            );
            prefix[0] = 128 | opcode;
            if (payload.length < 126) prefix[1] = 128 | payload.length;
            else if (payload.length <= 65535) {
              prefix[1] = 254;
              prefix.writeUInt16BE(payload.length, 2);
            } else {
              prefix[1] = 255;
              prefix.writeBigUInt64BE(BigInt(payload.length), 2);
            }
            mask.copy(prefix, prefix.length - 4);
            const encoded = Buffer.allocUnsafe(payload.length);
            for (let i = 0; i < payload.length; i++) encoded[i] = payload[i]! ^ mask[i % 4]!;
            socket.write(prefix);
            socket.write(encoded);
          };
          const close = () => {
            closed = true;
            socket.destroy();
          };
          const badFrame = () => {
            close();
            failed();
          };
          const finish = () => {
            if (opcode === 8) {
              badFrame();
              return;
            }
            if (opcode === 9) {
              sendFrame(10, ping.subarray(0, pingSize));
            }
            if ((opcode === 0 || opcode === 1) && final) {
              if (discarded) receive(null);
              else
                receive(
                  new TextDecoder("utf-8", { fatal: true }).decode(
                    message.subarray(0, messageSize),
                  ),
                );
              messageSize = 0;
              discarded = false;
              fragmented = false;
            }
            headerSize = 0;
            headerNeeded = 2;
          };
          const data = (chunk: Buffer) => {
            try {
              let offset = 0;
              while (offset < chunk.length) {
                if (closed) return;
                if (headerSize < headerNeeded) {
                  const count = Math.min(headerNeeded - headerSize, chunk.length - offset);
                  chunk.copy(header, headerSize, offset, offset + count);
                  offset += count;
                  headerSize += count;
                  if (headerSize < headerNeeded) continue;
                  if (headerNeeded === 2) {
                    const length = header[1]! & 127;
                    if (header[0]! & 112 || header[1]! & 128) {
                      badFrame();
                      return;
                    }
                    headerNeeded = length === 126 ? 4 : length === 127 ? 10 : 2;
                    if (headerSize < headerNeeded) continue;
                  }
                  opcode = header[0]! & 15;
                  final = Boolean(header[0]! & 128);
                  const length = header[1]! & 127;
                  remaining =
                    length === 126
                      ? BigInt(header.readUInt16BE(2))
                      : length === 127
                        ? header.readBigUInt64BE(2)
                        : BigInt(length);
                  if (
                    remaining >> 63n ||
                    ![0, 1, 8, 9, 10].includes(opcode) ||
                    (opcode >= 8 && (!final || remaining > 125n)) ||
                    (opcode === 0 && !fragmented) ||
                    (opcode === 1 && fragmented)
                  ) {
                    badFrame();
                    return;
                  }
                  if (opcode === 1) fragmented = !final;
                  if (opcode >= 8) pingSize = 0;
                  if (opcode < 8 && remaining > BigInt(capacity - messageSize)) discarded = true;
                  if (remaining === 0n) {
                    finish();
                    continue;
                  }
                }
                const count = Number(
                  remaining < BigInt(chunk.length - offset)
                    ? remaining
                    : BigInt(chunk.length - offset),
                );
                if (opcode === 9) {
                  chunk.copy(ping, pingSize, offset, offset + count);
                  pingSize += count;
                } else if (opcode < 8 && !discarded) {
                  chunk.copy(message, messageSize, offset, offset + count);
                  messageSize += count;
                }
                offset += count;
                remaining -= BigInt(count);
                if (remaining === 0n) finish();
              }
            } catch {
              badFrame();
            }
          };
          socket.on("data", data);
          socket.on("error", failed);
          socket.on("close", () => {
            if (!closed) failed();
          });
          connected = true;
          resume(Effect.succeed({ send: (text) => sendFrame(1, Buffer.from(text)), close }));
          if (head.length) data(head);
        });
        request.end();
        return Effect.sync(() => {
          if (!connected) {
            request.destroy();
          }
        });
      },
    ),
);
