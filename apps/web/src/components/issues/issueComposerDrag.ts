import { IssueContextMetadata } from "@t3tools/contracts";
import { Option, Schema } from "effect";

export const COMPOSER_ISSUE_DRAG_TYPE = "application/x-t3code-issue";
const IssueDragPayload = Schema.fromJsonString(IssueContextMetadata);
const decodeIssuePayload = Schema.decodeUnknownOption(IssueDragPayload);
export const encodeIssueDragPayload = Schema.encodeSync(IssueDragPayload);

export function issueComposerDrag(
  supported: boolean,
  insert: (issue: IssueContextMetadata) => boolean,
) {
  return supported
    ? {
        type: COMPOSER_ISSUE_DRAG_TYPE,
        insert: (payload: string) => {
          const issue = decodeIssuePayload(payload);
          return Option.isSome(issue) ? insert(issue.value) : undefined;
        },
      }
    : undefined;
}
