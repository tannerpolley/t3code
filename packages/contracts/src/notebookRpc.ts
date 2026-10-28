import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  NotebookSubscribe,
  NotebookSave,
  NotebookEdit,
  NotebookCreate,
  NotebookLease,
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
  save: "notebook.save",
  edit: "notebook.edit",
  create: "notebook.create",
  close: "notebook.close",
  acquire: "notebook.acquire",
  snapshot: "notebook.snapshot",
  execute: "notebook.execute",
  interrupt: "notebook.interrupt",
  restart: "notebook.restart",
  shutdown: "notebook.shutdown",
  subscribe: "notebook.subscribe",
} as const;
const error = Schema.Union([NotebookError, EnvironmentAuthorizationError]);
export const notebookRpcs = [
  Rpc.make(NOTEBOOK_METHODS.save, { payload: NotebookSave, success: NotebookSnapshot, error }),
  Rpc.make(NOTEBOOK_METHODS.edit, { payload: NotebookEdit, success: NotebookSnapshot, error }),
  Rpc.make(NOTEBOOK_METHODS.create, { payload: NotebookCreate, success: NotebookSnapshot, error }),
  Rpc.make(NOTEBOOK_METHODS.close, { payload: NotebookLease, success: Schema.Void, error }),
  Rpc.make(NOTEBOOK_METHODS.acquire, { payload: NotebookLease, success: NotebookSnapshot, error }),
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
    payload: NotebookSubscribe,
    success: NotebookEvent,
    error,
    stream: true,
  }),
] as const;
