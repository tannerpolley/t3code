// @effect-diagnostics nodeBuiltinImport:off - Tests use Node's glob matcher to verify electron-builder exclusions.

import * as NodeServices from "@effect/platform-node/NodeServices";

import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";

import * as Effect from "effect/Effect";

import {
  createBuildConfig,
  DESKTOP_ELECTRON_LANGUAGES,
  DESKTOP_FILE_EXCLUSIONS,
  DESKTOP_EXTRA_RESOURCES,
  LINUX_CAPTURE_EXTRA_RESOURCES,
  LINUX_FILE_EXCLUSIONS,
  MAC_FILE_EXCLUSIONS,
  WINDOWS_NATIVE_ASAR_UNPACK_GLOB,
  WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
  WINDOWS_SERVER_EXTRA_RESOURCES,
  WSL_RUNTIME_EXTRA_RESOURCES,
} from "./build-desktop-artifact.ts";

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it.effect("applies platform-specific packaging to the build config", () =>
    Effect.gen(function* () {
      const mac = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );
      const linux = yield* createBuildConfig(
        "linux",
        "AppImage",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );
      const win = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        true,
      );
      const winWithoutWslRuntime = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        false,
      );

      assert.notProperty(mac, "asar");
      assert.notProperty(linux, "asar");
      assert.notProperty(mac, "asarUnpack");
      assert.notProperty(linux, "asarUnpack");
      assert.deepStrictEqual(win.asar, { smartUnpack: false });
      assert.deepStrictEqual(win.asarUnpack, [WINDOWS_NATIVE_ASAR_UNPACK_GLOB]);
      assert.deepStrictEqual(winWithoutWslRuntime.asar, win.asar);
      assert.deepStrictEqual(winWithoutWslRuntime.asarUnpack, win.asarUnpack);
      assert.deepStrictEqual(mac.extraResources, DESKTOP_EXTRA_RESOURCES);
      assert.deepStrictEqual(linux.extraResources, [
        ...DESKTOP_EXTRA_RESOURCES,
        ...LINUX_CAPTURE_EXTRA_RESOURCES,
        { from: "apps/desktop/prod-resources/browser-secret", to: "browser-secret" },
      ]);
      assert.deepStrictEqual(win.extraResources, [
        ...DESKTOP_EXTRA_RESOURCES,
        ...WINDOWS_SERVER_EXTRA_RESOURCES,
        ...WSL_RUNTIME_EXTRA_RESOURCES,
      ]);
      assert.deepStrictEqual(winWithoutWslRuntime.extraResources, [
        ...DESKTOP_EXTRA_RESOURCES,
        ...WINDOWS_SERVER_EXTRA_RESOURCES,
      ]);
      assert.deepStrictEqual(win.nsis, {
        differentialPackage: true,
        include: "apps/desktop/resources/installer.nsh",
      });
      assert.deepStrictEqual(WINDOWS_SERVER_ASAR_IGNORE_GLOBS, [
        "**/node_modules/@cursor/sdk-*",
        "**/node_modules/@cursor/sdk-*/**",
        "**/node_modules/@anthropic-ai/claude-agent-sdk-*",
        "**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
        "**/node_modules/.bin",
        "**/node_modules/.bin/**",
        "**/*.map",
      ]);
      assert.deepStrictEqual(mac.dmg, {
        title: "T3 Code (Beta) 1.2.3 Installer",
        background: "dmg/dmg-background-latest.png",
        window: { width: 640, height: 432 },
        contents: [
          { x: 166, y: 214, type: "file" },
          { x: 474, y: 214, type: "link", path: "/Applications" },
        ],
        iconSize: 120,
        iconTextSize: 12,
      });
      assert.deepStrictEqual((linux.linux as Record<string, unknown>).target, ["AppImage"]);
      const deb = yield* createBuildConfig(
        "linux",
        "deb",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );
      assert.deepStrictEqual((deb.linux as Record<string, unknown>).target, ["deb"]);

      assert.deepStrictEqual((linux.linux as Record<string, unknown>).protocols, [
        { name: "T3 Code", schemes: ["t3code", "t3code-dev"] },
      ]);
      assert.deepStrictEqual((mac.mac as Record<string, unknown>).protocols, [
        { name: "T3 Code", schemes: ["t3code", "t3code-dev"] },
        { name: "Web site URL", schemes: ["http", "https"], role: "Viewer" },
      ]);
      const macInfo = (mac.mac as { extendInfo: Record<string, unknown> }).extendInfo;
      assert.strictEqual(macInfo.NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac, true);
      assert.deepStrictEqual(macInfo.CFBundleDocumentTypes, [
        {
          CFBundleTypeName: "Web page",
          CFBundleTypeRole: "Viewer",
          LSHandlerRank: "Alternate",
          LSItemContentTypes: ["public.html", "public.xhtml"],
        },
      ]);
      assert.deepStrictEqual(linux.toolsets, { appimage: "1.0.3" });
      assert.notProperty(mac, "toolsets");
      assert.notProperty(win, "toolsets");
      assert.deepStrictEqual(mac.files, [...DESKTOP_FILE_EXCLUSIONS, ...MAC_FILE_EXCLUSIONS]);
      assert.deepStrictEqual(linux.files, [...DESKTOP_FILE_EXCLUSIONS, ...LINUX_FILE_EXCLUSIONS]);
      assert.deepStrictEqual(win.files, DESKTOP_FILE_EXCLUSIONS);
      assert.deepStrictEqual(winWithoutWslRuntime.files, win.files);
      assert.notProperty(mac.mac as Record<string, unknown>, "sign");
      assert.propertyVal(
        (mac.mac as Record<string, unknown>).extendInfo as Record<string, unknown>,
        "NSLocalNetworkUsageDescription",
        "T3 Code connects to devices on your local network for remote environments and commands run by terminals and coding agents.",
      );
      for (const config of [linux, win]) {
        assert.deepStrictEqual(config.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
      }
      assert.deepStrictEqual(mac.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );
});
