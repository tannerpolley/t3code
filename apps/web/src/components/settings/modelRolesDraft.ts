import type { ModelRole } from "@t3tools/contracts";
import * as Equal from "effect/Equal";

export type ModelRoleEdit =
  | { readonly type: "update"; readonly id: string; readonly patch: Partial<Omit<ModelRole, "id">> }
  | {
      readonly type: "options";
      readonly id: string;
      readonly options: ModelRole["target"]["options"];
    }
  | { readonly type: "move"; readonly id: string; readonly offset: -1 | 1 }
  | { readonly type: "add"; readonly role: ModelRole }
  | { readonly type: "remove"; readonly id: string }
  | { readonly type: "replace"; readonly roles: ReadonlyArray<ModelRole> };

function applyModelRoleEdit(
  roles: ReadonlyArray<ModelRole>,
  edit: ModelRoleEdit,
): ReadonlyArray<ModelRole> {
  switch (edit.type) {
    case "update":
      return roles.map((role) => (role.id === edit.id ? { ...role, ...edit.patch } : role));
    case "options":
      return roles.map((role) => {
        if (role.id !== edit.id) return role;
        const { options: _previous, ...target } = role.target;
        return {
          ...role,
          target: edit.options === undefined ? target : { ...target, options: edit.options },
        };
      });
    case "move": {
      const from = roles.findIndex((role) => role.id === edit.id);
      const to = from + edit.offset;
      if (from < 0 || to < 0 || to >= roles.length) return roles;
      const next = [...roles];
      next.splice(to, 0, ...next.splice(from, 1));
      return next;
    }
    case "add":
      return [...roles, edit.role];
    case "remove":
      return roles.filter((role) => role.id !== edit.id);
    case "replace":
      return edit.roles;
  }
}

/**
 * The list the editor shows. Edits apply here synchronously, so a second
 * action made before the server answers the first builds on it instead of
 * on the last server value. `server` is the last list the server sent;
 * `pending` holds saves not yet echoed back, oldest first.
 */
export interface ModelRolesDraft {
  readonly roles: ReadonlyArray<ModelRole>;
  readonly server: ReadonlyArray<ModelRole>;
  readonly pending: ReadonlyArray<ReadonlyArray<ModelRole>>;
}

export const modelRolesDraft = (server: ReadonlyArray<ModelRole>): ModelRolesDraft => ({
  roles: server,
  server,
  pending: [],
});

/** Applies an edit; the caller saves the returned `roles`. */
export function editModelRolesDraft(draft: ModelRolesDraft, edit: ModelRoleEdit): ModelRolesDraft {
  const roles = applyModelRoleEdit(draft.roles, edit);
  return roles === draft.roles ? draft : { ...draft, roles, pending: [...draft.pending, roles] };
}

/**
 * Takes a list from the server. An unchanged list or the echo of an older
 * save keeps the local edits; any other list came from elsewhere and wins.
 */
export function receiveServerModelRoles(
  draft: ModelRolesDraft,
  server: ReadonlyArray<ModelRole>,
): ModelRolesDraft {
  if (Equal.equals(server, draft.server)) return draft;
  const echoed = draft.pending.findIndex((sent) => Equal.equals(sent, server));
  if (echoed < 0) return modelRolesDraft(server);
  const pending = draft.pending.slice(echoed + 1);
  return { roles: pending.length === 0 ? server : draft.roles, server, pending };
}
