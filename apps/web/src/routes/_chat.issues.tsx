import { createFileRoute, type SearchSchemaInput } from "@tanstack/react-router";

import { IssuesWorkspace } from "../components/issue/IssuesWorkspace";
import { issuesPageSearchFromUrl } from "../components/issue/issuesSearch.logic";

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: (raw: Partial<ReturnType<typeof issuesPageSearchFromUrl>> & SearchSchemaInput) =>
    issuesPageSearchFromUrl(raw),
  component: IssuesWorkspace,
});
