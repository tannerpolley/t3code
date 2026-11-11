import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildPdfReviewComment } from "../files/PdfComments";
import type { RetainedContextPayloads } from "./composerContextUndo";
import type { ComposerImageAttachment } from "../../composerDraftStore";
import {
  buildMessageContext,
  previewAnnotationContextId,
  reviewCommentContextId,
} from "../../lib/composerContextRecords";
import {
  reconcileAttachmentContextReferences,
  reconcileReviewCommentReferences,
  type RetainedAttachmentContextPayloads,
} from "./composerContextUndo";

const binary = new File(["binary"], "context.png", { type: "image/png" });
const image = {
  type: "image",
  id: "annotation-1",
  name: "annotation.png",
  mimeType: "image/png",
  sizeBytes: binary.size,
  previewUrl: "blob:annotation",
  file: binary,
} satisfies ComposerImageAttachment;
const annotation = {
  id: "annotation-1",
  pageUrl: "https://example.com",
  pageTitle: "Example",
  comment: "Fix this",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: {
    dataUrl: "data:image/png;base64,YmluYXJ5",
    width: 1,
    height: 1,
    cropRect: { x: 0, y: 0, width: 1, height: 1 },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies PreviewAnnotationPayload;

function retention(): RetainedAttachmentContextPayloads {
  return { files: new Map(), previewAnnotations: new Map() };
}

describe("reconcileAttachmentContextReferences", () => {
  it("restores an annotation and its screenshot attachment after undo", () => {
    const retained = retention();
    const removed = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(),
      files: [],
      images: [image],
      previewAnnotations: [annotation],
      retained,
    });
    expect(removed.annotationIdsToRemove).toEqual(["annotation-1"]);

    const restored = reconcileAttachmentContextReferences({
      referencedContextIds: new Set([previewAnnotationContextId(annotation.id)]),
      files: [],
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(restored.annotationsToRestore).toEqual([{ annotation, image }]);
    expect(restored.annotationsToRestore[0]?.annotation.screenshot?.dataUrl).toBe(
      "data:image/png;base64,YmluYXJ5",
    );
    expect(restored.annotationsToRestore[0]?.image?.file).toBe(binary);
    expect(
      buildMessageContext({
        terminalContexts: [],
        reviewComments: [],
        previewAnnotations: restored.annotationsToRestore.map((entry) => entry.annotation),
        attachments: [
          {
            attachment: restored.annotationsToRestore[0]!.image!,
            attachmentId: "uploaded-screenshot",
          },
        ],
      })?.records,
    ).toEqual([
      expect.objectContaining({
        kind: "preview-annotation",
        screenshotContextId: "image_annotation-1",
      }),
      expect.objectContaining({
        kind: "image",
        contextId: "image_annotation-1",
        attachmentId: "uploaded-screenshot",
      }),
    ]);
  });
});

it("restores a PDF comment and its crop after undo", () => {
  const comment = buildPdfReviewComment({
    id: image.id,
    filePath: "deck.pdf",
    mark: { page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    quote: "",
    text: "Explain the chart",
  });
  const retainedReviews: RetainedContextPayloads["reviewComments"] = new Map();
  expect(
    reconcileReviewCommentReferences({
      referencedContextIds: new Set(),
      comments: [comment],
      images: [image],
      retained: retainedReviews,
    }).idsToRemove,
  ).toEqual([comment.id]);
  const restoredReview = reconcileReviewCommentReferences({
    referencedContextIds: new Set([reviewCommentContextId(comment.id)]),
    comments: [],
    images: [],
    retained: retainedReviews,
  });
  expect(restoredReview.toRestore).toEqual([{ comment, image }]);
  expect(
    buildMessageContext({
      terminalContexts: [],
      reviewComments: restoredReview.toRestore.map((entry) => entry.comment),
      previewAnnotations: [],
      attachments: [
        { attachment: restoredReview.toRestore[0]!.image!, attachmentId: "uploaded-crop" },
      ],
    })?.records,
  ).toEqual([
    expect.objectContaining({
      kind: "review-comment",
      text: "Explain the chart",
      rangeLabel: "p1, region x 10–40%, y 20–60%",
    }),
    expect.objectContaining({ kind: "image", attachmentId: "uploaded-crop" }),
  ]);
});
