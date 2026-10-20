import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectArtifacts from "./ProjectArtifacts.ts";

const layer = ProjectArtifacts.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const root = yield* fs.makeTempDirectoryScoped();
  const outside = yield* fs.makeTempDirectoryScoped();
  const projectId = ProjectId.make(root);
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Artifacts', ${root}, '[]', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z')`;
  yield* fs.writeFileString(path.join(root, "paper.qmd"), "# Paper");
  yield* fs.writeFileString(path.join(outside, "slides.tex"), "Slides");
  return {
    fs,
    path,
    sql,
    root,
    outside,
    projectId,
    artifacts: yield* ProjectArtifacts.ProjectArtifacts,
  };
});

it.layer(layer)("project artifacts", (it) => {
  it.effect(
    "persists project pins, normalizes inside paths, preserves attribution on duplicates, and removes only the pin",
    () =>
      Effect.gen(function* () {
        const { artifacts, projectId, root, path, fs } = yield* setup;
        const added = yield* artifacts.add(
          { projectId, path: path.join(root, "paper.qmd"), label: "Manuscript" },
          "agent",
        );
        expect(added).toMatchObject({
          path: "paper.qmd",
          label: "Manuscript",
          addedBy: "agent",
          available: true,
        });
        const duplicate = yield* artifacts.add({ projectId, path: "./paper.qmd" }, "user");
        expect(duplicate).toEqual(added);
        expect(yield* artifacts.list(projectId)).toEqual([added]);
        const other = yield* setup;
        yield* artifacts.remove({ projectId: other.projectId, id: added.id });
        expect(yield* artifacts.list(other.projectId)).toEqual([]);
        expect(yield* artifacts.list(projectId)).toEqual([added]);
        yield* artifacts
          .remove({ projectId: ProjectId.make("missing-project"), id: added.id })
          .pipe(Effect.flip);
        expect(yield* artifacts.list(projectId)).toEqual([added]);
        yield* artifacts.remove({ projectId, id: added.id });
        expect(yield* artifacts.list(projectId)).toEqual([]);
        expect(yield* fs.exists(path.join(root, "paper.qmd"))).toBe(true);
      }),
  );
  it.effect("accepts explicit outside files and keeps user attribution", () =>
    Effect.gen(function* () {
      const { artifacts, projectId, outside, path } = yield* setup;
      const file = path.join(outside, "slides.tex");
      const added = yield* artifacts.add({ projectId, path: file }, "user");
      expect(added).toMatchObject({
        path: file,
        resolvedPath: file,
        addedBy: "user",
        available: true,
      });
    }),
  );
  it.effect(
    "rejects empty paths, directories, missing files, relative escapes, and symlink escapes",
    () =>
      Effect.gen(function* () {
        const { artifacts, projectId, root, outside, path, fs } = yield* setup;
        yield* fs.symlink(path.join(outside, "slides.tex"), path.join(root, "escape.tex"));
        for (const file of [
          "",
          "  ",
          ".",
          root,
          "missing.pdf",
          "../slides.tex",
          "escape.tex",
          "paper.qmd\0",
        ])
          expect(
            (yield* artifacts.add({ projectId, path: file }, "agent").pipe(Effect.flip))._tag,
          ).toBe("ProjectArtifactError");
        expect(yield* artifacts.list(projectId)).toEqual([]);
      }),
  );
  it.effect(
    "reports deleted or replaced files without dropping pins, and follows a moved project root",
    () =>
      Effect.gen(function* () {
        const { artifacts, projectId, root, outside, path, fs, sql } = yield* setup;
        const added = yield* artifacts.add({ projectId, path: "paper.qmd" }, "agent");
        yield* fs.remove(path.join(root, "paper.qmd"));
        expect(yield* artifacts.list(projectId)).toMatchObject([
          { id: added.id, available: false },
        ]);
        yield* fs.symlink(path.join(outside, "slides.tex"), path.join(root, "paper.qmd"));
        expect(yield* artifacts.list(projectId)).toMatchObject([
          { id: added.id, available: false },
        ]);
        yield* fs.writeFileString(path.join(outside, "paper.qmd"), "moved");
        yield* sql`UPDATE projection_projects SET workspace_root = ${outside} WHERE project_id = ${projectId}`;
        expect(yield* artifacts.list(projectId)).toMatchObject([
          {
            id: added.id,
            path: "paper.qmd",
            resolvedPath: path.join(outside, "paper.qmd"),
            available: true,
          },
        ]);
      }),
  );
  it.effect("streams the initial list and committed add/remove changes", () =>
    Effect.gen(function* () {
      const { artifacts, projectId } = yield* setup;
      const observed = yield* Stream.toPull(artifacts.subscribe(projectId));
      expect(yield* observed).toEqual([[]]);
      const added = yield* artifacts.add({ projectId, path: "paper.qmd" }, "agent");
      expect(yield* observed).toEqual([[added]]);
      yield* artifacts.remove({ projectId, id: added.id });
      expect(yield* observed).toEqual([[]]);
    }),
  );
});
