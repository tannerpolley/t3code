import { lazy, Suspense } from "react";
import { ForkSidebarDisplaySettings } from "./ForkSidebarDisplaySettings";
import { ModelRolesSection } from "./ModelRolesSettings";
import { SettingsPageContainer } from "./settingsLayout";

const DebugSettings = import.meta.env.DEV ? lazy(() => import("./ForkSidebarDebugSettings")) : null;

export function CustomizationsSettings() {
  return (
    <SettingsPageContainer>
      <ForkSidebarDisplaySettings />
      <ModelRolesSection />
      {DebugSettings ? (
        <Suspense>
          <DebugSettings />
        </Suspense>
      ) : null}
    </SettingsPageContainer>
  );
}
