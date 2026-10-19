import { ForkSidebarDisplaySettings } from "./ForkSidebarDisplaySettings";
import { ModelRolesSection } from "./ModelRolesSettings";
import { SettingsPageContainer } from "./settingsLayout";

export function CustomizationsSettings() {
  return (
    <SettingsPageContainer>
      <ForkSidebarDisplaySettings />
      <ModelRolesSection />
    </SettingsPageContainer>
  );
}
