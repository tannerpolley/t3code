import {
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  TurnItemId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";
import { derivePendingThreadRequests } from "./threadRequests.ts";

const requestId = RuntimeRequestId.make("async-question");
const nodeId = NodeId.make("async-question-node");
const projection: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  runtimeRequests: [
    {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: v2Now,
      resolvedAt: null,
    },
  ],
  turnItems: [
    {
      id: TurnItemId.make("async-question-item"),
      threadId: v2Projection.thread.id,
      runId: null,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "user_input_request",
      requestId,
      responseMode: "message",
      questions: [
        {
          id: "next",
          header: "Next",
          question: "What should happen next?",
          required: true,
          allowCustomAnswer: false,
          options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
        },
      ],
    },
  ],
};

describe("pending v2 questions", () => {
  it("makes app-owned questions dismissible without turning them into message replies", () => {
    const appOwned = {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        responseCapability: {
          type: "app_owned" as const,
          providerSessionId: ProviderSessionId.make("app-owned-session"),
        },
      })),
      turnItems: projection.turnItems.map((item) =>
        item.type === "user_input_request" ? { ...item, responseMode: undefined } : item,
      ),
    };
    const pending = derivePendingThreadRequests(appOwned).userInputs[0];
    expect(pending?.responseCapability).toBe("app_owned");
    expect(pending?.dismissible).toBe(true);
    expect(pending?.responseMode).toBeUndefined();
  });
});

it("retains an answerable routed request when the owner opens the child", () => {
  const routedTo = ThreadId.make("orchestrator");
  const routed = {
    ...projection,
    runtimeRequests: projection.runtimeRequests.map((request) => ({ ...request, routedTo })),
  };
  expect(derivePendingThreadRequests(routed).userInputs[0]).toMatchObject({
    requestId,
    routedTo,
    responseCapability: "message",
    questions: expect.arrayContaining([expect.objectContaining({ id: "next" })]),
  });
});
