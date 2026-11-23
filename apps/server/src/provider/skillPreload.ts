import type { OrchestrationV2SkillPreload, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYaml } from "yaml";
import type { selectRoleSkills } from "./roleSkills.ts";

const maxContextBytes = 64 * 1024;
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const plainFields = new Set(["name", "description", "license", "compatibility", "metadata"]);

function instructionBody(contents: string) {
  const match = frontmatter.exec(contents);
  if (match === null && /^---(?:\r?\n|$)/.test(contents)) return undefined;
  if (match !== null) {
    try {
      const fields: unknown = parseYaml(match[1]!, { maxAliasCount: 0 });
      if (
        typeof fields !== "object" ||
        fields === null ||
        Array.isArray(fields) ||
        Object.keys(fields).some((key) => !plainFields.has(key))
      )
        return undefined;
    } catch {
      return undefined;
    }
  }
  const body = contents.slice(match?.[0].length ?? 0).trim();
  // Inline shell expansion, invocation arguments, and session-specific variables require native invocation.
  return body === "" || /!`|\${?ARGUMENTS\b|\$\d+\b|\$\{CLAUDE_SESSION_ID\}/.test(body)
    ? undefined
    : body;
}

const readSkillBody = Effect.fn("skillPreload.readBody")(
  function* (filePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!path.isAbsolute(filePath) || path.basename(filePath) !== "SKILL.md")
      return { reason: "unreadable" } as const;
    const stat = yield* fs.stat(filePath);
    if (stat.type !== "File") return { reason: "unreadable" } as const;
    if (stat.size > maxContextBytes) return { reason: "budget" } as const;
    const file = yield* fs.open(filePath, { flag: "r" });
    const bytes = new Uint8Array(maxContextBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = yield* file.read(bytes.subarray(length));
      if (count === 0) break;
      length += count;
    }
    if (length > maxContextBytes) return { reason: "budget" } as const;
    const contents = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
      catch: () => "invalid-utf8" as const,
    });
    const body = instructionBody(contents);
    return body === undefined
      ? ({ reason: "unsupported" } as const)
      : { body: body.replaceAll("${CLAUDE_SKILL_DIR}", path.dirname(filePath)) };
  },
  Effect.scoped,
  Effect.orElseSucceed(() => ({ reason: "unreadable" as const })),
);

type SkillRecord = OrchestrationV2SkillPreload["skills"][number];
type SkipReason = Extract<SkillRecord, { outcome: "skipped" }>["reason"];

const renderSkill = (id: string, directory: string, body: string) =>
  `Skill ${id} (directory: ${JSON.stringify(directory)})\n\n${body}`;

export const prepareSkillPreload = Effect.fn("skillPreload.prepare")(function* (
  requests: ReadonlyArray<ReturnType<typeof selectRoleSkills>[number]>,
  catalogue: ReadonlyArray<ServerProviderSkill> | undefined,
) {
  const path = yield* Path.Path;
  const skills: SkillRecord[] = [];
  const bodies: string[] = [];
  let bytesRemaining = maxContextBytes;
  for (const request of requests) {
    const skipped = (reason: SkipReason) => skills.push({ ...request, outcome: "skipped", reason });
    if (catalogue === undefined) {
      skipped("policy_unknown");
      continue;
    }
    const matches = catalogue.filter(
      (skill) => skill.name === request.id && skill.scope === "plugin",
    );
    const [skill] = matches;
    if (matches.length > 1) {
      skipped("ambiguous");
      continue;
    }
    if (skill === undefined || !skill.enabled) {
      skipped("unavailable");
      continue;
    }
    if (skill.userInvocationOnly || skill.userInvocable === false) {
      skipped("unsupported");
      continue;
    }
    const result = yield* readSkillBody(skill.path);
    if (result.reason !== undefined) {
      skipped(result.reason);
      continue;
    }
    const section = renderSkill(request.id, path.dirname(skill.path), result.body);
    const bytes = Buffer.byteLength(section) + 2;
    if (bytes > bytesRemaining) {
      skipped("budget");
      continue;
    }
    bytesRemaining -= bytes;
    bodies.push(section);
    skills.push({ ...request, outcome: "delivery_unknown" });
  }
  return { context: bodies.join("\n\n"), skills };
});
