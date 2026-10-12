import type * as CodexSchema from "effect-codex-app-server/schema";

export function combineApprovalPrompt(
  descriptions: ReadonlyArray<string | null | undefined>,
  operation?: string | null,
): string | undefined {
  const seen = new Set<string>();
  const parts: Array<string> = [];
  for (const description of descriptions) {
    const trimmed = description?.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      parts.push(trimmed);
    }
  }

  if (operation !== undefined && operation !== null) {
    const operationKey = operation.trim();
    if (operationKey && !seen.has(operationKey)) {
      parts.push(operation);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

type CodexPermissionProfile = CodexSchema.PermissionsRequestApprovalParams["permissions"];
type CodexFileSystemPath = NonNullable<
  NonNullable<CodexPermissionProfile["fileSystem"]>["entries"]
>[number]["path"];

function codexFileSystemPathLabel(path: CodexFileSystemPath): string {
  if (path.type === "path") return path.path;
  if (path.type === "glob_pattern") return path.pattern;
  const { kind, ...rest } = path.value;
  return [kind, ...Object.values(rest).filter((part) => part != null)].join(" ");
}

/** Accepting grants the whole requested profile, so the prompt lists all of it. */
export function codexPermissionsApprovalPrompt(input: {
  readonly reason?: string | null;
  readonly cwd: string;
  readonly permissions: CodexPermissionProfile;
}): string | undefined {
  const { fileSystem, network } = input.permissions;
  const details = [
    `Working directory: ${input.cwd}`,
    ...(fileSystem?.read ?? []).map((path) => `read ${path}`),
    ...(fileSystem?.write ?? []).map((path) => `write ${path}`),
    ...(fileSystem?.entries ?? []).map(
      (entry) => `${entry.access} ${codexFileSystemPathLabel(entry.path)}`,
    ),
    ...(network?.enabled == null ? [] : [`network ${network.enabled ? "enabled" : "disabled"}`]),
  ];
  return combineApprovalPrompt([input.reason], details.join("\n"));
}
