import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import { canonicalWorkspacePath } from "./workspacePath.ts";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(HostProcess.isWindows, (isWindows) => {
    const key = canonicalWorkspacePath(cwd, isWindows);
    const lease = leases.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    leases.set(key, lease);
    lease.users++;
    return lease.semaphore.withPermit(effect).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          lease.users--;
          if (lease.users === 0) leases.delete(key);
        }),
      ),
    );
  });
