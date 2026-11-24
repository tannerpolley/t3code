import { readIssueListPreferences } from "./issueListPreferences";
import type { IssueView } from "./issuesSearch.logic";

const STORAGE_KEY = "t3.issues.view";

export function readIssuesSearch() {
  try {
    if (window.localStorage.getItem(STORAGE_KEY) === "list") {
      return { ...readIssueListPreferences(), view: "list" } as const;
    }
  } catch {
    // The view still works when browser storage is unavailable.
  }
  return { view: "board" } as const;
}

export function writeIssueView(view: IssueView): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, view);
  } catch {
    // The selected view remains in the URL.
  }
}
