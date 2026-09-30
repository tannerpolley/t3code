import { DEFAULT_MODEL_ROLES } from "@t3tools/contracts";
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

  it("takes a list changed elsewhere", () => {
    const edited = editModelRolesDraft(modelRolesDraft(server), { type: "remove", id: first!.id });
    expect(receiveServerModelRoles(edited, [first!]).roles).toEqual([first]);
  });
});
