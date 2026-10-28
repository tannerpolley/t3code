import { useState, useSyncExternalStore } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";

type Request = {
  persist: (discard: boolean) => Promise<boolean>;
  canSave: boolean;
  canDiscard: boolean;
  resolve: (allow: boolean) => void;
};
let request: Request | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
export function confirmNotebookClose(input: Omit<Request, "resolve">) {
  if (request) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    request = { ...input, resolve };
    notify();
  });
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export default function NotebookCloseDialog() {
  const current = useSyncExternalStore(subscribe, () => request);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const finish = (allow: boolean) => {
    current?.resolve(allow);
    request = null;
    setError(false);
    notify();
  };
  const persist = async (discard: boolean) => {
    if (!current) return;
    setPending(true);
    const saved = await current.persist(discard);
    setPending(false);
    if (saved) finish(true);
    else setError(true);
  };
  return (
    <Dialog
      open={current !== null}
      onOpenChange={(open) => {
        if (!open && !pending) finish(false);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Unsaved notebook</DialogTitle>
          <DialogDescription>
            Save to disk, retain this process-local draft, or discard it and reload the disk file.
            Discard affects every connected viewer.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="px-6 text-sm text-destructive">
            Save or reload failed. The draft remains open. Check for disk conflicts, changed
            revisions, or lost permissions.
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => finish(false)}>
            Cancel
          </Button>
          <Button variant="outline" disabled={pending} onClick={() => finish(true)}>
            Retain draft
          </Button>
          <Button
            variant="destructive"
            disabled={!current?.canDiscard || pending}
            onClick={() => void persist(true)}
          >
            Discard
          </Button>
          <Button disabled={!current?.canSave || pending} onClick={() => void persist(false)}>
            Save and close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
