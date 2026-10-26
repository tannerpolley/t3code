import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ProjectArtifact,
  ProjectArtifactAddInput,
  ProjectArtifactUpdateInput,
} from "./projectArtifact.ts";

const decodeArtifact = Schema.decodeSync(ProjectArtifact);
const decodeUpdate = Schema.decodeUnknownSync(ProjectArtifactUpdateInput);
const decodeAdd = Schema.decodeUnknownSync(ProjectArtifactAddInput);

it("decodes artifacts from older servers without a description or section", () => {
  expect(
    decodeArtifact({
      id: "paper",
      path: "paper.qmd",
      resolvedPath: "/project/paper.qmd",
      name: "paper.qmd",
      label: null,
      addedBy: "agent",
      available: true,
    }),
  ).toMatchObject({ description: null, section: "Files" });
});

it("bounds artifact metadata and distinguishes omitted fields from explicit clears", () => {
  const scope = { projectId: "project", id: "paper" };
  expect(decodeUpdate(scope)).toEqual(scope);
  expect(decodeUpdate({ ...scope, label: null, description: null })).toEqual({
    ...scope,
    label: null,
    description: null,
  });
  expect(decodeUpdate({ ...scope, label: " Paper ", description: " Draft " })).toEqual({
    ...scope,
    label: "Paper",
    description: "Draft",
  });
  for (const field of ["label", "description"]) {
    expect(() => decodeUpdate({ ...scope, [field]: "x".repeat(201) })).toThrow();
    expect(() => decodeUpdate({ ...scope, [field]: " " })).toThrow();
    expect(() =>
      decodeAdd({
        projectId: "project",
        path: "paper.qmd",
        [field]: "x".repeat(201),
      }),
    ).toThrow();
  }
});
