import { MAX_MODEL_ROLE_TARGETS, type ModelRole, type ModelRoleTarget } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Equal from "effect/Equal";

export type ModelRoleEdit =
  | { readonly type: "update"; readonly id: string; readonly patch: Partial<Omit<ModelRole, "id">> }
  | {
      readonly type: "options";
      readonly id: string;
      readonly index: number;
      readonly options: ModelRoleTarget["options"];
    }
  | {
      readonly type: "target-update";
      readonly id: string;
      readonly index: number;
      readonly target: ModelRoleTarget;
    }
  | { readonly type: "target-add"; readonly id: string; readonly target: ModelRoleTarget }
  | {
      readonly type: "target-remove" | "target-default";
      readonly id: string;
      readonly index: number;
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
        return {
          ...role,
          targets: Arr.map(role.targets, (target, index) => {
            if (index !== edit.index) return target;
            const { options: _previous, ...base } = target;
            return edit.options === undefined ? base : { ...base, options: edit.options };
          }),
        };
      });
    case "target-update":
      return roles.map((role) =>
        role.id === edit.id
          ? {
              ...role,
              targets: Arr.map(role.targets, (target, index) =>
                index === edit.index ? edit.target : target,
              ),
            }
          : role,
      );
    case "target-add":
      return roles.map<ModelRole>((role) =>
        role.id === edit.id && role.targets.length < MAX_MODEL_ROLE_TARGETS
          ? { ...role, targets: [...role.targets, edit.target] }
          : role,
      );
    case "target-remove":
    case "target-default":
      return roles.map<ModelRole>((role) => {
        if (role.id !== edit.id || edit.index < 0 || edit.index >= role.targets.length) return role;
        if (edit.type === "target-remove" && role.targets.length === 1) return role;
        const targets = [...role.targets];
        const [chosen] = targets.splice(edit.index, 1);
        if (edit.type === "target-default") targets.unshift(chosen!);
        return { ...role, targets: [targets[0]!, ...targets.slice(1)] };
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
