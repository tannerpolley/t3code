/**
 * A complete inline `$…$` span: no space just inside either dollar, no escaped closing
 * dollar, and no digit right after it. "$2/x$" qualifies; "$5 and $10" does not.
 */
export const DOLLAR_MATH_SPAN = /\$[^\s$](?:[^$\n]*[^\s$\\])?\$(?!\d)/u;
