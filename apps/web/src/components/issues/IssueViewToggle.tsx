import * as Schema from "effect/Schema";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { ToggleGroup, Toggle } from "~/components/ui/toggle-group";
import { repositoryKey } from "./issueWorkspace.logic";

const IssueViews = Schema.Record(Schema.String, Schema.Literals(["milestones", "roadmap"]));
export function useIssueViews() {
  return useLocalStorage("t3code:issue-views", {}, IssueViews);
}
export function useIssueView(host: string, repository: string) {
  const [views, setViews] = useIssueViews();
  const key = repositoryKey(host, repository);
  return [
    views[key] ?? "milestones",
    (value: "milestones" | "roadmap") => setViews((current) => ({ ...current, [key]: value })),
  ] as const;
}
export function IssueViewToggle({
  value,
  onChange,
}: {
  value: "milestones" | "roadmap";
  onChange: (value: "milestones" | "roadmap") => void;
}) {
  return (
    <ToggleGroup
      aria-label="Issue view"
      size="compact"
      value={[value]}
      onValueChange={(values) => {
        const chosen = values[0];
        if (chosen === "milestones" || chosen === "roadmap") onChange(chosen);
      }}
    >
      <Toggle value="milestones">Milestones</Toggle>
      <Toggle value="roadmap">Roadmap</Toggle>
    </ToggleGroup>
  );
}
