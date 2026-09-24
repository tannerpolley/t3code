export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  aliases?: ReadonlyArray<string> | undefined;
  isDefault?: boolean | undefined;
  badge?: "new" | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

/**
 * The short model names customization: the provider icon names the company, so the label keeps
 * the model's own name, then its version. "Claude Opus 5.5" → "Opus 5.5", "GPT-6 Sol" and
 * "GPT-6-Sol" → "Sol 6", "Gemini 3.8 Flash (High)" → "Flash 3.8 (High)". A GPT name without a
 * one-word codename ("GPT-5.4", "GPT-5.3 Codex", "GPT-5.4 Mini") and every other shape (Grok,
 * Composer, Cursor's already-short names) stays as it is. Trailing "(…)" suffixes are kept.
 */
export function shortModelName(name: string): string {
  // Case-sensitive prefixes, so raw slugs ("claude-opus-5-5", "gpt-6-sol") are left alone.
  const claude = /^Claude\s+(?=[A-Z])/;
  if (claude.test(name)) return name.replace(claude, "");
  const gpt = /^GPT-(\d[\d.]*)[\s-]+([A-Z][A-Za-z]*)(\s*\(.*\))?$/.exec(name);
  if (gpt && !/^(codex|mini|nano|pro)$/i.test(gpt[2]!)) {
    return `${gpt[2]} ${gpt[1]}${gpt[3] ?? ""}`;
  }
  const gemini = /^Gemini\s+(\d[\d.]*)\s+([A-Z]\S*)(.*)$/.exec(name);
  if (gemini) return `${gemini[2]} ${gemini[1]}${gemini[3]}`;
  return name;
}

export function getTriggerDisplayModelName(model: ModelEsque, short = false): string {
  const name = getDisplayModelName(model, { preferShortName: true });
  return short ? shortModelName(name) : name;
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
