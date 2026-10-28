import type { NotebookEvent, NotebookSnapshot } from "@t3tools/contracts";

export function applyNotebookEvent(
  current: NotebookSnapshot,
  event: NotebookEvent,
): NotebookSnapshot | null {
  if (event.type === "snapshot") return event.snapshot;
  if (
    event.type === "resync-required" ||
    event.epoch !== current.epoch ||
    event.sequence !== current.sequence + 1
  )
    return null;
  const cells = Array.isArray(current.document.cells)
    ? ([...current.document.cells] as Record<string, unknown>[])
    : [];
  const executions = { ...current.executions };
  const changed = new Set<string>();
  for (const patch of event.patches) {
    const index = cells.findIndex((cell) => cell.id === patch.cellId);
    if (index < 0) return null;
    if (!changed.has(patch.cellId)) {
      cells[index] = {
        ...cells[index],
        outputs: [...((cells[index]!.outputs as Record<string, unknown>[]) ?? [])],
      };
      changed.add(patch.cellId);
    }
    const cell = cells[index]!;
    const outputs = cell.outputs as Record<string, unknown>[];
    switch (patch.type) {
      case "execution":
        cell.execution_count = patch.count;
        executions[patch.cellId] = patch.execution;
        break;
      case "count":
        cell.execution_count = patch.count;
        break;
      case "clear":
        cell.outputs = [];
        break;
      case "append":
        outputs.push(patch.output);
        break;
      case "replace":
        outputs[patch.index] = patch.output;
        break;
      case "stream": {
        const last = outputs.at(-1);
        if (!last || last.output_type !== "stream") return null;
        outputs[outputs.length - 1] = { ...last, text: String(last.text ?? "") + patch.text };
        break;
      }
    }
  }
  const { type: _, patches: __, cellId: ___, ...metadata } = event;
  return {
    ...current,
    ...metadata,
    executions,
    document: changed.size ? { ...current.document, cells } : current.document,
  };
}
