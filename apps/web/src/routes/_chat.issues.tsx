import { createFileRoute } from "@tanstack/react-router";

import { IssuesRoadmapPage, roadmapSearchFromUrl } from "../components/issues/IssuesRoadmapPage";

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: roadmapSearchFromUrl,
  component: IssuesRoadmapPage,
});
