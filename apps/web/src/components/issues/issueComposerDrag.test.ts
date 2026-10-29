import {
  COMPOSER_ISSUE_DRAG_TYPE,
  encodeIssueDragPayload,
  issueComposerDrag,
} from "./issueComposerDrag";
import { describe, expect, it } from "@effect/vitest";

import {
  COMPOSER_MENTION_DRAG_TYPE,
  type ComposerMentionDropHost,
  dataTransferHasComposerMention,
  makeComposerMentionDragHandlers,
} from "../chat/composerMentionDrag.ts";

const makeDragEvent = (options?: {
  mention?: string;
  types?: ReadonlyArray<string>;
  format?: string;
}) => {
  const mention = options?.mention ?? "[index.md](docs/index.md)";
  const format = options?.format ?? COMPOSER_MENTION_DRAG_TYPE;
  const calls: Array<string> = [];
  const event = {
    dataTransfer: {
      types: options?.types ?? [format, "text/plain"],
      getData: (requested: string) => (requested === format ? mention : ""),
      dropEffect: "none",
    },
    nativeEvent: {
      stopPropagation: () => void calls.push("nativeStopPropagation"),
    },
    preventDefault: () => void calls.push("preventDefault"),
    stopPropagation: () => void calls.push("stopPropagation"),
  };
  return { event, calls };
};

const makeHost = (insertResult = true) => {
  const log: Array<string> = [];
  const host: ComposerMentionDropHost = {
    insertMentionAtEnd: (text) => {
      log.push(`insert:${text}`);
      return insertResult;
    },
    insertPullRequestAtEnd: (pullRequest) => {
      log.push(`pr:${pullRequest.number}`);
      return insertResult;
    },
    additionalMention: issueComposerDrag(true, (issue) => {
      log.push(`issue:${issue.number}:${issue.repository}`);
      return insertResult;
    }),
    setDragActive: (active) => void log.push(`active:${active}`),
    onInsertRejected: () => void log.push("rejected"),
  };
  return { host, log };
};

const issue = {
  host: "github.com",
  repository: "owner/repo",
  number: 42,
  title: "Reference issues",
  url: "https://github.com/owner/repo/issues/42",
  state: "closed",
  stateReason: "completed",
  blockedBy: [],
  liveWork: [],
  pullRequests: [],
} as const;

describe("issue row drags", () => {
  it("leaves issue drags unclaimed when the server does not support issue contexts", () => {
    const { host, log } = makeHost();
    const handlers = makeComposerMentionDragHandlers({ ...host, additionalMention: undefined });
    const { event, calls } = makeDragEvent({
      format: COMPOSER_ISSUE_DRAG_TYPE,
      mention: encodeIssueDragPayload(issue),
    });
    expect(dataTransferHasComposerMention(event.dataTransfer.types)).toBe(false);
    handlers.onDragEnter(event);
    handlers.onDragOver(event);
    handlers.onDrop(event);
    expect(calls).toEqual([]);
    expect(log).toEqual([]);
    expect(event.dataTransfer.dropEffect).toBe("none");
  });
  it("claims issue drags and routes decoded metadata without eager focus", () => {
    const { host, log } = makeHost();
    const handlers = makeComposerMentionDragHandlers(host);
    const { event, calls } = makeDragEvent({
      format: COMPOSER_ISSUE_DRAG_TYPE,
      mention: encodeIssueDragPayload(issue),
    });
    expect(dataTransferHasComposerMention(event.dataTransfer.types, COMPOSER_ISSUE_DRAG_TYPE)).toBe(
      true,
    );
    handlers.onDragEnter(event);
    handlers.onDragOver(event);
    handlers.onDrop(event);
    expect(event.dataTransfer.dropEffect).toBe("move");
    expect(calls).toContain("nativeStopPropagation");
    expect(log).toEqual(["active:true", "active:true", "active:false", "issue:42:owner/repo"]);
  });
  it("reports a busy composer and ignores invalid issue payloads", () => {
    const { host, log } = makeHost(false);
    const handlers = makeComposerMentionDragHandlers(host);
    handlers.onDrop(
      makeDragEvent({ format: COMPOSER_ISSUE_DRAG_TYPE, mention: encodeIssueDragPayload(issue) })
        .event,
    );
    expect(log).toEqual(["active:false", "issue:42:owner/repo", "rejected"]);
    for (const mention of [
      "",
      "{",
      JSON.stringify({ ...issue, number: 0 }),
      JSON.stringify({ ...issue, repository: "bad" }),
      JSON.stringify({ ...issue, url: "javascript:alert(1)" }),
    ]) {
      log.length = 0;
      handlers.onDrop(makeDragEvent({ format: COMPOSER_ISSUE_DRAG_TYPE, mention }).event);
      expect(log).toEqual(["active:false"]);
    }
  });
});
