import { createFileRoute, redirect } from "@tanstack/react-router";

import { roadmapSearchFromUrl } from "../components/issue/issuesSearch.logic";

export const Route = createFileRoute("/_chat/roadmap")({
  validateSearch: roadmapSearchFromUrl,
  beforeLoad: ({ search, location }) => {
    throw redirect({
      to: "/issues",
      search: { ...search, view: "board" },
      hash: location.hash,
      replace: true,
    });
  },
});
