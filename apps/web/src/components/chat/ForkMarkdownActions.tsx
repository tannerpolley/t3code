import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { toastManager, stackedThreadToast } from "../ui/toast";

export function toastCopyFailure(error: Error): void {
  toastManager.add(
    stackedThreadToast({ type: "error", title: "Couldn't copy", description: error.message }),
  );
}

export function MarkdownInlineCode(props: React.ComponentProps<"code">) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "code",
    timeout: 1200,
    onError: toastCopyFailure,
  });
  return (
    <code
      {...props}
      onDoubleClick={(event) => window.getSelection()?.selectAllChildren(event.currentTarget)}
      tabIndex={0}
      aria-description="Copy"
      data-copyable=""
      data-copied={isCopied ? "" : undefined}
      onClick={(event) => {
        if (window.getSelection()?.toString()) return;
        copyToClipboard(event.currentTarget.textContent ?? "");
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        copyToClipboard(event.currentTarget.textContent ?? "");
      }}
    />
  );
}
