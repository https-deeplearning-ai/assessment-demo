// Experiment telemetry: who is taking the assessment, and what they answered.
//
// The platform links here with ?uh=<userHash>. We keep that id, and send two
// events to the results endpoint (a Google Apps Script Web app that appends a
// row to a Google Sheet):
//   - "started"   when a fresh attempt begins (Start / Start over)
//   - "submitted" on submit, with totals + every question's answer and outcome
// Sending is fire-and-forget: a failure never blocks or breaks the assessment.

import { getItem, setItem, getJSON, setJSON } from "./util/storage.js";

const UH_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UH_KEY = "assessment:uh";
const attemptKey = (sessionKey) => `assessment:attempt:${sessionKey}`;

/** @returns {string} the valid ?uh= value in `href`, else "" */
export function learnerIdFromUrl(href) {
  try {
    const uh = new URL(href).searchParams.get("uh");
    return uh && UH_RE.test(uh) ? uh : "";
  } catch {
    return "";
  }
}

/**
 * Learner id for this visit: the URL's ?uh= (remembered for later visits), else
 * the remembered one, else "".
 */
export function resolveLearnerId(href) {
  const fromUrl = learnerIdFromUrl(href);
  if (fromUrl) {
    setItem(UH_KEY, fromUrl);
    return fromUrl;
  }
  const stored = getItem(UH_KEY);
  return stored && UH_RE.test(stored) ? stored : "";
}

/** Mint (and remember) a new attempt for this assessment session. */
export function startAttempt(sessionKey, now = Date.now(), rand = Math.random) {
  const attempt = {
    session_id: `${now.toString(36)}-${Math.floor(rand() * 2 ** 32).toString(36)}`,
    started_at: new Date(now).toISOString(),
  };
  setJSON(attemptKey(sessionKey), attempt);
  return attempt;
}

/** @returns {{session_id, started_at}|null} the remembered attempt, if any */
export function currentAttempt(sessionKey) {
  const a = getJSON(attemptKey(sessionKey));
  return a && typeof a.session_id === "string" ? a : null;
}

function base(app, event, attempt) {
  return {
    event,
    uh: app.learnerId || "",
    variant: (app.assessment && app.assessment.variant) || "",
    assessment_id: (app.assessment && app.assessment.id) || "",
    fingerprint: (app.model && app.model.fingerprint) || "",
    session_id: (attempt && attempt.session_id) || "",
    started_at: (attempt && attempt.started_at) || "",
    user_agent: (globalThis.navigator && globalThis.navigator.userAgent) || "",
  };
}

export function buildStartedEvent(app, attempt) {
  return base(app, "started", attempt);
}

/**
 * @param {object} app
 * @param {object} results - output of scoring.grade(app)
 * @param {{session_id, started_at}|null} attempt
 */
export function buildSubmittedEvent(app, results, attempt, now = Date.now()) {
  const startedMs = attempt ? Date.parse(attempt.started_at) : NaN;
  return {
    ...base(app, "submitted", attempt),
    submitted_at: new Date(now).toISOString(),
    duration_sec: Number.isFinite(startedMs) ? Math.max(0, Math.round((now - startedMs) / 1000)) : "",
    total_earned: results.totalEarned,
    total_possible: results.totalPossible,
    percentage: results.percentage,
    by_challenge_json: results.byChallenge.map((c) => ({
      challenge: c.challenge,
      earned: c.earned,
      possible: c.possible,
    })),
    answers_json: results.results.map((r) => ({
      id: r.id,
      type: r.type,
      answer: app.answers.has(r.uid) ? app.answers.get(r.uid) : null,
      outcome: r.outcome,
      earned: r.earned,
      points: r.points,
    })),
  };
}

/**
 * POST one event. text/plain + no-cors avoids a CORS preflight, which Apps
 * Script doesn't answer; the response is opaque and deliberately ignored.
 * @returns {boolean} whether a request was attempted
 */
export function sendEvent(endpoint, data, fetchImpl = globalThis.fetch) {
  if (!endpoint || typeof fetchImpl !== "function") return false;
  try {
    const p = fetchImpl(endpoint, {
      method: "POST",
      mode: "no-cors",
      keepalive: true,
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(data),
    });
    if (p && typeof p.catch === "function") p.catch(() => {});
    return true;
  } catch {
    return false;
  }
}
