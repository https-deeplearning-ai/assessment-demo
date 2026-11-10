// Experiment telemetry + survey prefill (pure helpers; storage uses the
// in-memory fallback under Node).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { _resetForTests } from "../src/util/storage.js";
import {
  learnerIdFromUrl,
  resolveLearnerId,
  startAttempt,
  currentAttempt,
  buildStartedEvent,
  buildSubmittedEvent,
  sendEvent,
} from "../src/telemetry.js";
import { normalizePrefill, buildSurveyUrl } from "../src/survey.js";
import { normalizeManifest } from "../src/data/loadAssessment.js";

beforeEach(() => _resetForTests());

const BASE = "https://x.github.io/assessment-demo/";

test("learnerIdFromUrl accepts a safe uh and rejects junk", () => {
  assert.equal(learnerIdFromUrl(`${BASE}?a=spec-driven-a&uh=abc_123-Z`), "abc_123-Z");
  assert.equal(learnerIdFromUrl(`${BASE}?uh=<script>`), "");
  assert.equal(learnerIdFromUrl(`${BASE}?a=spec-driven-a`), "");
  assert.equal(learnerIdFromUrl("not a url"), "");
});

test("resolveLearnerId remembers the uh for later visits without it", () => {
  assert.equal(resolveLearnerId(`${BASE}?uh=u1`), "u1");
  assert.equal(resolveLearnerId(BASE), "u1");
  assert.equal(resolveLearnerId(`${BASE}?uh=u2`), "u2");
});

test("startAttempt mints a new attempt that currentAttempt returns", () => {
  assert.equal(currentAttempt("k"), null);
  const a = startAttempt("k", Date.UTC(2026, 10, 10), () => 0.5);
  assert.equal(a.started_at, "2026-11-10T00:00:00.000Z");
  assert.deepEqual(currentAttempt("k"), a);
  const b = startAttempt("k", Date.UTC(2026, 10, 11), () => 0.25);
  assert.notEqual(b.session_id, a.session_id);
});

function fakeApp() {
  return {
    learnerId: "u1",
    assessment: { id: "spec-driven-a", variant: "A" },
    model: { fingerprint: "fp" },
    answers: new Map([["q1", "b"]]),
  };
}
const RESULTS = {
  totalEarned: 1,
  totalPossible: 2,
  percentage: 50,
  byChallenge: [{ challenge: 1, scenario: "long text", earned: 1, possible: 2 }],
  results: [
    { uid: "q1", id: "1.1", type: "single_selection", points: 1, earned: 1, outcome: "correct" },
    { uid: "q2", id: "1.2", type: "ordering", points: 1, earned: 0, outcome: "not-answered" },
  ],
};

test("buildStartedEvent carries identity and attempt", () => {
  const e = buildStartedEvent(fakeApp(), { session_id: "s", started_at: "t" });
  assert.equal(e.event, "started");
  assert.equal(e.uh, "u1");
  assert.equal(e.variant, "A");
  assert.equal(e.assessment_id, "spec-driven-a");
  assert.equal(e.session_id, "s");
});

test("buildSubmittedEvent includes totals, duration and every answer", () => {
  const attempt = { session_id: "s", started_at: "2026-11-10T00:00:00.000Z" };
  const e = buildSubmittedEvent(fakeApp(), RESULTS, attempt, Date.parse("2026-11-10T00:10:00.000Z"));
  assert.equal(e.event, "submitted");
  assert.equal(e.duration_sec, 600);
  assert.equal(e.percentage, 50);
  assert.deepEqual(e.by_challenge_json, [{ challenge: 1, earned: 1, possible: 2 }]);
  assert.deepEqual(e.answers_json, [
    { id: "1.1", type: "single_selection", answer: "b", outcome: "correct", earned: 1, points: 1 },
    { id: "1.2", type: "ordering", answer: null, outcome: "not-answered", earned: 0, points: 1 },
  ]);
});

test("buildSubmittedEvent tolerates a missing attempt", () => {
  const e = buildSubmittedEvent(fakeApp(), RESULTS, null);
  assert.equal(e.session_id, "");
  assert.equal(e.duration_sec, "");
});

test("sendEvent posts text/plain no-cors, and is a no-op without an endpoint", () => {
  const calls = [];
  const fetchImpl = (url, opts) => {
    calls.push([url, opts]);
    return Promise.reject(new Error("offline")); // must be swallowed
  };
  assert.equal(sendEvent("", { event: "started" }, fetchImpl), false);
  assert.equal(sendEvent("https://script.google.com/x/exec", { event: "started" }, fetchImpl), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].mode, "no-cors");
  assert.match(calls[0][1].headers["Content-Type"], /^text\/plain/);
  assert.deepEqual(JSON.parse(calls[0][1].body), { event: "started" });
  assert.equal(sendEvent("https://e/exec", {}, () => { throw new Error("boom"); }), false);
});

test("normalizePrefill keeps only known fields with entry ids", () => {
  assert.deepEqual(
    normalizePrefill({ uh: "entry.1", variant: "entry.22", score: "nope", other: "entry.3" }),
    { uh: "entry.1", variant: "entry.22" }
  );
  assert.deepEqual(normalizePrefill(null), {});
});

test("buildSurveyUrl prefills values and switches to pp_url / embedded", () => {
  const base = "https://docs.google.com/forms/d/e/ID/viewform?usp=header";
  const url = new URL(
    buildSurveyUrl(base, { uh: "entry.1", variant: "entry.2" }, { uh: "u1", variant: "A" }, { embedded: true })
  );
  assert.equal(url.searchParams.get("entry.1"), "u1");
  assert.equal(url.searchParams.get("entry.2"), "A");
  assert.equal(url.searchParams.get("usp"), "pp_url");
  assert.equal(url.searchParams.get("embedded"), "true");

  const plain = new URL(buildSurveyUrl(base, { uh: "entry.1" }, { uh: "" }));
  assert.equal(plain.searchParams.get("usp"), "header"); // nothing filled → unchanged
  assert.equal(plain.searchParams.has("embedded"), false);
  assert.equal(buildSurveyUrl("bad", {}, {}), "");
});

test("normalizeManifest passes through a safe variant", () => {
  const [a, b] = normalizeManifest([
    { id: "a", title: "A", file: "a.json", variant: "A" },
    { id: "b", title: "B", file: "b.json", variant: "<x>" },
  ]);
  assert.equal(a.variant, "A");
  assert.equal(b.variant, "");
});
