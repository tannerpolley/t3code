import { createFileRoute } from "@tanstack/react-router";

import { CustomizationsSettings } from "../components/settings/CustomizationsSettings";

function SettingsCustomizationsRoute() {
  return <CustomizationsSettings />;
}

export const Route = createFileRoute("/settings/customizations")({
  component: SettingsCustomizationsRoute,
});
