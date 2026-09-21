import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { IssueDetailResult, IssueListInput, IssueListResult, IssueRef } from "./issue.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const decodeRef = Schema.decodeUnknownSync(IssueRef);
const decodeListInput = Schema.decodeUnknownSync(IssueListInput);
const decodeListResult = Schema.decodeUnknownSync(IssueListResult);
const decodeDetailResult = Schema.decodeUnknownSync(IssueDetailResult);

const repository = {
  projectId: "project-1",
  host: "github.com",
  repository: "owner/repo",
};

const ref = {
  ...repository,
  number: 42,
};

const issue = {
  number: 42,
  title: "Add issue workspace",
  url: "https://github.com/owner/repo/issues/42",
  state: "open",
  stateReason: null,
  author: null,
  assignees: [{ login: "octocat", avatarUrl: null }],
  labels: [{ name: "enhancement", color: "aabbcc" }],
  milestone: null,
  createdAt: "2026-09-20T00:00:00Z",
  updatedAt: "2026-09-21T00:00:00Z",
  commentCount: 2,
};

const listResult = {
  repository,
  projectTitle: "Project",
  workspaceRoot: "/workspace/project",
  viewer: null,
  fetchedAt: "2026-09-21T00:00:00Z",
  issues: [issue],
  milestones: [
    {
      number: 1,
      title: "v1",
      state: "open",
      dueAt: null,
      url: "https://github.com/owner/repo/milestone/1",
      openCount: 1,
      closedCount: 0,
    },
  ],
  nextCursor: null,
  issuesComplete: true,
  milestonesComplete: true,
};

const detailResult = { ...listResult, issue, body: "" };

describe("GitHub issue contract boundaries", () => {
  it("rejects invalid issue numbers, repository references, and cursors", () => {
    for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => decodeRef({ ...ref, number })).toThrow();
    }

    expect(() => decodeRef({ ...ref, host: " " })).toThrow();
    expect(() => decodeRef({ ...ref, repository: "owner" })).toThrow();
    expect(() => decodeRef({ ...ref, repository: "owner/repo/extra" })).toThrow();
    expect(
      decodeListInput({ projectId: ref.projectId, cursor: "c".repeat(4096) }).cursor,
    ).toHaveLength(4096);
    expect(() => decodeListInput({ projectId: ref.projectId, cursor: "c".repeat(4097) })).toThrow();
  });

  it("bounds issue URLs and workspace paths", () => {
    expect(() => decodeDetailResult({ ...detailResult, workspaceRoot: " " })).toThrow();
    expect(() =>
      decodeDetailResult({
        ...detailResult,
        issue: { ...issue, url: "github.com/owner/repo/issues/42" },
      }),
    ).toThrow();
    expect(() =>
      decodeDetailResult({
        ...detailResult,
        issue: { ...issue, url: `https://github.com/${"x".repeat(2040)}` },
      }),
    ).toThrow();
  });

  it("accepts nullable author, milestone, and viewer fields plus an empty body", () => {
    expect(decodeListResult(listResult)).toMatchObject({
      viewer: null,
      issues: [{ author: null, milestone: null }],
    });
    expect(decodeDetailResult(detailResult)).toMatchObject({ issue, body: "" });
  });

  it("round-trips the list result through the JSON wire codec", () => {
    const codec = Schema.toCodecJson(IssueListResult);
    const encoded = Schema.encodeUnknownSync(codec)(listResult);

    expect(Schema.decodeUnknownSync(codec)(encoded)).toStrictEqual(listResult);
  });

  it("registers issue RPC payload, result, and error codecs", () => {
    const listRpc = WsRpcGroup.requests.get(WS_METHODS.issuesList);
    const detailRpc = WsRpcGroup.requests.get(WS_METHODS.issuesDetail);
    expect(listRpc).toBeDefined();
    expect(detailRpc).toBeDefined();
    if (listRpc === undefined || detailRpc === undefined) return;

    expect(Schema.decodeUnknownSync(listRpc.payloadSchema)({ projectId: ref.projectId })).toEqual({
      projectId: ref.projectId,
    });
    expect(Schema.decodeUnknownSync(detailRpc.payloadSchema)(ref)).toMatchObject(ref);
    expect(Schema.decodeUnknownSync(listRpc.successSchema)(listResult)).toMatchObject(listResult);

    expect(
      Schema.decodeUnknownSync(listRpc.errorSchema)({
        _tag: "IssueReadError",
        code: "invalid-cursor",
        operation: "list",
        message: "The cursor is invalid.",
      }),
    ).toMatchObject({ _tag: "IssueReadError", code: "invalid-cursor" });
    expect(
      Schema.decodeUnknownSync(detailRpc.errorSchema)({
        _tag: "EnvironmentAuthorizationError",
        message: "Read access is required.",
        requiredScope: "orchestration:read",
      }),
    ).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
  });
});
describe("githubIssues capability compatibility", () => {
  const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
  const descriptor = {
    environmentId: "environment-1",
    label: "Local",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.42",
    capabilities: { repositoryIdentity: true },
  };

  it("treats the missing capability as unsupported and preserves true", () => {
    expect(decodeDescriptor(descriptor).capabilities.githubIssues).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, githubIssues: true },
      }).capabilities.githubIssues,
    ).toBe(true);
  });
});
