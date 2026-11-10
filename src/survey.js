// Google Form survey URL building (pure, testable).
//
// `prefill` maps our field names to the form's question ids, e.g.
// { uh: "entry.123", variant: "entry.456" } (from the form's "Get pre-filled
// link"). Values that are empty are skipped, so the form still works without them.

export const PREFILL_FIELDS = Object.freeze(["uh", "variant", "score", "percentage"]);
const ENTRY_RE = /^entry\.\d+$/;

/** @returns {Record<string,string>} only known fields with valid entry ids */
export function normalizePrefill(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const f of PREFILL_FIELDS) {
    if (typeof raw[f] === "string" && ENTRY_RE.test(raw[f])) out[f] = raw[f];
  }
  return out;
}

/**
 * @param {string} baseUrl - the form's viewform URL
 * @param {Record<string,string>} prefill - field -> entry id
 * @param {Record<string,any>} values - field -> value
 * @param {{embedded?: boolean}} [opts]
 * @returns {string} "" if baseUrl is invalid
 */
export function buildSurveyUrl(baseUrl, prefill, values, { embedded = false } = {}) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    return "";
  }
  let filled = false;
  for (const [field, entry] of Object.entries(prefill || {})) {
    const v = values ? values[field] : undefined;
    if (v === undefined || v === null || v === "") continue;
    u.searchParams.set(entry, String(v));
    filled = true;
  }
  if (filled) u.searchParams.set("usp", "pp_url"); // Google Forms requires this for prefill
  if (embedded) u.searchParams.set("embedded", "true");
  return u.href;
}
