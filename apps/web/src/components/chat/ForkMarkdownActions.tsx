import { msg, useGT } from "gt-react";
import { m } from "~/i18n/messages";
import { namedClipboardTarget, useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { toastManager, stackedThreadToast } from "../ui/toast";

export function toastCopyFailure(error: Error): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: m(msg("Couldn't copy")),
      description: error.message,
    }),
  );
}

export function MarkdownInlineCode(props: React.ComponentProps<"code">) {
  const gt = useGT();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget("code"),
    timeout: 1200,
    onError: toastCopyFailure,
  });
  return (
    <code
      {...props}
      tabIndex={0}
      aria-description={gt("Copy")}
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
