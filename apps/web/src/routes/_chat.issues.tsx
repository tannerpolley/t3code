import { createFileRoute, redirect, type SearchSchemaInput } from "@tanstack/react-router";

import { IssuesWorkspace } from "../components/issue/IssuesWorkspace";
import { issuesPageSearchFromUrl } from "../components/issue/issuesSearch.logic";
import { readIssuesSearch } from "../components/issue/issueViewPreferences";

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: (raw: Partial<ReturnType<typeof issuesPageSearchFromUrl>> & SearchSchemaInput) =>
    issuesPageSearchFromUrl(raw),
  beforeLoad: ({ search, location }) => {
    if (search.view === undefined) {
      throw redirect({
        to: "/issues",
        search: readIssuesSearch(),
        hash: location.hash,
        replace: true,
      });
    }
  },
  component: IssuesWorkspace,
});
