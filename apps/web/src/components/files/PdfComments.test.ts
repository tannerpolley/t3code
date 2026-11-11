import { expect, it } from "vite-plus/test";
import { buildPdfReviewComment, pdfCommentNeedsImage } from "./PdfComments";

it("builds page and quote context, deriving region labels and image decisions from the mark", () => {
  for (const { quote, mark, label, image } of [
    {
      quote: "Selected passage",
      mark: { page: 3, x: 0.12, y: 0.4, width: 0.48, height: 0.15 },
      label: "p3",
      image: false,
    },
    {
      quote: "",
      mark: { page: 3, x: 0.12, y: 0.4, width: 0.48, height: 0.15 },
      label: "p3, region x 12–60%, y 40–55%",
      image: true,
    },
    {
      quote: "",
      mark: { page: 4, x: 0.2, y: 0.3, width: 0.12, height: 0.12 },
      label: "p4, region x 20–32%, y 30–42%",
      image: true,
    },
  ]) {
    const comment = buildPdfReviewComment({
      id: "mark",
      filePath: "papers/example.pdf",
      mark,
      quote,
      text: " Explain this ",
    });
    expect(comment).toEqual({
      id: "mark",
      sectionId: "pdf:papers/example.pdf",
      sectionTitle: "PDF comment",
      filePath: "papers/example.pdf",
      startIndex: mark.page - 1,
      endIndex: mark.page - 1,
      rangeLabel: label,
      text: "Explain this",
      diff: quote,
      fenceLanguage: "text",
      pdfMark: mark,
    });
    expect(pdfCommentNeedsImage(comment)).toBe(image);
  }
});
