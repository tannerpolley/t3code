import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildT3ProjectFileJsonSchema,
  parseT3ProjectFile,
  T3ProjectFileFromJson,
} from "./t3ProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(T3ProjectFileFromJson);

describe("T3ProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", "stopOnSettle": true, },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev", stopOnSettle: true });
  });

  it("allows partial role maps with qualified skill IDs and publishes the field in the schema", () => {
    expect(decodeJson('{"roleSkills":{"designer":["cse:design"]}}').roleSkills).toEqual({
      designer: ["cse:design"],
    });
    expect(parseT3ProjectFile('{"roleSkills":{"designer":["../../SKILL.md"]}}')).toBeNull();
    expect(buildT3ProjectFileJsonSchema()).toMatchObject({
      properties: { roleSkills: { properties: { designer: { type: "array" } } } },
    });
  });
});

describe("parseT3ProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseT3ProjectFile(`{
        /* See https://t3.codes/schema/t3.json */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });
});
