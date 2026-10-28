import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  NotebookIdentity,
  NotebookHandle,
  NotebookExecute,
  NotebookControl,
  NotebookInterrupt,
  NotebookSnapshot,
  NotebookEvent,
  NotebookError,
} from "./notebook.ts";
export const NOTEBOOK_METHODS = {
  open: "notebook.open",
  snapshot: "notebook.snapshot",
  execute: "notebook.execute",
  interrupt: "notebook.interrupt",
  restart: "notebook.restart",
  shutdown: "notebook.shutdown",
  subscribe: "notebook.subscribe",
} as const;
const error = Schema.Union([NotebookError, EnvironmentAuthorizationError]);
export const notebookRpcs = [
  Rpc.make(NOTEBOOK_METHODS.open, { payload: NotebookIdentity, success: NotebookSnapshot, error }),
  Rpc.make(NOTEBOOK_METHODS.snapshot, {
    payload: NotebookHandle,
    success: NotebookSnapshot,
    error,
  }),
  Rpc.make(NOTEBOOK_METHODS.execute, { payload: NotebookExecute, success: Schema.String, error }),
  Rpc.make(NOTEBOOK_METHODS.interrupt, { payload: NotebookInterrupt, success: Schema.Void, error }),
  Rpc.make(NOTEBOOK_METHODS.restart, { payload: NotebookControl, success: Schema.Void, error }),
  Rpc.make(NOTEBOOK_METHODS.shutdown, { payload: NotebookControl, success: Schema.Void, error }),
  Rpc.make(NOTEBOOK_METHODS.subscribe, {
    payload: NotebookHandle,
    success: NotebookEvent,
    error,
    stream: true,
  }),
] as const;
