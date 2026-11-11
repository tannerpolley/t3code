import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { randomUUID } from "~/lib/utils";
import { CrosshairIcon } from "lucide-react";
import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { DiffCommentAnnotation } from "~/components/diffs/DiffCommentAnnotation";
import { Button } from "~/components/ui/button";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";

type PdfMark = NonNullable<ReviewCommentContext["pdfMark"]>;
export type PdfCommentsTarget = { target: ComposerThreadTarget; filePath: string };

export function buildPdfReviewComment(input: {
  id: string;
  filePath: string;
  mark: PdfMark;
  quote: string;
  text: string;
}): ReviewCommentContext {
  const { mark, quote } = input;
  const percent = (value: number) => Math.round(value * 100);
  return {
    id: input.id,
    sectionId: `pdf:${input.filePath}`,
    sectionTitle: "PDF comment",
    filePath: input.filePath,
    startIndex: mark.page - 1,
    endIndex: mark.page - 1,
    rangeLabel: `p${mark.page}${quote ? "" : `, region x ${percent(mark.x)}–${percent(mark.x + mark.width)}%, y ${percent(mark.y)}–${percent(mark.y + mark.height)}%`}`,
    text: input.text.trim(),
    diff: quote,
    fenceLanguage: "text",
    pdfMark: mark,
  };
}

export function pdfCommentNeedsImage(comment: ReviewCommentContext) {
  return comment.diff.length === 0;
}

type Draft = { id: string; mark: PdfMark; quote: string; text: string; spot: boolean };
const CommentsContext = createContext<{
  config: PdfCommentsTarget;
  area: boolean;
  toggle: () => void;
  drag: PdfMark | null;
  setDrag: (mark: PdfMark | null) => void;
  draft: Draft | null;
  setDraft: (draft: Draft | null) => void;
} | null>(null);

export function PdfCommentsRoot(props: {
  config?: PdfCommentsTarget | undefined;
  children: ReactNode;
}) {
  const [area, setArea] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drag, setDrag] = useState<PdfMark | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape cancels PDF gestures even when focus is in the toolbar or comment form.
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setArea(false);
        setDrag(null);
        setDraft(null);
      }
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);
  return (
    <CommentsContext
      value={
        props.config
          ? {
              config: props.config,
              area,
              toggle: () => {
                setArea(!area);
                setDrag(null);
                setDraft(null);
              },
              drag,
              setDrag,
              draft,
              setDraft,
            }
          : null
      }
    >
      {props.children}
    </CommentsContext>
  );
}

export function PdfCommentsToolbar() {
  const context = useContext(CommentsContext);
  const comments = useComposerDraftStore((store) =>
    context ? store.getComposerDraft(context.config.target)?.reviewComments : undefined,
  );
  if (!context) return null;
  const count =
    comments?.filter((comment) => comment.sectionId === `pdf:${context.config.filePath}`).length ??
    0;
  return (
    <>
      <Button variant="ghost" size="xs" aria-pressed={context.area} onClick={context.toggle}>
        <CrosshairIcon />
        Mark area
      </Button>
      <span>{count} comments</span>
    </>
  );
}

async function cropPage(canvas: HTMLCanvasElement | null, mark: PdfMark, id: string) {
  if (!canvas || !canvas.width || !canvas.height || canvas.dataset.pdfReady !== "true")
    throw new Error("Page not drawn");
  const width = canvas.width * mark.width;
  const height = canvas.height * mark.height;
  const scale = Math.min(1, 1024 / Math.max(width, height));
  const crop = document.createElement("canvas");
  crop.width = Math.max(1, Math.round(width * scale));
  crop.height = Math.max(1, Math.round(height * scale));
  const drawing = crop.getContext("2d");
  if (!drawing) throw new Error("Canvas unavailable");
  drawing.drawImage(
    canvas,
    canvas.width * mark.x,
    canvas.height * mark.y,
    width,
    height,
    0,
    0,
    crop.width,
    crop.height,
  );
  const blob = await new Promise<Blob | null>((resolve) => crop.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Crop unavailable");
  return new File([blob], `pdf-comment-${id}.png`, { type: "image/png" });
}

async function attachCrop(
  config: PdfCommentsTarget,
  comment: ReviewCommentContext,
  canvas: HTMLCanvasElement | null,
) {
  try {
    const file = await cropPage(canvas, comment.pdfMark!, comment.id);
    if (
      !useComposerDraftStore
        .getState()
        .getComposerDraft(config.target)
        ?.reviewComments.some((entry) => entry.id === comment.id)
    )
      return;
    const previewUrl = URL.createObjectURL(file);
    const accepted = useComposerDraftStore.getState().addImage(config.target, {
      type: "image",
      id: comment.id,
      name: file.name,
      mimeType: "image/png",
      sizeBytes: file.size,
      previewUrl,
      file,
    });
    if (!accepted) {
      URL.revokeObjectURL(previewUrl);
      throw new Error("Image rejected");
    }
  } catch {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not capture the picked element",
        description: "The annotation was kept without the screenshot.",
      }),
    );
  }
}

export function PdfCommentsPage(props: { page: number; children: ReactNode }) {
  const context = useContext(CommentsContext);
  const node = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const drag = context?.drag?.page === props.page ? context.drag : null;
  const comments = useComposerDraftStore((store) =>
    context ? store.getComposerDraft(context.config.target)?.reviewComments : undefined,
  );
  const marks = (comments ?? [])
    .filter((comment) => comment.sectionId === `pdf:${context?.config.filePath}` && comment.pdfMark)
    .toSorted(
      (a, b) =>
        a.pdfMark!.page - b.pdfMark!.page ||
        a.pdfMark!.y - b.pdfMark!.y ||
        a.pdfMark!.x - b.pdfMark!.x,
    );
  const draft = context?.draft?.mark.page === props.page ? context.draft : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Native selections can end on another page; read and clamp the DOM range on pointer release.
  useEffect(() => {
    if (!context || context.area) return;
    const selected = () => {
      const page = node.current;
      const selection = window.getSelection();
      if (
        !page ||
        !selection?.rangeCount ||
        selection.isCollapsed ||
        !page.querySelector("[data-pdf-text-layer]")?.contains(selection.anchorNode)
      )
        return;
      const layer = page.querySelector("[data-pdf-text-layer]")!;
      const range = selection.getRangeAt(0).cloneRange();
      if (!layer.contains(range.startContainer)) range.setStart(layer, 0);
      if (!layer.contains(range.endContainer)) range.setEnd(layer, layer.childNodes.length);
      const quote = range.toString().trim();
      if (!quote) return;
      const bounds = page.getBoundingClientRect();
      const rect = range.getBoundingClientRect();
      const x = Math.max(0, (rect.left - bounds.left) / bounds.width);
      const y = Math.max(0, (rect.top - bounds.top) / bounds.height);
      context.setDraft({
        id: randomUUID(),
        quote,
        text: "",
        spot: false,
        mark: {
          page: props.page,
          x,
          y,
          width: Math.min(1 - x, rect.width / bounds.width),
          height: Math.min(1 - y, rect.height / bounds.height),
        },
      });
      selection.removeAllRanges();
    };
    window.addEventListener("pointerup", selected);
    return () => window.removeEventListener("pointerup", selected);
  }, [context, props.page]);
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };
  const box = (a: { x: number; y: number }, b: { x: number; y: number }): PdfMark => ({
    page: props.page,
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  });
  const position = (mark: PdfMark) => ({
    left: `${mark.x * 100}%`,
    top: `${mark.y * 100}%`,
    width: `${mark.width * 100}%`,
    height: `${mark.height * 100}%`,
  });
  const save = (text: string) => {
    if (!context || !draft) return;
    const { config } = context;
    const store = useComposerDraftStore.getState();
    const existing = store
      .getComposerDraft(config.target)
      ?.reviewComments.some((comment) => comment.id === draft.id);
    const comment = buildPdfReviewComment({
      id: draft.id,
      filePath: config.filePath,
      mark: draft.mark,
      quote: draft.quote,
      text,
    });
    store.addReviewComment(config.target, comment);
    context.setDraft(null);
    if (existing || !pdfCommentNeedsImage(comment)) return;
    void attachCrop(config, comment, node.current?.querySelector("canvas") ?? null);
  };
  return (
    <div ref={node} className="relative h-full w-full">
      {props.children}
      {context?.area && (
        <div
          aria-label={`Mark area on page ${props.page}`}
          className="absolute inset-0 cursor-crosshair touch-none"
          onPointerDown={(event) => {
            event.preventDefault();
            start.current = point(event);
            event.currentTarget.setPointerCapture(event.pointerId);
            context.setDraft(null);
          }}
          onPointerMove={(event) => {
            if (start.current) context.setDrag(box(start.current, point(event)));
          }}
          onPointerCancel={() => {
            start.current = null;
            context.setDrag(null);
          }}
          onPointerUp={(event) => {
            if (!start.current) return;
            const end = point(event);
            const rect = event.currentTarget.getBoundingClientRect();
            const spot =
              Math.hypot(
                (end.x - start.current.x) * rect.width,
                (end.y - start.current.y) * rect.height,
              ) < 8;
            const mark = spot
              ? {
                  page: props.page,
                  x: Math.max(0, Math.min(0.88, end.x - 0.06)),
                  y: Math.max(0, Math.min(0.88, end.y - 0.06)),
                  width: 0.12,
                  height: 0.12,
                }
              : box(start.current, end);
            start.current = null;
            context.setDrag(null);
            context.setDraft({ id: randomUUID(), mark, quote: "", text: "", spot });
          }}
        />
      )}
      {marks.map(
        (comment, index) =>
          comment.pdfMark!.page === props.page && (
            <button
              key={comment.id}
              type="button"
              aria-label={`PDF comment ${index + 1}: ${comment.text}`}
              className="absolute border border-primary/55 bg-primary/10 text-start text-xs text-primary"
              style={position(comment.pdfMark!)}
              onClick={() =>
                context?.setDraft({
                  id: comment.id,
                  mark: comment.pdfMark!,
                  quote: comment.diff,
                  text: comment.text,
                  spot: !comment.diff && comment.pdfMark!.width === 0.12,
                })
              }
            >
              <span className="absolute -top-2 -left-2 rounded-full bg-primary px-1 text-primary-foreground">
                {!comment.diff && comment.pdfMark!.width === 0.12 ? "📍" : ""}
                {index + 1}
              </span>
            </button>
          ),
      )}
      {(drag || draft) && (
        <div
          className="pointer-events-none absolute border border-primary bg-primary/10"
          style={position(drag ?? draft!.mark)}
        />
      )}
      {draft && (
        <div
          className="absolute z-20 w-72 max-w-full rounded-md border bg-popover shadow-md"
          style={{
            left: `${Math.min(35, draft.mark.x * 100)}%`,
            top: `${Math.min(70, (draft.mark.y + draft.mark.height) * 100)}%`,
          }}
        >
          <DiffCommentAnnotation
            key={draft.id}
            kind="draft"
            rangeLabel={`p${props.page}`}
            text={draft.text}
            onTextChange={(text) => context?.setDraft({ ...draft, text })}
            onCancel={() => context?.setDraft(null)}
            onComment={(text) => {
              void save(text);
            }}
            {...(comments?.some((comment) => comment.id === draft.id)
              ? {
                  secondaryAction: {
                    label: "Delete",
                    allowEmpty: true,
                    onAction: () => {
                      if (context)
                        useComposerDraftStore
                          .getState()
                          .removeReviewComment(context.config.target, draft.id);
                      context?.setDraft(null);
                    },
                  },
                }
              : {})}
          />
        </div>
      )}
    </div>
  );
}
