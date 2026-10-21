// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous comment parsing checks its content digest without a runtime service.
import * as NodeCrypto from "node:crypto";

type Kind = "request" | "choice" | "withdrawn";
const digest = (body: string) => NodeCrypto.createHash("sha256").update(body).digest("hex");
export const commentIdentity = (kind: Kind, id: string) => `<!-- t3-decision-${kind}:v1 id=${id} `;

export function decisionComment(kind: Kind, id: string, readable: string, optionId?: string) {
  return `${readable}\n\n${commentIdentity(kind, id)}${optionId === undefined ? "" : `option=${optionId} `}digest=${digest(readable)} -->`;
}

// IssueInbox may append its hidden cross-project source marker, outside the readable decision body.
const COMMENT =
  /^([\s\S]+)\n\n<!-- t3-decision-(request|choice|withdrawn):v1 id=(\S+)(?: option=([a-zA-Z0-9_-]+))? digest=([a-f0-9]{64}) -->(?:\n\n<!-- t3-source project=\S+ repository=\S+ thread=\S+ -->)?$/u;
export function parseDecisionComment(body: string) {
  const match = COMMENT.exec(body);
  if (match === null || digest(match[1]!) !== match[5]) return null;
  const [, readable, kind, id, optionId, contentDigest] = match;
  if ((kind === "choice") !== (optionId !== undefined)) return null;
  return { readable, kind, id, optionId, digest: contentDigest };
}
