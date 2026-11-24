import type { LocalServerHideRule, ScopedThreadRef } from "@t3tools/contracts";
import { EyeOff } from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";

import type { MessageResolver } from "../../i18n/messages";
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
  const gt = useGT();
  const m = useMessages();
  const subtitle = describeServer(server, m);
  const label = discoveryLabel(server, m);
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
                aria-label={gt("Hide {host}:{port}", { host: server.host, port: server.port })}
              />
            }
          >
            <EyeOff />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => onHide({ kind: "ports", from: server.port, to: server.port })}>
              <T>
                Hide port <Var>{server.port}</Var>
              </T>
            </MenuItem>
            {processName ? (
              <MenuItem onClick={() => onHide({ kind: "process", processName })}>
                <T>
                  Hide every <Var>{processName}</Var> server
                </T>
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

function describeServer(server: PreviewableServer, resolve: MessageResolver): string {
  if (server.processName) return server.processName;
  return resolve(msg("Listening", { $context: "a local server is listening on a port" }));
}

/** Why the server is listed. Servers from before discovery labels carry no reason. */
function discoveryLabel(server: PreviewableServer, resolve: MessageResolver): string | null {
  if (server.source === "configured") return resolve(msg("Configured"));
  switch (server.reason) {
    case "t3":
      return resolve(msg("Started by T3"));
    case "systemd":
      return server.systemdUnit ?? "systemd service";
    case "project":
      return resolve(msg("Project directory"));
    case "common-port":
      return resolve(msg("Common port"));
    case undefined:
      return null;
  }
}
