import type { EnvironmentId } from "@t3tools/contracts";
import type { ResetCreditAccount } from "../ResetCreditAccounts";
import { Button } from "../ui/button";
import { ResetCreditDialog, useResetCredit } from "./UsageLimits";

export function ResetCreditAutoUseNotice({
  environmentId,
  account,
}: {
  readonly environmentId: EnvironmentId;
  readonly account: ResetCreditAccount;
}) {
  const redeem = useResetCredit(environmentId, account.input);
  const result = account.limits.resetCreditAutoUse;
  if (!result) return null;
  const available = account.limits.resetCredits?.expiries?.includes(result.expiresAt);
  const label = account.label;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="status">
      <span>
        {result.status === "used"
          ? `Used your banked ${label} reset before it expired.`
          : `Could not automatically use your banked ${label} reset before expiry.`}
      </span>
      {result.status === "failed" && available ? (
        <Button
          variant="outline"
          size="xs"
          disabled={redeem.busy || !redeem.canManageProviders}
          onClick={() => redeem.setConfirming(true)}
        >
          Use now
        </Button>
      ) : null}
      {redeem.status ? <span>{redeem.status}</span> : null}
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
    </div>
  );
}
