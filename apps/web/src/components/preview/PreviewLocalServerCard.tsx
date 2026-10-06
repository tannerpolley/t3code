import type { LocalServerHideRule, ScopedThreadRef } from "@t3tools/contracts";
import { EyeOff } from "lucide-react";

import { Button } from "../ui/button";
import { DiscoveryListRow } from "../ui/discovery-list";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

import { PreviewFaviconIcon } from "./PreviewFaviconIcon";
import type { PreviewableServer } from "./useDiscoveredLocalServers";

interface Props {
  threadRef: ScopedThreadRef;
  server: PreviewableServer;
  onOpen: () => void;
  onHide: (rule: LocalServerHideRule) => void;
}

export function PreviewLocalServerCard({ threadRef, server, onOpen, onHide }: Props) {
  const subtitle = describeServer(server);
  const label = discoveryLabel(server);
  const processName = server.processName;
  return (
    <div className="group relative">
      <DiscoveryListRow
        onClick={onOpen}
        icon={<PreviewFaviconIcon threadRef={threadRef} url={server.requestedUrl} />}
        title={subtitle}
        description={`${server.host}:${server.port}${label ? ` · ${label}` : ""}`}
        // Keeps the row's text clear of the hide menu button laid over it.
        action={<span aria-hidden className="size-6 shrink-0" />}
      />
      <div className="absolute top-1/2 right-3 -translate-y-1/2 opacity-0 focus-within:opacity-100 group-hover:opacity-100 has-data-popup-open:opacity-100">
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                aria-label={`Hide ${server.host}:${server.port}`}
              />
            }
          >
            <EyeOff />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => onHide({ kind: "ports", from: server.port, to: server.port })}>
              Hide port {server.port}
            </MenuItem>
            {processName ? (
              <MenuItem onClick={() => onHide({ kind: "process", processName })}>
                Hide every {processName} server
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

function describeServer(server: PreviewableServer): string {
  if (server.processName) return server.processName;
  return "Listening";
}

/** Why the server is listed. Servers from before discovery labels carry no reason. */
function discoveryLabel(server: PreviewableServer): string | null {
  if (server.source === "configured") return "Configured";
  switch (server.reason) {
    case "t3":
      return "Started by T3";
    case "systemd":
      return server.systemdUnit ?? "systemd service";
    case "project":
      return "Project directory";
    case "common-port":
      return "Common port";
    case undefined:
      return null;
  }
}
