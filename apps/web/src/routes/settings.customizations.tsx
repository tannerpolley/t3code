import { createFileRoute } from "@tanstack/react-router";
import { CustomizationsSettings } from "../components/settings/CustomizationsSettings";

export const Route = createFileRoute("/settings/customizations")({
  component: CustomizationsSettings,
});
