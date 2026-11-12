// Assessment data layer (SPEC §2).
//
// Responsibilities:
//   - load the assessment JSON over a RELATIVE path (GitHub Pages subpath-safe;
//     requires a local static server in dev — fetch() is blocked under file://)
//   - validate its shape and fail loudly with a useful message
//   - normalize each question into a flat, render-ready model, assigning a
//     STABLE SYNTHETIC id to every renderable item (§2.5) so duplicate labels
//     never collide downstream
//   - flatten challenges into one global question sequence
//   - compute a content FINGERPRINT for persistence namespacing (§7)
//
// This module does NO shuffling and NO grading — those live in later milestones.

import { normalizePrefill, normalizeQuestions } from "../survey.js";

const POINTS_PER_QUESTION = 1; // SPEC §5

const ALL_TYPES = new Set([
  "single_selection",
  "multiple_selections",
  "grouping",
  "matching",
  "ordering",
]);

/**
 * Fetch the assessment manifest (the list of selectable assessments).
 * Returns null if it's absent/unreadable so callers can fall back to a single
 * default assessment.
 * @param {string} [path]
 * @returns {Promise<Array<{id,title,file,description?}>|null>}
 */
export async function loadManifest(path = "data/assessments.json") {
  try {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) return null;
    return normalizeManifest(await res.json());
  } catch {
    return null;
  }
}

/**
 * Validate + normalize a manifest (pure, testable).
 * @param {any} raw
 * @returns {Array<{id,title,file,description?}>}
 */
export function normalizeManifest(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Manifest must be a non-empty array of assessments.");
  }
  const seen = new Set();
  return raw.map((e, i) => {
    const id = str(e && e.id, `assessments[${i}].id`);
    const title = str(e && e.title, `assessments[${i}].title`);
    const file = str(e && e.file, `assessments[${i}].file`);
    if (seen.has(id)) throw new Error(`Duplicate assessment id "${id}" in manifest.`);
    seen.add(id);
    return {
      id,
      title,
      file,
      description: typeof e.description === "string" ? e.description : "",
      // Experiment arm ("A"/"B") recorded with results and the survey; "" if unset.
      variant: typeof e.variant === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(e.variant) ? e.variant : "",
    };
  });
}

/**
 * Fetch and normalize the assessment at a relative path.
 * @param {string} [path]
 * @returns {Promise<object>} normalized assessment model
 */
export async function loadAssessment(path = "data/spec-driven-development-assessment.json") {
  let raw;
  try {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    raw = await res.json();
  } catch (err) {
    throw new Error(
      `Could not load assessment from "${path}". ` +
        `If you opened index.html directly, start a local server instead ` +
        `(e.g. "npx serve" or "python3 -m http.server"). Cause: ${err.message}`
    );
  }
  return normalizeAssessment(raw);
}

/**
 * Validate + normalize a raw assessment object into the app model.
 * Pure (no I/O), so it is unit-testable.
 * @param {any} raw
 * @returns {object}
 */
export function normalizeAssessment(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Assessment JSON is not an object.");
  }
  if (!Array.isArray(raw.challenges) || raw.challenges.length === 0) {
    throw new Error("Assessment is missing a non-empty `challenges` array.");
  }

  const meta = {
    capability_name: str(raw.capability_name, "capability_name"),
    audience: raw.audience ?? "",
    estimated_duration: raw.estimated_duration ?? "",
    lead_scenario: raw.lead_scenario ?? "",
    // Optional post-assessment survey link shown on the results screen. Only
    // absolute http(s) URLs are accepted; anything else hides the survey block.
    survey_url: httpUrl(raw.survey_url),
    // Optional Google Form prefill: our field name -> the form's "entry.<n>" id.
    survey_prefill: normalizePrefill(raw.survey_prefill),
    // Optional in-page survey questions (posted to the form's formResponse);
    // when empty the results screen falls back to embedding the form.
    survey_questions: normalizeQuestions(raw.survey_questions),
  };

  const challenges = [];
  const questions = [];
  let globalIndex = 0;

  raw.challenges.forEach((ch, ci) => {
    if (!ch || typeof ch !== "object") {
      throw new Error(`Challenge at index ${ci} is not an object.`);
    }
    const challengeNumber = ch.challenge_number ?? ci + 1;
    if (!Array.isArray(ch.questions)) {
      throw new Error(`Challenge ${challengeNumber} is missing a 'questions' array.`);
    }
    const normQuestions = ch.questions.map((q) =>
      normalizeQuestion(q, challengeNumber, globalIndex++)
    );
    questions.push(...normQuestions);
    challenges.push({
      challenge_number: challengeNumber,
      scenario: ch.scenario ?? "",
      questions: normQuestions,
    });
  });

  if (questions.length === 0) {
    throw new Error("Assessment contains no questions.");
  }

  // Reject duplicate question ids: they'd break per-question keying (rng streams,
  // answer state) even though the synthetic `uid` is index-based and unique.
  const byId = new Map();
  const byUid = new Map();
  for (const q of questions) {
    if (byId.has(q.id)) {
      throw new Error(`Duplicate question id "${q.id}" — question ids must be unique.`);
    }
    byId.set(q.id, q);
    byUid.set(q.uid, q);
  }

  return {
    meta,
    challenges,
    questions,
    byId,
    byUid,
    fingerprint: fingerprintQuestions(questions),
    counts: {
      challenges: challenges.length,
      questions: questions.length,
      totalPoints: questions.length * POINTS_PER_QUESTION,
    },
  };
}

/**
 * Normalize one question, assigning stable synthetic ids to every item.
 * @param {any} q
 * @param {number} challengeNumber
 * @param {number} index - global question index
 * @returns {object}
 */
function normalizeQuestion(q, challengeNumber, index) {
  if (!q || typeof q !== "object") {
    throw new Error(`Question at global index ${index} is not an object.`);
  }
  const id = str(q.id, `question[${index}].id`);
  if (!ALL_TYPES.has(q.type)) {
    throw new Error(`Question ${id} has unknown type "${q.type}".`);
  }
  const prompt = str(q.prompt, `question ${id} prompt`);

  // `uid` is a stable, globally-unique internal key (from the global index) used
  // to build item ids and to seed per-question shuffles (SPEC §2.5) — so even a
  // duplicate authored `q.id` can't cause item-id collisions or shared rng streams.
  const uid = `q${index}`;

  const base = {
    id,
    uid,
    type: q.type,
    behavior: q.behavior ?? "",
    prompt,
    challengeNumber,
    index,
    points: POINTS_PER_QUESTION,
  };

  switch (q.type) {
    case "single_selection":
    case "multiple_selections":
      return { ...base, ...normalizeSelection(q, id, uid) };
    case "grouping":
      return { ...base, ...normalizeGrouping(q, id, uid) };
    case "matching":
      return { ...base, ...normalizeMatching(q, id, uid) };
    case "ordering":
      return { ...base, ...normalizeOrdering(q, id, uid) };
    default:
      // Unreachable: guarded by ALL_TYPES above.
      throw new Error(`Unhandled question type "${q.type}".`);
  }
}

function normalizeSelection(q, id, uid) {
  if (!Array.isArray(q.options) || q.options.length === 0) {
    throw new Error(`Question ${id} (${q.type}) needs a non-empty 'options' array.`);
  }
  const options = q.options.map((o, i) => {
    if (!o || typeof o.label !== "string") {
      throw new Error(`Question ${id} option ${i} is missing a 'label'.`);
    }
    return { id: `${uid}::opt::${i}`, label: o.label, correct: Boolean(o.correct) };
  });
  const correctCount = options.filter((o) => o.correct).length;
  if (correctCount === 0) {
    throw new Error(`Question ${id} (${q.type}) has no correct option.`);
  }
  if (q.type === "single_selection" && correctCount !== 1) {
    throw new Error(`Question ${id} (single_selection) must have exactly one correct option; found ${correctCount}.`);
  }
  return { options };
}

function normalizeGrouping(q, id, uid) {
  if (!q.groups || typeof q.groups !== "object" || Array.isArray(q.groups)) {
    throw new Error(`Question ${id} (grouping) needs a 'groups' object.`);
  }
  const groupNames = Object.keys(q.groups);
  if (groupNames.length < 2) {
    throw new Error(`Question ${id} (grouping) needs at least two groups.`);
  }
  const items = [];
  let i = 0;
  for (const name of groupNames) {
    const list = q.groups[name];
    if (!Array.isArray(list)) {
      throw new Error(`Question ${id} group "${name}" is not an array.`);
    }
    for (const label of list) {
      if (typeof label !== "string") {
        throw new Error(`Question ${id} group "${name}" has a non-string item.`);
      }
      items.push({ id: `${uid}::item::${i++}`, label, correctGroup: name });
    }
  }
  if (items.length === 0) {
    throw new Error(`Question ${id} (grouping) has no items.`);
  }
  return { groupNames, items };
}

function normalizeMatching(q, id, uid) {
  if (!Array.isArray(q.pairs) || q.pairs.length === 0) {
    throw new Error(`Question ${id} (matching) needs a non-empty 'pairs' array.`);
  }
  const lefts = [];
  const rights = [];
  const solution = {}; // leftId -> correct rightId
  q.pairs.forEach((p, i) => {
    if (!p || typeof p.left !== "string" || typeof p.right !== "string") {
      throw new Error(`Question ${id} pair ${i} needs string 'left' and 'right'.`);
    }
    const leftId = `${uid}::L::${i}`;
    const rightId = `${uid}::R::${i}`;
    lefts.push({ id: leftId, label: p.left });
    rights.push({ id: rightId, label: p.right });
    solution[leftId] = rightId;
  });
  return { lefts, rights, solution };
}

function normalizeOrdering(q, id, uid) {
  if (!Array.isArray(q.correct_order) || q.correct_order.length === 0) {
    throw new Error(`Question ${id} (ordering) needs a non-empty 'correct_order' array.`);
  }
  const items = q.correct_order.map((label, i) => {
    if (typeof label !== "string") {
      throw new Error(`Question ${id} correct_order item ${i} is not a string.`);
    }
    return { id: `${uid}::step::${i}`, label, correctIndex: i };
  });
  return { items, solutionOrder: items.map((it) => it.id) };
}

/**
 * Content fingerprint (SPEC §7): a hash of question ids, types, and all
 * option/item text. Namespaces persisted state so a changed assessment (even
 * one with the same title and question count) invalidates stale saves.
 * @param {object[]} questions - normalized questions
 * @returns {string} hex fingerprint
 */
export function fingerprintQuestions(questions) {
  const parts = [];
  for (const q of questions) {
    parts.push(q.id, q.type, q.prompt);
    if (q.options) parts.push(...q.options.map((o) => `${o.label}#${o.correct ? 1 : 0}`));
    if (q.items && q.groupNames) parts.push(...q.items.map((it) => `${it.label}@${it.correctGroup}`));
    if (q.lefts) parts.push(...q.lefts.map((l, i) => `${l.label}=>${q.rights[i].label}`));
    if (q.items && q.solutionOrder) parts.push(...q.items.map((it, i) => `${i}:${it.label}`));
  }
  return cyrb53(parts.join("|"));
}

// cyrb53 — a fast, well-distributed 53-bit string hash rendered as hex.
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}

/** @returns {string} the URL if it's an absolute http(s) URL, else "" */
function httpUrl(v) {
  if (typeof v !== "string") return "";
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch {
    return "";
  }
}

function str(v, what) {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Expected non-empty string for ${what}.`);
  }
  return v;
}
