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

// ---------------------------------------------------------------------------
// In-page survey: the questions are rendered by the results screen and posted
// straight to the Google Form's formResponse endpoint, so `uh` / `variant` are
// sent without being shown to (or editable by) the learner.

const QUESTION_TYPES = new Set(["scale", "paragraph"]);

/**
 * survey_questions from the assessment JSON, e.g.
 *   { entry: "entry.1", type: "scale", title, min: 1, max: 5, min_label, max_label }
 *   { entry: "entry.2", type: "paragraph", title }
 * Invalid items are dropped.
 */
export function normalizeQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    if (!ENTRY_RE.test(q.entry) || !QUESTION_TYPES.has(q.type)) continue;
    if (typeof q.title !== "string" || !q.title.trim()) continue;
    const item = { entry: q.entry, type: q.type, title: q.title };
    if (q.type === "scale") {
      const min = Number.isInteger(q.min) ? q.min : 1;
      const max = Number.isInteger(q.max) ? q.max : 5;
      if (max <= min || max - min > 10) continue;
      Object.assign(item, {
        min,
        max,
        min_label: typeof q.min_label === "string" ? q.min_label : "",
        max_label: typeof q.max_label === "string" ? q.max_label : "",
      });
    }
    out.push(item);
  }
  return out;
}

/** ".../viewform?x" -> ".../formResponse"; "" if it isn't a Google Form URL. */
export function formResponseUrl(viewformUrl) {
  let u;
  try {
    u = new URL(viewformUrl);
  } catch {
    return "";
  }
  if (u.hostname !== "docs.google.com" || !/\/viewform$/.test(u.pathname)) return "";
  return `${u.origin}${u.pathname.replace(/\/viewform$/, "/formResponse")}`;
}

/**
 * @param {Record<string,string>} prefill - field -> entry id (hidden values)
 * @param {Record<string,any>} values - field -> value
 * @param {Record<string,string>} answers - entry id -> learner's answer
 * @returns {URLSearchParams}
 */
export function buildSurveyBody(prefill, values, answers) {
  const body = new URLSearchParams();
  for (const [entry, v] of Object.entries(answers || {})) {
    if (ENTRY_RE.test(entry) && v !== undefined && v !== null && String(v).trim() !== "") {
      body.set(entry, String(v));
    }
  }
  for (const [field, entry] of Object.entries(prefill || {})) {
    const v = values ? values[field] : undefined;
    if (v !== undefined && v !== null && v !== "") body.set(entry, String(v));
  }
  return body;
}

/**
 * POST the answers to Google Forms. `no-cors` means we can't read the reply, so
 * this resolves true once the request went out and false on a network error.
 */
export async function submitSurvey(action, body, fetchImpl = globalThis.fetch) {
  if (!action || typeof fetchImpl !== "function") return false;
  try {
    await fetchImpl(action, { method: "POST", mode: "no-cors", body });
    return true;
  } catch {
    return false;
  }
}
