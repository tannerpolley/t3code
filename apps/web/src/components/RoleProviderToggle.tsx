import { ModelRoleProvider } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

export function RoleProviderToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ModelRoleProvider;
  onChange: (value: ModelRoleProvider) => void;
}) {
  const gt = useGT();
  const labels = { claude: "Claude", both: gt("Both"), codex: "Codex" };
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={([next]) => {
        const provider = ModelRoleProvider.literals.find((candidate) => candidate === next);
        if (provider !== undefined) onChange(provider);
      }}
    >
      {ModelRoleProvider.literals.map((provider) => (
        <ToggleGroupItem key={provider} value={provider}>
          {labels[provider]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
