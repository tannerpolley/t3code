import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ResetCreditAutoUseResult = Schema.Struct({
  creditId: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  attemptedAt: IsoDateTime,
  status: Schema.Literals(["used", "failed"]),
});
export type ResetCreditAutoUseResult = typeof ResetCreditAutoUseResult.Type;
