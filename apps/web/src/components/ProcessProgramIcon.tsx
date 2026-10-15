import { shellCommandWords } from "@t3tools/shared/shellCommand";
import { TerminalIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { processIconKind } from "../process-icons";
import { cn } from "../lib/utils";
import nodedotjs from "../assets/process-icons/nodedotjs.svg?raw";
import python from "../assets/process-icons/python.svg?raw";
import typescript from "../assets/process-icons/typescript.svg?raw";
import openai from "../assets/process-icons/openai.svg?raw";
import anthropic from "../assets/process-icons/anthropic.svg?raw";
import deno from "../assets/process-icons/deno.svg?raw";
import bun from "../assets/process-icons/bun.svg?raw";
import openjdk from "../assets/process-icons/openjdk.svg?raw";
import ruby from "../assets/process-icons/ruby.svg?raw";
import perl from "../assets/process-icons/perl.svg?raw";
import docker from "../assets/process-icons/docker.svg?raw";
import nginx from "../assets/process-icons/nginx.svg?raw";
import gnubash from "../assets/process-icons/gnubash.svg?raw";
import tmux from "../assets/process-icons/tmux.svg?raw";
import git from "../assets/process-icons/git.svg?raw";
import uv from "../assets/process-icons/uv.svg?raw";
import npm from "../assets/process-icons/npm.svg?raw";
import gnu from "../assets/process-icons/gnu.svg?raw";
import llvm from "../assets/process-icons/llvm.svg?raw";
import rust from "../assets/process-icons/rust.svg?raw";
import go from "../assets/process-icons/go.svg?raw";
import tailscale from "../assets/process-icons/tailscale.svg?raw";
import gnome from "../assets/process-icons/gnome.svg?raw";
import xdotorg from "../assets/process-icons/xdotorg.svg?raw";
import googlechrome from "../assets/process-icons/googlechrome.svg?raw";
import zotero from "../assets/process-icons/zotero.svg?raw";
import steam from "../assets/process-icons/steam.svg?raw";
import android from "../assets/process-icons/android.svg?raw";

const ICONS = Object.fromEntries(
  Object.entries({
    nodedotjs,
    python,
    typescript,
    openai,
    anthropic,
    deno,
    bun,
    openjdk,
    ruby,
    perl,
    docker,
    nginx,
    gnubash,
    tmux,
    git,
    uv,
    npm,
    gnu,
    llvm,
    rust,
    go,
    tailscale,
    gnome,
    xdotorg,
    googlechrome,
    zotero,
    steam,
    android,
  }).map(([slug, svg]) => [
    slug,
    {
      url: `data:image/svg+xml,${encodeURIComponent(svg)}`,
      monochrome: svg.includes("#DEDDDA"),
    },
  ]),
);

/** Bundled brand artwork; pale variants inherit the theme's muted text color. */
export function ProcessProgramIcon(props: {
  readonly program: string;
  readonly commandLine?: string | undefined;
  readonly className: string;
  readonly fallback?: ReactNode;
}) {
  const kind = useMemo(
    () =>
      processIconKind(
        props.program,
        props.commandLine ? shellCommandWords(props.commandLine)[0]?.[0] : undefined,
      ),
    [props.program, props.commandLine],
  );
  if (kind === null) return props.fallback ?? null;
  if (kind === "terminal") return <TerminalIcon aria-hidden className={props.className} />;
  const icon = ICONS[kind]!;
  return icon.monochrome ? (
    <span
      aria-hidden
      className={cn("inline-block bg-current text-muted-foreground", props.className)}
      style={{ mask: `url("${icon.url}") center / contain no-repeat` }}
    />
  ) : (
    <img aria-hidden alt="" src={icon.url} className={props.className} />
  );
}
