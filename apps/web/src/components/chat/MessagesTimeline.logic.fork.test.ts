import { ThreadId } from "@t3tools/contracts";
import {
  NodeId,
  TurnItemId,
  RuntimeRequestId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { deriveTimelineEntriesFromVisibleTurnItems, type TimelineEntry } from "../../session-logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";

import { describe, expect, it } from "vite-plus/test";
import { MessageId, RunId } from "@t3tools/contracts";

import {
  assistantTextIsSubstantial,
  deriveMessagesTimelineRows,
  type MessagesTimelineRow,
  workEntryResponderLabel,
} from "./MessagesTimeline.logic";

describe("assistantTextIsSubstantial", () => {
  it.each([
    "## Summary\nShipped.",
    "Changes:\n- one\n- two",
    "Steps:\n1. Build",
    "| a | b |\n|---|---|",
    "```ts\nconst x = 1;\n```",
    "![Chart](/tmp/chart.png)",
    "> Quoted note",
    "$$\nE = mc^2\n$$",
    "Area is \\(\\pi r^2\\).",
    "Done with the first part.\n\nThe second part needs review.",
    "word ".repeat(60),
    "The result is $x+1$.",
  ])("keeps %j visible", (text) => {
    expect(assistantTextIsSubstantial(text)).toBe(true);
  });

  it.each([
    "Checking the deployment config…",
    "Now the logic edits.",
    "Waiting on CI.\nThen I'll merge.",
    "It costs $5 - that's fine.",
    "Between $5 and $10 total.",
  ])("folds %j", (text) => {
    expect(assistantTextIsSubstantial(text)).toBe(false);
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("folds a short progress note and settled work before the terminal response", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-first-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-first" as never,
          role: "assistant" as const,
          text: "Checking the deployment config…",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          runId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);

    expect(foldRow?.label).toBe("Worked for 00m 22s");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-first-entry",
      "work-entry-1",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
  });

  describe("settled turn folds keep real answers visible", () => {
    const runId = RunId.make("turn-1");
    const message = (
      id: string,
      text: string,
      at: string,
      phase?: "commentary" | "final_answer",
    ): TimelineEntry => ({
      id: `${id}-entry`,
      kind: "message",
      createdAt: at,
      message: {
        id: id as never,
        role: "assistant",
        text,
        runId,
        createdAt: at,
        updatedAt: at,
        streaming: false,
      },
      ...(phase ? { projectedItem: { item: { type: "assistant_message", phase } } as never } : {}),
    });
    const work = (id: string, at: string): TimelineEntry => ({
      id: `${id}-entry`,
      kind: "work",
      createdAt: at,
      entry: { id, createdAt: at, runId, label: "Ran command", tone: "tool" },
    });
    const visibleRowIds = (entries: TimelineEntry[]) =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "user-entry",
            kind: "message",
            createdAt: "2026-01-01T00:00:00Z",
            message: {
              id: "user-1" as never,
              role: "user",
              text: "Build it",
              runId: null,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              streaming: false,
            },
          },
          ...entries,
        ],
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      }).map((row) => row.id);

    it("keeps a substantial summary visible when a tool call and a short closing line follow it", () => {
      expect(
        visibleRowIds([
          message("progress", "Checking the build…", "2026-01-01T00:00:01Z"),
          work("work-1", "2026-01-01T00:00:02Z"),
          message(
            "summary",
            "## Summary\n- Built the feature\n- Tests pass",
            "2026-01-01T00:00:03Z",
          ),
          work("work-2", "2026-01-01T00:00:04Z"),
          message("closing", "Waiting on CI.", "2026-01-01T00:00:05Z"),
        ]),
      ).toEqual(["user-entry", "turn-fold:turn-1", "summary-entry", "closing-entry"]);
    });

    it("keeps a plain summary under the length threshold visible before a short closing line", () => {
      const summary =
        "Round 1 of the fit is complete: the offset settled at -10.83922 and the log constant at " +
        "5.88696, both within tolerance of the reference values, and the residuals show no trend.";
      expect(
        visibleRowIds([
          message("progress", "Running the fit…", "2026-01-01T00:00:01Z"),
          work("work-1", "2026-01-01T00:00:02Z"),
          message("summary", summary, "2026-01-01T00:00:03Z"),
          work("work-2", "2026-01-01T00:00:04Z"),
          message("closing", "Done.", "2026-01-01T00:00:05Z"),
        ]),
      ).toEqual(["user-entry", "turn-fold:turn-1", "summary-entry", "closing-entry"]);
    });

    it("lets a Codex phase decide: commentary folds even when long, final answers show", () => {
      expect(
        visibleRowIds([
          message(
            "commentary",
            `## Plan\n${"word ".repeat(80)}`,
            "2026-01-01T00:00:01Z",
            "commentary",
          ),
          work("work-1", "2026-01-01T00:00:02Z"),
          message("answer", "Fixed.", "2026-01-01T00:00:03Z", "final_answer"),
          work("work-2", "2026-01-01T00:00:04Z"),
          message("closing", "Done.", "2026-01-01T00:00:05Z", "commentary"),
        ]),
      ).toEqual(["user-entry", "turn-fold:turn-1", "answer-entry", "closing-entry"]);
    });
  });

  it("derives a sane duration for a steer-superseded turn with one instant commentary message", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user" as const,
            text: "do it once more",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-before-message",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "work-before-message",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Status updated",
            tone: "info" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:09Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant" as const,
            text: "Kicking off call 1.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:09Z",
            updatedAt: "2026-01-01T00:00:09Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:12Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:12Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "steer-user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:14Z",
          message: {
            id: "user-2" as never,
            role: "user" as const,
            text: "actually do 15",
            runId: null,
            createdAt: "2026-01-01T00:00:14Z",
            updatedAt: "2026-01-01T00:00:14Z",
            streaming: false,
          },
        },
        {
          id: "assistant-next-turn-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:17Z",
          message: {
            id: "assistant-next" as never,
            role: "assistant" as const,
            text: "One down — adjusting.",
            runId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:17Z",
            updatedAt: "2026-01-01T00:00:17Z",
            streaming: true,
          },
        },
      ],
      latestRun: {
        runId: "turn-2" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:14Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:14Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const foldRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.label).toBe("Worked for 00m 12s");
  });

  it("uses latest-turn timings and the stopped label for an interrupted latest turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:47Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "turn-fold",
        runId: "turn-1",
        label: "You stopped after 00m 47s",
        expanded: false,
      }),
    ]);
  });

  it.each(["steer", "promoted_queued_to_steer"] as const)(
    "keeps the duration header at the initiating prompt when %s arrives before output",
    (inputIntent) => {
      const runId = RunId.make("steered-run");
      const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
      const prompt = (id: string, second: number, intent: "turn_start" | typeof inputIntent) => ({
        kind: "message" as const,
        id,
        createdAt: time(second),
        message: {
          id: MessageId.make(id),
          role: "user" as const,
          text: id,
          runId,
          inputIntent: intent,
          createdAt: time(second),
          updatedAt: time(second),
          streaming: false,
        },
      });
      const entries = [prompt("initial-prompt", 0, "turn_start"), prompt("steer", 5, inputIntent)];
      const work = {
        kind: "work" as const,
        id: "work",
        createdAt: time(8),
        entry: {
          id: "work",
          createdAt: time(8),
          runId,
          label: "Ran command",
          tone: "tool" as const,
        },
      };
      const final = {
        kind: "message" as const,
        id: "final",
        createdAt: time(20),
        message: {
          id: MessageId.make("final"),
          role: "assistant" as const,
          text: "Done",
          runId,
          createdAt: time(20),
          updatedAt: time(20),
          streaming: false,
        },
      };
      for (const isWorking of [true, false]) {
        for (const expanded of [true, false]) {
          const rows = deriveMessagesTimelineRows({
            timelineEntries: [...entries, work, final],
            latestRun: {
              runId,
              status: isWorking ? "running" : "completed",
              startedAt: time(0),
              completedAt: isWorking ? null : time(20),
            },
            isWorking,
            activeTurnStartedAt: time(0),
            expandedRunIds: expanded ? new Set([runId]) : new Set(),
            turnDiffSummaries: [],
            supportsConversationRollback: false,
          });
          expect(rows.slice(0, 3).map((row) => row.id)).toEqual([
            "initial-prompt",
            isWorking ? "working-indicator-row" : `turn-fold:${runId}`,
            "steer",
          ]);
          expect(rows[1]?.createdAt).toBe(time(0));
          if (!isWorking) expect(rows[1]).toMatchObject({ label: "Worked for 00m 20s", expanded });
          expect(rows.some((row) => row.id === "final")).toBe(true);
          expect(rows.some((row) => row.id === "work")).toBe(isWorking || expanded);
        }
      }
    },
  );

  it("folds each run of a provider-native subagent thread like a normal turn", () => {
    const threadId = ThreadId.make("subagent-child");
    const rootNodeId = NodeId.make("task-root");
    const at = (second: number) =>
      DateTime.makeUnsafe(new Date(Date.UTC(2026, 8, 25, 22, 51, second)).toISOString());
    const base = (id: string, ordinal: number, second: number, endSecond = second) => ({
      id: TurnItemId.make(id),
      threadId,
      runId: null,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: at(second),
      completedAt: at(endSecond),
      updatedAt: at(endSecond),
    });
    const prompt = (id: string, ordinal: number, second: number) => ({
      ...base(id, ordinal, second),
      type: "user_message" as const,
      messageId: MessageId.make(id),
      text: `Prompt ${id}`,
      attachments: [],
      inputIntent: "turn_start" as const,
      createdBy: "agent" as const,
      creationSource: "provider" as const,
    });
    const answer = (id: string, ordinal: number, second: number) => ({
      ...base(id, ordinal, second),
      type: "assistant_message" as const,
      messageId: MessageId.make(id),
      text: `Answer ${id}`,
      streaming: false,
    });
    type ResumeState = "running" | "completed" | "failed";
    const items = (resume: ResumeState) =>
      [
        prompt("launch", 1, 0),
        { ...base("launch-ls", 2, 4), type: "command_execution" as const, input: "ls src" },
        {
          ...base("launch-thinking", 3, 8),
          type: "reasoning" as const,
          title: "Thinking",
          text: "Not there.",
          streaming: false,
        },
        answer("launch-answer", 4, 8),
        prompt("resume", 5, 72),
        {
          ...base("resume-ls", 6, 77),
          type: "command_execution" as const,
          input: "ls src",
          status: resume === "running" ? ("running" as const) : ("completed" as const),
          completedAt: resume === "running" ? null : at(77),
        },
        ...(resume === "failed"
          ? [
              {
                ...base("resume-error", 7, 80),
                type: "error" as const,
                status: "failed" as const,
                failure: {
                  class: "provider_error" as const,
                  message: "Subagent failed",
                  code: null,
                  retryable: null,
                },
              },
            ]
          : []),
        ...(resume === "running" ? [] : [answer("resume-answer", 8, 80)]),
      ].map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      }));
    const rows = (input: {
      resume: ResumeState;
      working: boolean;
      expandedRunIds?: ReadonlySet<RunId>;
    }) =>
      deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: items(input.resume),
          optimisticMessages: [],
        }),
        latestRun: null,
        isWorking: input.working,
        runlessWorkActive: input.working,
        ...(input.expandedRunIds === undefined ? {} : { expandedRunIds: input.expandedRunIds }),
        activeTurnStartedAt: input.working ? DateTime.formatIso(at(72)) : null,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
    const shape = (timeline: ReadonlyArray<MessagesTimelineRow>) =>
      timeline.map((row) =>
        row.kind === "turn-fold"
          ? `fold:${row.label}`
          : row.kind === "message"
            ? `${row.message.role}:${row.message.id}`
            : row.kind,
      );

    const settled = rows({ resume: "completed", working: false });
    expect(shape(settled)).toEqual([
      "user:launch",
      "fold:Worked for 00m 08s",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 00m 08s",
      "assistant:resume-answer",
    ]);

    const launchFold = settled.find((row) => row.kind === "turn-fold");
    if (launchFold?.kind !== "turn-fold") throw new Error("Expected the launch fold");
    const expanded = rows({
      resume: "completed",
      working: false,
      expandedRunIds: new Set([launchFold.runId]),
    });
    expect(shape(expanded)).toEqual([
      "user:launch",
      "fold:Worked for 00m 08s",
      "work-toggle",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 00m 08s",
      "assistant:resume-answer",
    ]);

    expect(shape(rows({ resume: "running", working: true }))).toEqual([
      "user:launch",
      "fold:Worked for 00m 08s",
      "assistant:launch-answer",
      "user:resume",
      "working",
      "work-live",
    ]);

    expect(shape(rows({ resume: "failed", working: false }))).toEqual([
      "user:launch",
      "fold:Worked for 00m 08s",
      "assistant:launch-answer",
      "user:resume",
      "work",
      "work",
      "assistant:resume-answer",
    ]);
  });
});

describe("v2 run and attempt history", () => {
  it("folds settled-turn commentary and work behind a Worked-for row", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-thought-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-thought" as never,
          role: "assistant" as const,
          text: "Looking around first.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          runId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "provider-recovered-entry",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:09Z",
        entry: {
          id: "provider-recovered",
          createdAt: "2026-01-01T00:00:09Z",
          runId: "turn-1" as never,
          label: "Provider recovered (2/5 retries)",
          tone: "info" as const,
          itemType: "error" as const,
          toolLifecycleStatus: "completed" as const,
        },
      },
      {
        id: "thread-created-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:10Z",
        projectedItem: {
          item: {
            type: "thread_created",
          },
        } as never,
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);

    expect(foldRow?.label).toBe("Worked for 00m 22s");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "thread-created-entry",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-thought-entry",
      "work-toggle:work-entry-1",
      "thread-created-entry",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
    const openedActivity = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      expandedWorkGroupIds: new Set(["work-group:work-entry-1"]),
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const expandedWork = openedActivity.find((row) => row.kind === "work");
    expect(expandedWork?.kind === "work" ? expandedWork.groupedEntries : []).toEqual([
      expect.objectContaining({ id: "work-1" }),
      expect.objectContaining({ id: "provider-recovered" }),
    ]);
  });
});

it("attributes answered timeline requests to the orchestrator and preserves Don't ask mode labels", () => {
  const fixture = makeStreamingTimelineFixture();
  const source = fixture.visibleTurnItems[0]!;
  const common = {
    ...source.item,
    threadId: fixture.threadId,
    runId: fixture.runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
  };
  const items: OrchestrationV2TurnItem[] = [
    {
      ...common,
      id: TurnItemId.make("parent-question"),
      type: "user_input_request",
      requestId: RuntimeRequestId.make("parent-question"),
      questions: [],
      status: "completed",
      respondedBy: "orchestrator",
    },
    {
      ...common,
      id: TurnItemId.make("parent-approval"),
      type: "approval_request",
      requestId: RuntimeRequestId.make("parent-approval"),
      requestKind: "command",
      status: "completed",
      respondedBy: "orchestrator",
    },
    {
      ...common,
      id: TurnItemId.make("parent-decline"),
      type: "approval_request",
      requestId: RuntimeRequestId.make("parent-decline"),
      requestKind: "command",
      status: "cancelled",
      respondedBy: "orchestrator",
    },
    {
      ...common,
      id: TurnItemId.make("automatic"),
      type: "user_input_request",
      requestId: RuntimeRequestId.make("automatic"),
      questions: [],
      status: "completed",
      respondedBy: "dont_ask_mode",
    },
  ];
  const entries = deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: items.map((item, position) => ({
      ...source,
      item,
      position,
      sourceItemId: item.id,
    })),
    optimisticMessages: [],
  });
  expect(
    entries.flatMap((entry) =>
      entry.kind === "work" ? [workEntryResponderLabel(entry.entry)] : [],
    ),
  ).toEqual([
    "Answered by orchestrator",
    "Approved by orchestrator",
    "Declined by orchestrator",
    "Answered by Don't ask mode",
  ]);
});
