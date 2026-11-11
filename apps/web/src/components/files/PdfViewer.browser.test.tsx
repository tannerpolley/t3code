import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import "~/index.css";

// Vite serves the worker module through its transform with an inline source map (6.8 MB for
// a 1.3 MB file), which dominated this test under CPU contention. A blob of the raw file is the
// same code without the dev-server cost.
vi.mock(import("pdfjs-dist/build/pdf.worker.min.mjs?url"), async () => {
  const { default: source } = await import("pdfjs-dist/build/pdf.worker.min.mjs?raw");
  return {
    default: URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
  };
});

import PdfViewer from "./PdfViewer";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore } from "~/composerDraftStore";
import { ContextChip } from "~/components/ContextChip";

const commentTarget = scopeThreadRef(
  EnvironmentId.make("pdf-comment-test"),
  ThreadId.make("pdf-comment-test"),
);
function PdfCommentFixture(props: { src: string }) {
  const comments = useComposerDraftStore(
    (store) => store.getComposerDraft(commentTarget)?.reviewComments,
  );
  return (
    <>
      <div className="flex h-[600px] w-[500px]">
        <PdfViewer
          src={props.src}
          title="Comment PDF"
          comments={{ target: commentTarget, filePath: "planning.pdf" }}
        />
      </div>
      {comments?.map((comment) => (
        <ContextChip
          key={comment.id}
          kind="review-comment"
          render={
            <button
              type="button"
              aria-label={`Remove comment: ${comment.text}`}
              onClick={() =>
                useComposerDraftStore.getState().removeReviewComment(commentTarget, comment.id)
              }
            />
          }
        >
          {comment.text}
        </ContextChip>
      ))}
    </>
  );
}

// Page 1 is a short banner whose title is drawn in two runs with a font change, so pdf.js
// splits it into two text spans. Page 2 is a letter page rotated a quarter turn.
function twoPagePdf() {
  const pages = [
    {
      box: "0 0 612 140",
      rotate: 0,
      text: "BT /F1 24 Tf 30 70 Td (Quarter) Tj /F2 24 Tf (ly outlook) Tj ET",
    },
    { box: "0 0 612 792", rotate: 90, text: "BT /F1 24 Tf 30 700 Td (Budget and risks) Tj ET" },
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>",
    ...pages.flatMap(({ box, rotate, text }, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [${box}] /Rotate ${rotate} /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents ${4 + index * 2} 0 R >>`,
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    ]),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([source], { type: "application/pdf" });
}

it("fits the width, then finds split and rotated text and jumps to its page", async () => {
  const url = URL.createObjectURL(twoPagePdf());
  try {
    const container = document.createElement("div");
    container.style.cssText = "display:flex;width:500px;height:600px";
    await using screen = await render(<PdfViewer src={url} title="Planning PDF" />, {
      container,
    });
    // The milestone is pdf.js booting its worker and parsing the document, not a frame count.
    await expect.element(screen.getByText("1 / 2 pages"), { timeout: 10_000 }).toBeVisible();
    const region = screen.container.querySelector<HTMLElement>('[role="region"]')!;
    // Fit width follows the measured viewport, which settles once the scrollbar appears.
    await vi.waitFor(() => {
      const canvas = region.querySelector('canvas[aria-label="Page 1"]')!;
      expect(canvas.getBoundingClientRect().width).toBe(region.clientWidth - 32);
      expect(region.scrollWidth).toBe(region.clientWidth);
    });

    const find = screen.getByRole("searchbox", { name: "Find in PDF" });
    await find.fill("quarterly outlook");
    await expect.element(screen.getByRole("status")).toHaveTextContent("1/1");
    await vi.waitFor(() =>
      expect(
        Array.from(region.querySelectorAll(".pdf-find-match"), (span) => span.textContent),
      ).toEqual(["Quarter", "ly outlook"]),
    );

    await find.fill("budget");
    await expect.element(screen.getByText("2 / 2 pages")).toBeVisible();
    await expect.element(screen.getByRole("status")).toHaveTextContent("1/1");
    const rotated = await vi.waitFor(() => {
      const span = Array.from(region.querySelectorAll("[data-pdf-text-layer] span")).find(
        (node) => node.textContent === "Budget and risks",
      );
      expect(span).toBeDefined();
      return span!;
    });
    // The rotated page's text runs top to bottom inside the page, so a selection lands on it.
    const textBounds = rotated.getBoundingClientRect();
    const pageBounds = rotated.closest("[data-pdf-text-layer]")!.getBoundingClientRect();
    expect(textBounds.height).toBeGreaterThan(textBounds.width);
    expect(textBounds.width).toBeGreaterThan(0);
    expect(textBounds.left).toBeGreaterThanOrEqual(pageBounds.left - 1);
    expect(textBounds.top).toBeGreaterThanOrEqual(pageBounds.top - 1);
    expect(textBounds.right).toBeLessThanOrEqual(pageBounds.right + 1);
    expect(textBounds.bottom).toBeLessThanOrEqual(pageBounds.bottom + 1);
    expect(getComputedStyle(rotated).userSelect).toBe("text");
    const range = document.createRange();
    range.selectNodeContents(rotated);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe("Budget and risks");
    selection.removeAllRanges();

    await find.fill(" ");
    await expect.element(screen.getByRole("status")).toHaveTextContent("0/0");
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("restores page, within-page offset and zoom after a remount", async () => {
  const url = URL.createObjectURL(twoPagePdf());
  const viewer = (mount: number, positionKey: string) => (
    <div className="flex h-[300px] w-[320px]">
      <PdfViewer key={mount} src={url} title="Restored PDF" positionKey={positionKey} />
    </div>
  );
  try {
    await using screen = await render(viewer(1, "restore:a"));
    await expect.element(screen.getByText("1 / 2 pages")).toBeVisible();
    await screen.getByRole("button", { name: "Zoom in", exact: true }).click();
    await screen.getByRole("button", { name: "Next page", exact: true }).click();
    await expect.element(screen.getByText("2 / 2 pages")).toBeVisible();
    const region = () => screen.getByRole("region", { name: "Restored PDF" }).element();
    const top = region().scrollTop + 40;
    const scrolled = new Promise((resolve) =>
      region().addEventListener("scroll", resolve, { once: true }),
    );
    region().scrollTop = top;
    await scrolled;
    await vi.waitFor(() => expect(region().scrollTop).toBeCloseTo(top, 0));
    const zoom = screen.container.textContent!.match(/\d+%/)![0];

    await screen.rerender(viewer(2, "restore:a"));
    await expect.element(screen.getByText("2 / 2 pages")).toBeVisible();
    await vi.waitFor(() => expect(region().scrollTop).toBeCloseTo(top, 0));
    await vi.waitFor(() => expect(screen.container.textContent).toContain(zoom));

    await screen.getByRole("button", { name: "Fit width", exact: true }).click();
    await vi.waitFor(() => {
      const canvas = region().querySelector("canvas")!;
      expect(canvas.getBoundingClientRect().width).toBe(region().clientWidth - 32);
    });
    const fitTop = region().scrollTop;
    await screen.rerender(viewer(3, "restore:a"));
    await expect.element(screen.getByText("2 / 2 pages")).toBeVisible();
    await vi.waitFor(() => {
      expect(region().querySelector("canvas")!.getBoundingClientRect().width).toBe(
        region().clientWidth - 32,
      );
      expect(region().scrollTop).toBeCloseTo(fitTop, 0);
    });

    await screen.rerender(viewer(4, "restore:b"));
    await expect.element(screen.getByText("1 / 2 pages")).toBeVisible();
    await expect.element(screen.getByText("Fit width")).toBeVisible();
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("marks selected PDF text and removes its marker when the composer chip is deleted", async () => {
  const url = URL.createObjectURL(twoPagePdf());
  try {
    await using screen = await render(<PdfCommentFixture src={url} />);
    const text = await vi.waitFor(() => {
      const span = Array.from(screen.container.querySelectorAll("[data-pdf-text-layer] span")).find(
        (element) => element.textContent === "Quarter",
      );
      expect(span).toBeDefined();
      return span!;
    });
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    text.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await screen.getByRole("textbox", { name: "Comment on lines p1" }).fill("Explain the forecast");
    await screen.getByRole("button", { name: "Comment", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "PDF comment 1: Explain the forecast" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Remove comment: Explain the forecast" }))
      .toBeVisible();
    await expect.element(screen.getByText("1 comment")).toBeVisible();
    await screen.getByRole("button", { name: "PDF comment 1: Explain the forecast" }).click();
    await expect
      .element(screen.getByRole("textbox", { name: "Comment on lines p1" }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Remove comment: Explain the forecast" }).click();
    await expect
      .element(screen.getByRole("textbox", { name: "Comment on lines p1" }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "PDF comment 1: Explain the forecast" }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByText("0 comments")).toBeVisible();
    await using subscriptions = new AsyncDisposableStack();
    const imageAdded = new Promise<void>((resolve) => {
      subscriptions.defer(
        useComposerDraftStore.subscribe((store) => {
          if (store.getComposerDraft(commentTarget)?.images.length === 1) resolve();
        }),
      );
    });
    const encode = HTMLCanvasElement.prototype.toBlob;
    let finishCrop: (() => void) | undefined;
    let rejectCrop = true;
    const cropStarted = new Promise<void>((resolve) => {
      subscriptions.defer(() => cropSpy.mockRestore());
      const cropSpy = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
        this: HTMLCanvasElement,
        callback,
        type,
        quality,
      ) {
        if (rejectCrop) {
          rejectCrop = false;
          callback(null);
          return;
        }
        finishCrop = () => encode.call(this, callback, type, quality);
        resolve();
      });
    });
    for (let zoom = 0; zoom < 5; zoom++)
      await screen.getByRole("button", { name: "Zoom in", exact: true }).click();
    await screen.getByRole("button", { name: "Mark area", exact: true }).click();
    await screen.getByLabelText("Mark area on page 1").click();
    await screen.getByRole("textbox", { name: "Comment on lines p1" }).fill("Inspect this picture");
    await vi.waitFor(() => {
      const bounds = screen.container
        .querySelector("[data-pdf-comment-form]")!
        .getBoundingClientRect();
      const viewport = screen
        .getByRole("region", { name: "Comment PDF" })
        .element()
        .getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(viewport.left);
      expect(bounds.right).toBeLessThanOrEqual(viewport.right);
      expect(bounds.top).toBeGreaterThanOrEqual(viewport.top);
      expect(bounds.bottom).toBeLessThanOrEqual(viewport.bottom);
    });
    await screen.getByRole("button", { name: "Comment", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "Comment", exact: true }))
      .toBeEnabled();
    expect(
      useComposerDraftStore.getState().getComposerDraft(commentTarget)?.reviewComments ?? [],
    ).toHaveLength(0);
    await screen.getByRole("button", { name: "Comment", exact: true }).click();
    await cropStarted;
    expect(
      useComposerDraftStore.getState().getComposerDraft(commentTarget)?.reviewComments ?? [],
    ).toHaveLength(0);
    expect(
      useComposerDraftStore.getState().getComposerDraft(commentTarget)?.images ?? [],
    ).toHaveLength(0);
    finishCrop!();
    await imageAdded;
    await expect
      .element(screen.getByRole("button", { name: "PDF comment 1: Inspect this picture" }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Remove comment: Inspect this picture" }).click();
    await expect
      .element(screen.getByRole("button", { name: "PDF comment 1: Inspect this picture" }))
      .not.toBeInTheDocument();
    expect(
      useComposerDraftStore.getState().getComposerDraft(commentTarget)?.images ?? [],
    ).toHaveLength(0);
    // Sending clears the same draft the open editor reads.
    const store = useComposerDraftStore.getState();
    const sentComment = {
      id: "sent-pdf",
      sectionId: "pdf:planning.pdf",
      sectionTitle: "PDF comment",
      filePath: "planning.pdf",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "p1",
      text: "Sent comment",
      diff: "quote",
      pdfMark: { page: 1, x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
    };
    store.addReviewComment(commentTarget, sentComment);
    await screen.getByRole("button", { name: "PDF comment 1: Sent comment" }).click();
    store.clearComposerContent(commentTarget);
    await expect
      .element(screen.getByRole("textbox", { name: "Comment on lines p1" }))
      .not.toBeInTheDocument();
  } finally {
    useComposerDraftStore.getState().clearComposerContent(commentTarget);
    URL.revokeObjectURL(url);
  }
});
