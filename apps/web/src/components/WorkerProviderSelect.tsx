import type { ServerSettings } from "@t3tools/contracts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

export const WORKER_PROVIDER_OPTIONS = [
  { value: "claude", label: "All Claude" },
  { value: "mixed", label: "Mixed" },
  { value: "codex", label: "All Codex" },
] as const;

export function WorkerProviderSelect({
  value,
  onChange,
}: {
  value: ServerSettings["workerProvider"];
  onChange: (value: ServerSettings["workerProvider"]) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const option = WORKER_PROVIDER_OPTIONS.find((option) => option.value === next);
        if (option) onChange(option.value);
      }}
    >
      <SelectTrigger size="sm" aria-label="Worker provider">
        <SelectValue>
          {WORKER_PROVIDER_OPTIONS.find((option) => option.value === value)?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {WORKER_PROVIDER_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
