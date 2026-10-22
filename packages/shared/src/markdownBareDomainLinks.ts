type MarkdownNode = { type: string; url?: string; value?: string; children?: MarkdownNode[] };

const FILE_EXTENSION_TLDS = new Set([
  "md",
  "py",
  "sh",
  "rs",
  "js",
  "ts",
  "go",
  "pl",
  "so",
  "zip",
  "mov",
]);

// Bare `name.tld` reads as a file name as often as a web address, so only these TLDs link.
const WEB_TLDS = new Set(
  [
    "com",
    "org",
    "net",
    "io",
    "dev",
    "ai",
    "app",
    "co",
    "edu",
    "gov",
    "me",
    "us",
    "uk",
    "ca",
    "de",
    "fr",
    "eu",
    "jp",
    "au",
    "in",
    "info",
    "xyz",
    "tech",
    "cloud",
    "codes",
  ].filter((tld) => !FILE_EXTENSION_TLDS.has(tld)),
);

// No `/`, `\`, `.`, `@` or word character before the host keeps paths (`./a.com`,
// `src/a.com.ts`) and emails out; the lookahead stops `a.com` matching inside `a.com.ts`.
const BARE_DOMAIN =
  /(?<![\w@/\\.-])(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+([a-z]{2,})(?![\w-]|\.[a-z\d])(?::\d+)?(?:[/?#][^\s<]*)?/gi;

// GFM's autolink-literal rule: trailing punctuation and unbalanced `)` end the URL.
function trimTrailing(url: string): string {
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1]!;
    if (/[.,:;!?"'*_~]/.test(char)) end -= 1;
    else if (char === ")") {
      const head = url.slice(0, end);
      if (head.split("(").length >= head.split(")").length) break;
      end -= 1;
    } else break;
  }
  return url.slice(0, end);
}

function linkBareDomains(value: string): MarkdownNode[] | undefined {
  const parts: MarkdownNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(BARE_DOMAIN)) {
    if (!WEB_TLDS.has(match[1]!.toLowerCase())) continue;
    const url = trimTrailing(match[0]);
    if (match.index > offset) parts.push({ type: "text", value: value.slice(offset, match.index) });
    parts.push({ type: "link", url: `https://${url}`, children: [{ type: "text", value: url }] });
    offset = match.index + url.length;
  }
  if (offset === 0) return undefined;
  if (offset < value.length) parts.push({ type: "text", value: value.slice(offset) });
  return parts;
}

/** Links bare web addresses such as `github.com/owner/repo`, which GFM leaves as text. */
export function remarkBareDomainLinks() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === "link" || node.type === "linkReference" || !node.children) return;
      node.children.forEach(visit);
      // Text only sits in phrasing parents, where links are valid siblings.
      node.children = node.children.flatMap((child) =>
        child.type === "text" ? (linkBareDomains(child.value ?? "") ?? [child]) : [child],
      );
    };
    visit(tree);
  };
}
