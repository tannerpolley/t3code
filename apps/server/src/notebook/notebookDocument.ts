// @effect-diagnostics nodeBuiltinImport:off
// Missing nbformat cell IDs are assigned without altering existing JSON fields.
import * as NodeCrypto from "node:crypto";
import { NOTEBOOK_LIMITS, NotebookError, type NotebookDocument } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const source = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
const cellSchema = Schema.Struct({
  cell_type: Schema.Literals(["code", "markdown", "raw"]),
  source,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  id: Schema.optional(Schema.String),
  outputs: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});
const documentSchema = Schema.Struct({
  nbformat: Schema.Literal(4),
  nbformat_minor: Schema.Int,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  cells: Schema.Array(cellSchema),
});
export type NotebookCell = Omit<typeof cellSchema.Type, "id" | "outputs"> & {
  id: string;
  outputs?: Array<Record<string, unknown>>;
  execution_count?: number | null;
};
export type Document = NotebookDocument & { cells: NotebookCell[] };
export const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
export function parseNotebook(text: string): { document: Document; changed: boolean } {
  try {
    if (Buffer.byteLength(text) > NOTEBOOK_LIMITS.bytes) throw new Error();
    const value: unknown = JSON.parse(text);
    const checked = Schema.decodeUnknownSync(documentSchema)(value);
    if (checked.cells.length > NOTEBOOK_LIMITS.cells || checked.nbformat_minor < 0)
      throw new Error();
    const document = value as Document;
    const ids = new Set<string>();
    let changed = false;
    for (const cell of document.cells) {
      if (cell.id === undefined) {
        cell.id = NodeCrypto.randomUUID();
        changed = true;
      }
      if (
        !/^[a-zA-Z0-9_-]{1,64}$/.test(cell.id) ||
        ids.has(cell.id) ||
        (cell.outputs?.length ?? 0) > NOTEBOOK_LIMITS.outputs
      )
        throw new Error();
      ids.add(cell.id);
      if (
        cell.cell_type === "code" &&
        (!cell.outputs ||
          !(cell.execution_count === null || Number.isInteger(cell.execution_count)))
      )
        throw new Error();
    }
    if (byteLength(document) > NOTEBOOK_LIMITS.bytes) throw new Error();
    return { document, changed };
  } catch {
    throw new NotebookError({ reason: "invalid-document" });
  }
}
