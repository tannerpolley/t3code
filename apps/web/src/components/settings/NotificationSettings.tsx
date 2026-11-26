import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useGT, useMessages } from "gt-react";
import { useState } from "react";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function NotificationSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <SettingsRow
      {...searchableSetting("thread-notifications")}
      description={
        permissionMessage ??
        gt(
          "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while T3 Code is open.",
        )
      }
      control={
        <Select
          value={mode}
          disabled={requesting}
          onValueChange={async (value) => {
            if (
              value !== "off" &&
              value !== "notifications" &&
              value !== "sound" &&
              value !== "notifications-and-sound"
            )
              return;
            setPermissionMessage(null);
            if (hasNotificationSound(value)) unlockNotificationAudio();
            if (hasDesktopNotifications(value)) {
              if (typeof Notification === "undefined" || !window.isSecureContext) {
                setPermissionMessage(
                  gt(
                    "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
                  ),
                );
                return;
              }
              setRequesting(true);
              const permission = await settlePromise(() => Notification.requestPermission());
              setRequesting(false);
              if (permission._tag === "Failure") {
                setPermissionMessage(
                  gt(
                    "Notifications are unavailable in this browser. Sound only is still available.",
                  ),
                );
                return;
              }
              if (permission.value !== "granted") {
                setPermissionMessage(
                  gt(
                    "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
                  ),
                );
                return;
              }
            }
            updateSettings({ notificationMode: value });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-56"
            aria-label={gt("Thread notifications")}
          >
            <SelectValue>{m(NOTIFICATION_MODE_LABELS[mode])}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
              <SelectItem key={value} hideIndicator value={value}>
                {m(label)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function NotificationPresenceSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const { targets } = useSettingsScope();
  const peer = useScopedSettings((settings) => settings.notificationPresencePeer);
  const mixed = useScopedSettingsMixed(["notificationPresencePeer"]);
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["notificationPresencePeer"]}
      {...searchableSetting("notification-presence-peer")}
      description={gt(
        "Enter your phone’s Tailscale name. Thread alerts go to the desktop when the phone is on the host’s local network and to the phone when away. Leave blank to turn this off.",
      )}
      control={
        <Input
          key={JSON.stringify([targets.map((target) => target.environmentId), mixed, peer])}
          size="sm"
          className="w-full sm:w-56"
          aria-label={gt("Phone for notification routing")}
          defaultValue={mixed ? "" : peer}
          placeholder={mixed ? gt("Mixed values") : undefined}
          onBlur={(event) => {
            const value = event.currentTarget.value.trim();
            if (value !== (mixed ? "" : peer)) updateSettings({ notificationPresencePeer: value });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur();
          }}
        />
      }
    />
  );
}

export function NtfyNotificationSettings() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const { targets } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedServer = useScopedSettingsMixed(["notificationNtfyServerUrl"]);
  const mixedTopic = useScopedSettingsMixed(["notificationNtfyTopic"]);
  const rows = [
    {
      id: "notification-ntfy-server",
      key: "notificationNtfyServerUrl",
      label: gt("ntfy server URL"),
      description: gt("The server that sends phone alerts. The default is https://ntfy.sh."),
      mixed: mixedServer,
    },
    {
      id: "notification-ntfy-topic",
      key: "notificationNtfyTopic",
      label: gt("ntfy topic"),
      description: gt(
        "Subscribe to this topic in the ntfy app on your phone. Keep the topic private. Leave it blank to turn off ntfy alerts.",
      ),
      mixed: mixedTopic,
    },
  ] as const;
  return rows.map(({ id, key, label, description, mixed }) => {
    const value = mixed ? "" : settings[key];
    return (
      <SettingsRow
        key={id}
        serverScoped
        settingKeys={[key]}
        {...setting(id)}
        description={description}
        control={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              key={JSON.stringify([targets.map((target) => target.environmentId), mixed, value])}
              size="sm"
              className="w-full sm:w-56"
              aria-label={label}
              defaultValue={value}
              placeholder={mixed ? gt("Mixed values") : undefined}
              onBlur={(event) => {
                const next = event.currentTarget.value.trim();
                if (next !== value) updateSettings({ [key]: next });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing)
                  event.currentTarget.blur();
              }}
            />
            {key === "notificationNtfyTopic" && !mixed && !value ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const random = crypto.getRandomValues(new Uint8Array(24));
                  const token = Array.from(random, (byte) =>
                    byte.toString(16).padStart(2, "0"),
                  ).join("");
                  updateSettings({ notificationNtfyTopic: `t3-${token}` });
                }}
              >
                {gt("Generate topic")}
              </Button>
            ) : null}
          </div>
        }
      />
    );
  });
}
