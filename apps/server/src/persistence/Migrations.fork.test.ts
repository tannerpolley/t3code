import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";

import * as Logger from "effect/Logger";

import { migrationManifest, runMigrations } from "./Migrations.ts";

describe("runMigrations", () => {
  it.effect("announces pending upstream and fork migrations, but stays quiet when current", () =>
    Effect.gen(function* () {
      const messages: unknown[] = [];
      const logger = Logger.make(({ message }) => {
        messages.push(...(Array.isArray(message) ? message : [message]));
      });
      yield* Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: migrationManifest.at(-1)![0] });
        assert.include(messages, "Running database migrations");
        assert.include(messages, "Migrations ran successfully");
        messages.length = 0;
        yield* runMigrations();
        assert.include(messages, "Running database migrations");
        assert.include(messages, "Migrations ran successfully");
        messages.length = 0;
        yield* runMigrations();
        assert.notInclude(messages, "Running database migrations");
        assert.notInclude(messages, "Migrations ran successfully");
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
