import { ModelRoleProvider } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { ClaudeAI, OpenAI } from "./Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function RoleProviderToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ModelRoleProvider | undefined;
  onChange: (value: ModelRoleProvider) => void;
}) {
  const gt = useGT();
  const labels = { claude: "Claude", both: gt("Both"), codex: "Codex" };
  return (
    <ToggleGroup
      aria-label={label}
      value={value === undefined ? [] : [value]}
      onValueChange={([next]) => {
        const provider = ModelRoleProvider.literals.find((candidate) => candidate === next);
        if (provider !== undefined) onChange(provider);
      }}
    >
      {ModelRoleProvider.literals.map((provider) => (
        <Tooltip key={provider}>
          <TooltipTrigger
            render={<ToggleGroupItem value={provider} aria-label={labels[provider]} />}
          >
            {provider !== "codex" && <ClaudeAI />}
            {provider !== "claude" && <OpenAI />}
          </TooltipTrigger>
          <TooltipPopup>{labels[provider]}</TooltipPopup>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}
