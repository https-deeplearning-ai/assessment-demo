// M0 tests — pure modules only (PRNG, shuffle, data normalization).
// Run with: npm test   (node --test)
// Grading tests arrive in M4.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { mulberry32, hashStringToSeed, questionRng, makeSessionSeed } from "../src/util/prng.js";
import { shuffle, shuffleUntil, sameOrder } from "../src/util/shuffle.js";
import {
  normalizeAssessment,
  fingerprintQuestions,
  normalizeManifest,
} from "../src/data/loadAssessment.js";

const DATA_PATH = fileURLToPath(
  new URL("../data/spec-driven-development-assessment.json", import.meta.url)
);
const rawAssessment = JSON.parse(readFileSync(DATA_PATH, "utf8"));

test("mulberry32 is deterministic for a given seed", () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((n) => n >= 0 && n < 1));
});

test("hashStringToSeed is stable and unsigned", () => {
  assert.equal(hashStringToSeed("1.1"), hashStringToSeed("1.1"));
  assert.notEqual(hashStringToSeed("1.1"), hashStringToSeed("1.2"));
  assert.ok(hashStringToSeed("anything") >= 0);
});

test("questionRng reproduces the same stream from session seed + id", () => {
  const r1 = questionRng(999, "2.1");
  const r2 = questionRng(999, "2.1");
  assert.equal(r1(), r2());
});

test("questionRng gives independent streams for different ids (and sessions)", () => {
  // §2.5 relies on each question shuffling independently.
  assert.notEqual(questionRng(999, "2.1")(), questionRng(999, "2.2")());
  assert.notEqual(questionRng(1, "2.1")(), questionRng(2, "2.1")());
  // All 18 real question uids produce distinct first draws for a fixed session.
  const model = normalizeAssessment(rawAssessment);
  const firsts = model.questions.map((q) => questionRng(12345, q.uid)());
  assert.equal(new Set(firsts).size, firsts.length);
});

test("makeSessionSeed returns an unsigned 32-bit integer", () => {
  const s = makeSessionSeed();
  assert.ok(Number.isInteger(s));
  assert.ok(s >= 0 && s <= 0xffffffff);
});

test("shuffle is a reproducible permutation", () => {
  const src = [1, 2, 3, 4, 5, 6, 7, 8];
  const out1 = shuffle(src, mulberry32(42));
  const out2 = shuffle(src, mulberry32(42));
  assert.deepEqual(out1, out2); // same seed → same result
  assert.deepEqual([...out1].sort((a, b) => a - b), src); // same elements
  assert.notDeepEqual(src, out1); // actually shuffled (with this seed)
});

test("shuffleUntil avoids the disallowed order deterministically", () => {
  const correct = ["a", "b", "c", "d"];
  const rng = mulberry32(7);
  const result = shuffleUntil(correct, rng, (cand) => sameOrder(cand, correct));
  assert.equal(sameOrder(result, correct), false);
  // reproducible
  const again = shuffleUntil(correct, mulberry32(7), (cand) => sameOrder(cand, correct));
  assert.deepEqual(result, again);
});

test("shuffleUntil forces inequality for length >= 2 via a deterministic swap", () => {
  // A 2-element list has only one alternative ordering, so the disallowed order
  // must be avoided regardless of seed.
  for (const seed of [0, 1, 2, 3, 99]) {
    const out = shuffleUntil(["a", "b"], mulberry32(seed), (c) => sameOrder(c, ["a", "b"]));
    assert.deepEqual(out, ["b", "a"]);
  }
  // Pathological predicate that is never satisfiable must still terminate and
  // return a same-length permutation (no hang).
  const out = shuffleUntil(["a", "b", "c"], mulberry32(5), () => true);
  assert.equal(out.length, 3);
  assert.deepEqual([...out].sort(), ["a", "b", "c"]);
});

test("shuffleUntil returns a single-element list unchanged (cannot differ)", () => {
  assert.deepEqual(shuffleUntil(["x"], mulberry32(3), () => true), ["x"]);
});

test("ordering questions round-trip: resolved order reproduces and differs from correct", () => {
  const model = normalizeAssessment(rawAssessment);
  const ordering = model.questions.filter((q) => q.type === "ordering");
  assert.ok(ordering.length > 0);
  const SEED = 24680;
  for (const q of ordering) {
    const resolve = () =>
      shuffleUntil(q.items, questionRng(SEED, q.uid), (cand) =>
        sameOrder(cand, q.items, (it) => it.id)
      );
    const first = resolve();
    const second = resolve();
    assert.equal(sameOrder(first, q.items, (it) => it.id), false, `${q.id} must differ from correct`);
    assert.deepEqual(
      first.map((it) => it.id),
      second.map((it) => it.id),
      `${q.id} must reproduce from the same seed`
    );
  }
});

test("normalizeAssessment flattens challenges and assigns 1 point each", () => {
  const model = normalizeAssessment(rawAssessment);
  assert.equal(model.counts.challenges, rawAssessment.challenges.length);
  const rawQuestionCount = rawAssessment.challenges.reduce((n, c) => n + c.questions.length, 0);
  assert.equal(model.counts.questions, rawQuestionCount);
  assert.equal(model.counts.totalPoints, rawQuestionCount);
  assert.ok(model.questions.every((q) => q.points === 1));
  // global index is contiguous
  model.questions.forEach((q, i) => assert.equal(q.index, i));
});

test("every renderable item gets a unique stable id", () => {
  const model = normalizeAssessment(rawAssessment);
  const ids = [];
  for (const q of model.questions) {
    if (q.options) ids.push(...q.options.map((o) => o.id));
    if (q.groupNames) ids.push(...q.items.map((it) => it.id));
    if (q.lefts) ids.push(...q.lefts.map((l) => l.id), ...q.rights.map((r) => r.id));
    if (q.solutionOrder) ids.push(...q.items.map((it) => it.id));
  }
  assert.equal(new Set(ids).size, ids.length, "item ids must be unique");
});

test("each question type normalizes its answer key", () => {
  const model = normalizeAssessment(rawAssessment);
  const byType = (t) => model.questions.filter((q) => q.type === t);

  for (const q of byType("single_selection")) {
    assert.equal(q.options.filter((o) => o.correct).length, 1);
  }
  for (const q of byType("multiple_selections")) {
    assert.ok(q.options.filter((o) => o.correct).length >= 1);
  }
  for (const q of byType("grouping")) {
    assert.ok(q.groupNames.length >= 2);
    assert.ok(q.items.every((it) => q.groupNames.includes(it.correctGroup)));
  }
  for (const q of byType("matching")) {
    assert.equal(q.lefts.length, q.rights.length);
    assert.equal(Object.keys(q.solution).length, q.lefts.length);
  }
  for (const q of byType("ordering")) {
    assert.deepEqual(q.solutionOrder, q.items.map((it) => it.id));
  }
});

test("normalizeAssessment exposes a byId lookup covering every question", () => {
  const model = normalizeAssessment(rawAssessment);
  assert.equal(model.byId.size, model.questions.length);
  for (const q of model.questions) assert.equal(model.byId.get(q.id), q);
});

const clone = (o) => JSON.parse(JSON.stringify(o));
const fp = (raw) => normalizeAssessment(raw).fingerprint;

test("fingerprint is stable across reloads and changes on prompt edits", () => {
  const base = fp(rawAssessment);
  assert.equal(base, fp(clone(rawAssessment)));

  const m = clone(rawAssessment);
  m.challenges[0].questions[0].prompt += " (edited)";
  assert.notEqual(fp(m), base);
});

test("fingerprint detects answer-key drift for every type", () => {
  const base = fp(rawAssessment);

  // single/multiple selection: move which option is correct (question 1.3 is
  // single_selection) — keeps exactly one correct but changes the answer key.
  const sel = clone(rawAssessment);
  const q13 = sel.challenges[0].questions.find((q) => q.id === "1.3");
  const ci = q13.options.findIndex((o) => o.correct);
  q13.options[ci].correct = false;
  q13.options[(ci + 1) % q13.options.length].correct = true;
  assert.notEqual(fp(sel), base, "moving the correct option must change the fingerprint");

  // grouping: move an item to a different group (question 1.1)
  const grp = clone(rawAssessment);
  const q11 = grp.challenges[0].questions.find((q) => q.id === "1.1");
  const names = Object.keys(q11.groups);
  q11.groups[names[1]].push(q11.groups[names[0]].shift());
  assert.notEqual(fp(grp), base, "moving a grouping item must change the fingerprint");

  // matching: re-pair by swapping two rights (question 2.1) — the label SETS are
  // unchanged, only the pairing differs, so this is the case the old code missed.
  const mat = clone(rawAssessment);
  const q21 = mat.challenges[1].questions.find((q) => q.id === "2.1");
  [q21.pairs[0].right, q21.pairs[1].right] = [q21.pairs[1].right, q21.pairs[0].right];
  assert.notEqual(fp(mat), base, "re-pairing a matching question must change the fingerprint");

  // ordering: swap two steps (question 3.2)
  const ord = clone(rawAssessment);
  const q32 = ord.challenges[2].questions.find((q) => q.id === "3.2");
  [q32.correct_order[0], q32.correct_order[1]] = [q32.correct_order[1], q32.correct_order[0]];
  assert.notEqual(fp(ord), base, "reordering must change the fingerprint");
});

test("normalizeManifest validates entries and rejects bad input", () => {
  const m = normalizeManifest([
    { id: "a", title: "A", file: "data/a.json" },
    { id: "b", title: "B", file: "data/b.json", description: "two" },
  ]);
  assert.equal(m.length, 2);
  assert.deepEqual(m[0], { id: "a", title: "A", file: "data/a.json", description: "", variant: "" });
  assert.equal(m[1].description, "two");
  assert.throws(() => normalizeManifest([]), /non-empty/);
  assert.throws(() => normalizeManifest([{ id: "a", title: "A" }]), /file/); // missing file
  assert.throws(
    () => normalizeManifest([{ id: "x", title: "X", file: "x" }, { id: "x", title: "Y", file: "y" }]),
    /Duplicate/
  );
});

test("normalizeAssessment rejects malformed input", () => {
  assert.throws(() => normalizeAssessment(null));
  assert.throws(() => normalizeAssessment({}));
  assert.throws(() => normalizeAssessment({ challenges: [] }));
});

test("normalizeAssessment tolerates an empty challenge (skipped, not thrown)", () => {
  // SPEC §10: an empty challenge is skipped in navigation, not an error.
  const m = clone(rawAssessment);
  m.challenges.push({ challenge_number: 99, scenario: "empty", questions: [] });
  const model = normalizeAssessment(m);
  assert.equal(model.counts.challenges, rawAssessment.challenges.length + 1);
  // question count is unchanged; the empty challenge contributes none
  const rawCount = rawAssessment.challenges.reduce((n, c) => n + c.questions.length, 0);
  assert.equal(model.counts.questions, rawCount);
  const empty = model.challenges.find((c) => c.challenge_number === 99);
  assert.deepEqual(empty.questions, []);
});

test("normalizeAssessment throws on duplicate question ids", () => {
  const m = clone(rawAssessment);
  m.challenges[0].questions[1].id = m.challenges[0].questions[0].id;
  assert.throws(() => normalizeAssessment(m), /Duplicate question id/);
});

test("normalizeAssessment enforces per-type answer-key validity", () => {
  const wrap = (question) => ({
    capability_name: "T",
    challenges: [{ challenge_number: 1, scenario: "s", questions: [question] }],
  });

  // empty options
  assert.throws(() => normalizeAssessment(wrap({ id: "x", type: "single_selection", prompt: "p", options: [] })));
  // single_selection with two correct
  assert.throws(() =>
    normalizeAssessment(
      wrap({
        id: "x",
        type: "single_selection",
        prompt: "p",
        options: [
          { label: "a", correct: true },
          { label: "b", correct: true },
        ],
      })
    )
  );
  // matching with a non-string pair
  assert.throws(() =>
    normalizeAssessment(wrap({ id: "x", type: "matching", prompt: "p", pairs: [{ left: "a", right: 3 }] }))
  );
  // grouping with fewer than two groups
  assert.throws(() =>
    normalizeAssessment(wrap({ id: "x", type: "grouping", prompt: "p", groups: { only: ["a"] } }))
  );
});
