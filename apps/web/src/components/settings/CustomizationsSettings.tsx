import { T } from "gt-react";
import { ForkSettingsSlot } from "./ForkSettings";
import { FORK_SETTINGS_PAGES } from "./ForkSettingsPages";
import { ForkSettingsMirror } from "./ForkSettingsRow";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

export function CustomizationsSettings() {
  return (
    <SettingsPageContainer>
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        <T>Every fork setting, grouped by its normal Settings tab. Changes apply in both places.</T>
      </p>
      <ForkSettingsMirror>
        {FORK_SETTINGS_PAGES.map((page) => (
          <SettingsSection key={page} title={SETTINGS_SECTION_LABELS[page]} variant="plain">
            <div className="flex flex-col gap-5">
              <ForkSettingsSlot page={page} />
            </div>
          </SettingsSection>
        ))}
      </ForkSettingsMirror>
    </SettingsPageContainer>
  );
}
