import type { EnvironmentId, IssueSetStateInput } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { issueEnvironment, refreshIssueLists } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { toastManager } from "../ui/toast";

export function reportIssueStateFailure(cause: unknown) {
  toastManager.add({
    type: "error",
    title: m(msg("The state could not be changed")),
    description: readableFailure(cause, m(msg("The tracker refused it."))),
  });
}

export function useSetIssueState() {
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: false });
  return async (environmentId: EnvironmentId, input: IssueSetStateInput) => {
    const result = await setState({ environmentId, input });
    if (result._tag === "Failure") {
      reportIssueStateFailure(squashAtomCommandFailure(result));
      return;
    }
    refreshIssueLists(environmentId);
  };
}
