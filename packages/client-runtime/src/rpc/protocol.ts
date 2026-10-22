import { WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/rpc";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

// Pings go out every 5 seconds; any decoded server frame resets the deadline.
export const PING_TIMEOUT = "15 seconds";
// The desktop server shares its event loop with work that can briefly stall it.
export const LOCAL_PING_TIMEOUT = "60 seconds";
