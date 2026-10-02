"use strict";

// The publish gate, in one place. Every adapter checks it again on its own, so
// calling an adapter directly cannot skip it.

const CONFIRM_WORD = "PUBLISH";

// Fails closed: any value that is present and is not one of false, "false",
// 0 or "" asks for a dry run. So 1, "1", "yes", "True" and "true" are all dry
// runs, and a dry run always wins over a confirmation.
function isDryRun(value) {
  if (value === undefined || value === null) return false;
  return !(value === false || value === "false" || value === 0 || value === "");
}

// Strict: the raw value must be the exact string. No trimming, no coercion.
function isConfirmed(value) {
  return value === CONFIRM_WORD;
}

// gateOpen(ctx) is true only for a confirmed, non-dry-run publish.
function gateOpen(ctx) {
  return Boolean(ctx) && isConfirmed(ctx.confirm) && !isDryRun(ctx.dryRun);
}

function closedResult(label) {
  return { status: "refused", detail: `Nothing was sent. ${label} publishing needs confirm: "${CONFIRM_WORD}" and no dry run.`, url: null };
}

module.exports = { CONFIRM_WORD, isDryRun, isConfirmed, gateOpen, closedResult };
