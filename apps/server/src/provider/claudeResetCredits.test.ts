import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import type { AutomaticResetCredit } from "@t3tools/provider-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";
import { describe, expect, it } from "vite-plus/test";

import * as ClaudeResetCredits from "./claudeResetCredits.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const grant = (overrides: Record<string, unknown>) => ({
  id: "grant_a",
  resets_left: 1,
  usable_now: true,
  ...overrides,
});

const loginIdentity = { organizationUuid: "org-1", emailAddress: "user@example.test" };
const loginCredentials = '{"claudeAiOauth":{"accessToken":"oauth-token"}}';

const writeLogin = Effect.fnUntraced(function* (
  oauthAccount = loginIdentity as {
    organizationUuid?: string;
    emailAddress?: string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  yield* fs.writeFileString(path.join(directory, ".credentials.json"), loginCredentials);
  const accountConfigPath = path.join(directory, ".claude.json");
  yield* fs.writeFileString(accountConfigPath, JSON.stringify({ oauthAccount }));
  return { configDir: directory, accountConfigPath };
});

const respond = (status: number, body: unknown) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
  );
const refuseRequests = HttpClient.make(() => Effect.die("must not send a request"));

describe("claudeResetCreditsToContract", () => {
  it("counts live grants and pins the next usable one", () => {
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        {
          eligible: true,
          next_grant_id: "grant_a",
          grants: [
            grant({ resets_left: 2, ends_at: "2026-10-01T00:00:00Z" }),
            grant({ id: "paused", paused: true }),
            grant({ id: "expired", ends_at: "2026-09-01T00:00:00Z" }),
            grant({ id: "garbled", ends_at: "not a date" }),
            grant({ id: "date_only", ends_at: "2026-10-01" }),
            grant({ id: "impossible", ends_at: "2027-02-30T00:00:00Z" }),
            grant({ id: "empty", ends_at: "" }),
            grant({ id: "Not Valid" }),
            grant({ id: "grant_b", resets_left: 3, usable_now: false }),
          ],
        },
        NOW,
      ),
    ).toEqual({
      availableCount: 2,
      nextCreditId: "grant_a",
      nextExpiresAt: "2026-10-01T00:00:00.000Z",
      options: [
        expect.objectContaining({
          creditId: "grant_a",
          label: "Full reset",
          availableCount: 2,
          expiresAt: "2026-10-01T00:00:00.000Z",
        }),
      ],
    });
  });

  it("offers each kind of reset by its own grant", () => {
    const credits = ClaudeResetCredits.claudeResetCreditsToContract(
      {
        eligible: true,
        next_grant_id: "weekly_a",
        grants: [
          grant({ id: "weekly_a", clears: ["seven_day"], ends_at: "2026-12-10T22:00:00Z" }),
          grant({
            id: "fable_a",
            clears: ["seven_day_overage_included"],
            gives_back_weekly: true,
            ends_at: "2027-03-09T07:59:00Z",
          }),
          grant({ id: "fable_b", gives_back_weekly: true, type: "weekly" }),
          grant({ id: "session_a", type: "session" }),
          grant({ id: "spent", clears: ["seven_day"], resets_left: 0 }),
        ],
      },
      NOW,
    );
    expect(
      credits?.options?.map(({ creditId, label, availableCount }) => [
        creditId,
        label,
        availableCount,
      ]),
    ).toEqual([
      ["session_a", "5-hour reset", 1],
      ["weekly_a", "Weekly reset", 1],
      ["fable_a", "Fable reset", 2],
    ]);
    expect(credits).toMatchObject({
      availableCount: 4,
      nextCreditId: "weekly_a",
      nextExpiresAt: "2026-12-10T22:00:00.000Z",
    });
  });

  it("offers nothing to redeem without a usable next grant or an eligible account", () => {
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        { eligible: true, next_grant_id: "grant_a", grants: [grant({ usable_now: false })] },
        NOW,
      ),
    ).toEqual({ availableCount: 0 });
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract({ eligible: true, grants: [grant({})] }, NOW),
    ).toEqual({
      availableCount: 0,
    });
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        { eligible: false, grants: [grant({})] },
        NOW,
      ),
    ).toBeUndefined();
    expect(ClaudeResetCredits.claudeResetCreditsToContract(undefined, NOW)).toBeUndefined();
  });
});

effectIt.layer(NodeServices.layer)("readClaudeResetCredits", (it) => {
  it.effect("reads the grants with the CLI's request", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin();
      const client = HttpClient.make((request) => {
        expect(request.method).toBe("GET");
        expect(request.url).toBe("https://api.anthropic.com/api/oauth/usage");
        expect(UrlParams.toString(request.urlParams)).toBe("cedar_ember=1&skip_spend=1");
        expect(request.headers.authorization).toBe("Bearer oauth-token");
        expect(request.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
        expect(request.headers["user-agent"]).toBe("claude-cli/2.1.0 (external, cli)");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              cedar_ember: { eligible: true, next_grant_id: "grant_a", grants: [grant({})] },
            }),
          ),
        );
      });
      const credits = yield* ClaudeResetCredits.readClaudeResetCredits(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(credits).toMatchObject({ availableCount: 1, nextCreditId: "grant_a" });
    }),
  );

  it.effect("reads nothing from keychain logins or failed requests", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin();
      const darwin = yield* ClaudeResetCredits.readClaudeResetCredits(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HttpClient.HttpClient, refuseRequests),
      );
      const limited = yield* ClaudeResetCredits.readClaudeResetCredits(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, respond(429, {})),
      );
      expect([darwin, limited]).toEqual([undefined, undefined]);
    }),
  );
});

const ClaimBody = Schema.fromJsonString(
  Schema.Struct({ program: Schema.String, grant_id: Schema.String, request_id: Schema.String }),
);
const decodeClaimBody = Schema.decodeEffect(ClaimBody);

const consume = (
  client: HttpClient.HttpClient,
  ids = { grantId: "grant_a", requestId: "r-1" },
  automatic?: AutomaticResetCredit,
  oauthAccount?: Parameters<typeof writeLogin>[0],
) =>
  Effect.gen(function* () {
    const login = yield* writeLogin(oauthAccount);
    return yield* ClaudeResetCredits.consumeClaudeResetCredit({
      ...login,
      version: "2.1.0",
      ...ids,
      automatic,
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.result,
    );
  });

effectIt.layer(NodeServices.layer)("consumeClaudeResetCredit", (it) => {
  it.effect("uses the expiry of Claude's selected grant before posting a claim", () =>
    Effect.gen(function* () {
      const expiresAt = "2099-01-01T00:00:00.000Z";
      for (const { selected, login, workspaceId, methods: expected } of [
        {
          selected: "grant_a",
          login: loginIdentity,
          workspaceId: "org-1",
          methods: ["GET", "POST"],
        },
        { selected: "grant_b", login: loginIdentity, workspaceId: "org-1", methods: ["GET"] },
        {
          selected: "grant_a",
          login: { organizationUuid: "org-1" },
          workspaceId: "org-1",
          methods: [],
        },
        {
          selected: "grant_a",
          login: { emailAddress: loginIdentity.emailAddress },
          workspaceId: "org-1",
          methods: [],
        },
        {
          selected: "grant_a",
          login: { ...loginIdentity, emailAddress: "other@example.test" },
          workspaceId: "org-1",
          methods: [],
        },
        {
          selected: "grant_a",
          login: { ...loginIdentity, organizationUuid: "other" },
          workspaceId: "org-1",
          methods: [],
        },
        { selected: "grant_a", login: loginIdentity, workspaceId: undefined, methods: [] },
      ]) {
        const methods: string[] = [];
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            methods.push(request.method);
            const body =
              request.method === "POST"
                ? { result: "reset" }
                : {
                    cedar_ember: {
                      eligible: true,
                      next_grant_id: selected,
                      grants: [
                        grant({ ends_at: expiresAt }),
                        grant({ id: "grant_b", type: "weekly", ends_at: "2099-02-01T00:00:00Z" }),
                      ],
                    },
                  };
            return HttpClientResponse.fromWeb(request, Response.json(body));
          }),
        );
        const result = yield* consume(
          client,
          undefined,
          {
            creditId: "grant_a",
            expiresAt,
            email: "user@example.test",
            workspaceId,
            canRedeem: Effect.succeed(true),
          },
          login,
        );
        expect(result._tag).toBe(login.organizationUuid ? "Success" : "Failure");
        expect(methods).toEqual(expected);
      }
    }),
  );

  it.effect("reuses an unanswered claim ID after a login preparation failure", () =>
    Effect.gen(function* () {
      const login = yield* writeLogin();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const credentialFile = path.join(login.configDir, ".credentials.json");
      const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const expiresAt = "2099-01-01T00:00:00.000Z";
      const bodies: string[] = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.method === "POST" && request.body._tag === "Uint8Array") {
            bodies.push(new TextDecoder().decode(request.body.body));
            return HttpClientResponse.fromWeb(
              request,
              bodies.length === 1
                ? Response.json({}, { status: 503 })
                : Response.json({ result: "already_used" }),
            );
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              cedar_ember: {
                eligible: true,
                next_grant_id: "grant_a",
                grants: [grant({ ends_at: expiresAt, resets_left: 2 })],
              },
            }),
          );
        }),
      );
      const attempt = redeem(
        login.configDir,
        (requestId) =>
          ClaudeResetCredits.consumeClaudeResetCredit({
            ...login,
            grantId: "grant_a",
            requestId,
            version: "2.1.0",
            automatic: {
              creditId: "grant_a",
              expiresAt,
              email: loginIdentity.emailAddress,
              workspaceId: loginIdentity.organizationUuid,
              canRedeem: Effect.succeed(true),
            },
          }),
        ClaudeResetCredits.isSettledClaudeResetCreditFailure,
        "grant_a",
        true,
      ).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.result,
      );
      expect((yield* attempt)._tag).toBe("Failure");
      yield* fs.writeFileString(credentialFile, "invalid json");
      expect((yield* attempt)._tag).toBe("Failure");
      expect(bodies).toHaveLength(1);
      yield* fs.writeFileString(credentialFile, loginCredentials);
      expect(yield* attempt).toMatchObject({ success: "alreadyRedeemed" });
      expect(bodies).toEqual([bodies[0], bodies[0]]);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );
  it.effect("claims the grant for the organization", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          expect(request.method).toBe("POST");
          expect(request.url).toBe(
            "https://api.anthropic.com/api/organizations/org-1/reset_rate_limits",
          );
          expect(request.headers.authorization).toBe("Bearer oauth-token");
          const body =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
          expect(yield* decodeClaimBody(body)).toEqual({
            program: "cedar_ember",
            grant_id: "grant_a",
            request_id: "r-1",
          });
          return HttpClientResponse.fromWeb(request, Response.json({ result: "reset" }));
        }).pipe(Effect.orDie),
      );
      expect(yield* consume(client)).toMatchObject({ _tag: "Success", success: "reset" });
    }),
  );

  it.effect("maps each answer to an outcome or a failure", () =>
    Effect.gen(function* () {
      for (const [result, outcome] of [
        ["not_limited", "nothingToReset"],
        ["already_used", "alreadyRedeemed"],
        ["ineligible", "noCredit"],
      ] as const) {
        expect(yield* consume(respond(200, { result }))).toMatchObject({ success: outcome });
      }
      for (const client of [
        respond(200, { result: "cooldown" }),
        respond(429, {}),
        respond(401, {}),
      ]) {
        const result = yield* consume(client);
        expect(result).toMatchObject({ _tag: "Failure" });
        if (result._tag === "Failure") {
          expect(ClaudeResetCredits.isSettledClaudeResetCreditFailure(result.failure)).toBe(true);
        }
      }
      for (const client of [respond(500, {}), respond(200, { result: "unavailable" })]) {
        const unanswered = yield* consume(client);
        expect(unanswered).toMatchObject({ _tag: "Failure" });
        if (unanswered._tag === "Failure") {
          expect(ClaudeResetCredits.isSettledClaudeResetCreditFailure(unanswered.failure)).toBe(
            false,
          );
        }
      }
    }),
  );

  it.effect("refuses malformed ids without sending anything", () =>
    Effect.gen(function* () {
      for (const ids of [
        { grantId: "Bad Grant", requestId: "r-1" },
        { grantId: "grant_a", requestId: "has space" },
      ]) {
        expect(yield* consume(refuseRequests, ids)).toMatchObject({ _tag: "Failure" });
      }
    }),
  );
});
