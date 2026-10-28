import { describe, expect, it } from "vite-plus/test";
import { artifactLabelSuggestion } from "./artifactLabelSuggestion";

describe("artifactLabelSuggestion", () => {
  it("suggests a short label from the file name", () => {
    expect(artifactLabelSuggestion("slides/deck.pdf")).toBe("Deck");
    expect(artifactLabelSuggestion("reports/annual-report.html")).toBe("Annual");
    expect(artifactLabelSuggestion(".env")).toBe("Env");
  });
});
