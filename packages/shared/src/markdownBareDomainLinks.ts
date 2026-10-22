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

// Bare `name.tld` reads as a file name or property access (`self.app`, `Dockerfile.dev`) as
// often as a web address. Without a path only these classic TLDs link; with a `/` path any
// `WEB_TLDS` entry does. `?` and `#` are not paths, so `example.io?q=1` stays text.
const PATHLESS_TLDS = new Set(["com", "org", "net", "edu", "gov"]);

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
  /(?<![\w@/\\.-])(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+([a-z]{2,})(?![\w-]|\.[a-z\d])(?::\d+)?([/?#][^\s<]*)?/gi;

// GFM's autolink-literal rule: trailing punctuation and unbalanced `)` end the URL.
function trimTrailing(url: string): string {
  let unmatched = 0;
  for (const char of url) unmatched += char === ")" ? 1 : char === "(" ? -1 : 0;
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1]!;
    if (/[.,:;!?"'*_~]/.test(char)) end -= 1;
    else if (char === ")" && unmatched > 0) {
      unmatched -= 1;
      end -= 1;
    } else break;
  }
  return url.slice(0, end);
}

function linkBareDomains(value: string): MarkdownNode[] | undefined {
  const parts: MarkdownNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(BARE_DOMAIN)) {
    const tld = match[1]!.toLowerCase();
    const linkable = match[2]?.startsWith("/") ? WEB_TLDS.has(tld) : PATHLESS_TLDS.has(tld);
    if (!linkable) continue;
    const url = trimTrailing(match[0]);
    if (match.index > offset) parts.push({ type: "text", value: value.slice(offset, match.index) });
    parts.push({ type: "link", url: `https://${url}`, children: [{ type: "text", value: url }] });
    offset = match.index + url.length;
  }
  if (offset === 0) return undefined;
  if (offset < value.length) parts.push({ type: "text", value: value.slice(offset) });
  return parts;
}

// Inline HTML reaches mdast as sibling `html` nodes around the text, e.g. `<code>`, text, `</code>`.
const RAW_TAG = /<(\/?)(?:a|code|pre|kbd)(?=[\s/>])[^>]*>/gi;

function rawTagDepthChange(html: string): number {
  let change = 0;
  for (const [tag, closing] of html.matchAll(RAW_TAG)) {
    if (closing) change -= 1;
    else if (!tag.endsWith("/>")) change += 1;
  }
  return change;
}

/** Links bare web addresses such as `github.com/owner/repo`, which GFM leaves as text. */
export function remarkBareDomainLinks() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === "link" || node.type === "linkReference" || !node.children) return;
      let rawDepth = 0;
      // Text only sits in phrasing parents, where links are valid siblings.
      node.children = node.children.flatMap((child) => {
        if (child.type === "html")
          rawDepth = Math.max(0, rawDepth + rawTagDepthChange(child.value ?? ""));
        else if (rawDepth > 0) return [child];
        else if (child.type === "text") return linkBareDomains(child.value ?? "") ?? [child];
        else visit(child);
        return [child];
      });
    };
    visit(tree);
  };
}
