import { threadRoleDisplay, type RoleDisplayThread } from "./threadRoleDisplay";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ThreadRoleIcon({ thread }: { readonly thread: RoleDisplayThread }) {
  const { label, description, icon: RoleIcon } = threadRoleDisplay(thread);
  const tooltip = `${label} · ${description}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={tooltip}
            className="inline-flex shrink-0 text-muted-foreground"
          />
        }
      >
        <RoleIcon aria-hidden className="size-3 shrink-0" />
      </TooltipTrigger>
      <TooltipPopup side="right">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
