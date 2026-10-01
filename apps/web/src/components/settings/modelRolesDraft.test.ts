import { DEFAULT_MODEL_ROLES, MAX_MODEL_ROLE_TARGETS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { editModelRolesDraft, modelRolesDraft, receiveServerModelRoles } from "./modelRolesDraft";

const [first, second] = DEFAULT_MODEL_ROLES;
const server = [first!, second!];

describe("model roles draft", () => {
  it("keeps a rename when the list is reordered before the server answers", () => {
    const renamed = editModelRolesDraft(modelRolesDraft(server), {
      type: "update",
      id: first!.id,
      patch: { name: "Planner" },
    });
    const moved = editModelRolesDraft(renamed, { type: "move", id: first!.id, offset: 1 });
    expect(moved.roles.map((role) => role.name)).toEqual([second!.name, "Planner"]);

    // The first save's echo must not roll back the second, still in flight.
    const echoed = receiveServerModelRoles(moved, renamed.roles);
    expect(echoed.roles).toEqual(moved.roles);
    const settled = receiveServerModelRoles(echoed, moved.roles);
    expect(settled).toEqual(modelRolesDraft(moved.roles));
  });

  it("adds a choice, makes it default, and removes it without losing pending edits", () => {
    const alternative = second!.targets[1]!;
    const added = editModelRolesDraft(modelRolesDraft([first!]), {
      type: "target-add",
      id: first!.id,
      target: alternative,
    });
    expect(added.roles[0]!.targets).toEqual([first!.targets[0], alternative]);
    const preferred = editModelRolesDraft(added, { type: "target-default", id: first!.id, index: 1 });
    expect(preferred.roles[0]!.targets).toEqual([alternative, first!.targets[0]]);
    expect(receiveServerModelRoles(preferred, added.roles).roles).toEqual(preferred.roles);
    const removed = editModelRolesDraft(preferred, { type: "target-remove", id: first!.id, index: 0 });
    expect(removed.roles[0]!.targets).toEqual(first!.targets);
    expect(
      editModelRolesDraft(removed, { type: "target-remove", id: first!.id, index: 0 }).roles,
    ).toEqual(removed.roles);
    expect(receiveServerModelRoles(removed, preferred.roles).roles).toEqual(removed.roles);
  });

  it("caps choices and leaves invalid indexes unchanged", () => {
    let draft = modelRolesDraft([first!]);
    for (let index = 0; index < MAX_MODEL_ROLE_TARGETS + 1; index++) {
      draft = editModelRolesDraft(draft, {
        type: "target-add",
        id: first!.id,
        target: second!.targets[0],
      });
    }
    expect(draft.roles[0]!.targets).toHaveLength(MAX_MODEL_ROLE_TARGETS);
    for (const type of ["target-default", "target-remove"] as const) {
      for (const index of [-1, MAX_MODEL_ROLE_TARGETS]) {
        expect(editModelRolesDraft(draft, { type, id: first!.id, index }).roles).toEqual(draft.roles);
      }
    }
  });

  it("updates options for only the selected choice and clears them when changing models", () => {
    const draft = modelRolesDraft([second!]);
    const options = [{ id: "thinking", value: "high" }];
    const edited = editModelRolesDraft(draft, { type: "options", id: second!.id, index: 1, options });
    expect(edited.roles[0]!.targets[0]).toEqual(second!.targets[0]);
    expect(edited.roles[0]!.targets[1]!.options).toEqual(options);
    const cleared = editModelRolesDraft(edited, {
      type: "options",
      id: second!.id,
      index: 1,
      options: undefined,
    });
    expect(cleared.roles[0]!.targets[1]).not.toHaveProperty("options");
    const updated = editModelRolesDraft(edited, {
      type: "target-update",
      id: second!.id,
      index: 1,
      target: { providerInstanceId: second!.targets[0].providerInstanceId, model: "new-model" },
    });
    expect(updated.roles[0]!.targets[1]).not.toHaveProperty("options");
    expect(updated.roles[0]!.targets[0]).toEqual(second!.targets[0]);
  });

  it("takes a list changed elsewhere", () => {
    const edited = editModelRolesDraft(modelRolesDraft(server), { type: "remove", id: first!.id });
    expect(receiveServerModelRoles(edited, [first!]).roles).toEqual([first]);
  });
});
