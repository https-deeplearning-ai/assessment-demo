// App state + screen routing (SPEC §3 flow).
//
// Holds the loaded model, the current screen, and in-quiz answer state. Per-type
// status is delegated to the question registry. In-quiz mutations auto-save via
// `persist` (wired by main.js, SPEC §7); serialize/hydrate bridge the in-memory
// Maps/Sets to the JSON-plain blob.

import { widgetFor } from "./questions/registry.js";
import { grade } from "./scoring.js";

export const SCREENS = Object.freeze({
  PICKER: "picker",
  INSTRUCTIONS: "instructions",
  QUIZ: "quiz",
  RESULTS: "results",
  ERROR: "error",
});

/**
 * Create the app controller.
 * @param {(app: AppController) => void} onChange - called whenever the screen changes
 * @returns {AppController}
 */
export function createApp(onChange) {
  /** @typedef {object} AppController */
  const app = {
    /** @type {object|null} normalized assessment model */
    model: null,
    /** @type {string} current screen key */
    screen: SCREENS.INSTRUCTIONS,
    /** @type {Error|null} */
    error: null,
    /** @type {number|null} per-assessment shuffle seed (SPEC §2.5) */
    sessionSeed: null,

    // ---- In-quiz state (keyed by question uid) --------------------------------
    // These are mutated in place by the quiz screen, which patches the DOM
    // directly rather than routing through the full-screen `onChange` render.
    // `onChange` is reserved for ROUTE changes (screen swaps) only, so per-answer
    // and per-navigation updates never destroy focus or in-progress input.
    /** @type {number} current question index into model.questions */
    currentIndex: 0,
    /** @type {Map<string, any>} uid -> answer payload (M3) */
    answers: new Map(),
    /** @type {Map<string, string[]>} uid -> resolved shuffle order of item ids (M3) */
    resolvedOrderings: new Map(),
    /** @type {boolean} */
    submitted: false,
    /** @type {object|null} computed results (M4) */
    results: null,
    /** @type {((app) => void)|null} persistence hook, set by main.js (SPEC §7) */
    persist: null,
    /** @type {(() => void)|null} called when a fresh attempt starts (telemetry) */
    onStart: null,
    /** @type {((results) => void)|null} called once on submit (telemetry) */
    onSubmit: null,

    /** Save in-quiz state through the persistence hook, if wired. */
    _save() {
      if (this.persist) this.persist(this);
    },
    /** @returns {object} JSON-plain blob of in-quiz state (SPEC §7) */
    serialize() {
      return {
        answers: Object.fromEntries(this.answers),
        resolvedOrderings: Object.fromEntries(this.resolvedOrderings),
        currentIndex: this.currentIndex,
        submitted: this.submitted,
      };
    },
    /** Restore in-quiz state from a stored blob (no save; results recomputed). */
    hydrate(blob) {
      if (!blob) return this;
      this.answers = new Map(Object.entries(blob.answers || {}));
      this.resolvedOrderings = new Map(Object.entries(blob.resolvedOrderings || {}));
      this.currentIndex = blob.currentIndex || 0;
      this.submitted = Boolean(blob.submitted);
      this.results = this.submitted && this.model ? grade(this) : null;
      return this;
    },

    setModel(model) {
      this.model = model;
      return this;
    },
    setSessionSeed(seed) {
      this.sessionSeed = seed;
      return this;
    },

    // ---- Navigation (no render; caller patches) --------------------------------
    /** @param {number} i @returns {number} the clamped index actually set */
    setIndex(i) {
      const n = this.model ? this.model.questions.length : 0;
      const prev = this.currentIndex;
      this.currentIndex = n === 0 ? 0 : Math.max(0, Math.min(i, n - 1));
      if (this.currentIndex !== prev) this._save(); // skip redundant writes (e.g. on resume)
      return this.currentIndex;
    },
    next() {
      return this.setIndex(this.currentIndex + 1);
    },
    back() {
      return this.setIndex(this.currentIndex - 1);
    },
    currentQuestion() {
      return this.model ? this.model.questions[this.currentIndex] : null;
    },

    // ---- Answer mutation (M3 populates; API defined now) -----------------------
    setAnswer(uid, payload) {
      this.answers.set(uid, payload);
      this._save();
      return this;
    },
    setResolvedOrdering(uid, itemIds) {
      this.resolvedOrderings.set(uid, itemIds);
      this._save();
      return this;
    },

    /**
     * Status of a question for the navigator/icon (SPEC §6), delegated to the
     * per-type module using the current answer payload.
     * @param {string} uid
     * @returns {"not-answered"|"in-progress"|"answered"}
     */
    statusOf(uid) {
      const q = this.model && this.model.byUid.get(uid);
      if (!q) return "not-answered";
      return widgetFor(q.type).statusOf(this.answers.get(uid), q);
    },
    /** Count of fully-answered questions (progress indicator). */
    answeredCount() {
      if (!this.model) return 0;
      let n = 0;
      for (const q of this.model.questions) if (this.statusOf(q.uid) === "answered") n++;
      return n;
    },
    /** Finalize: store results and route to the results screen (M4). */
    submit(results) {
      this.results = results;
      this.submitted = true;
      this._save(); // persist submitted so a reload returns to results (SPEC §7)
      if (this.onSubmit) {
        try {
          this.onSubmit(results);
        } catch {
          /* telemetry must never block showing results */
        }
      }
      return this.go(SCREENS.RESULTS);
    },
    /** Clear in-quiz state for a fresh attempt (Retake). */
    reset() {
      this.answers = new Map();
      this.resolvedOrderings = new Map();
      this.currentIndex = 0;
      this.submitted = false;
      this.results = null;
      return this;
    },
    fail(error) {
      this.error = error instanceof Error ? error : new Error(String(error));
      this.screen = SCREENS.ERROR;
      onChange(this);
      return this;
    },
    go(screen) {
      this.screen = screen;
      onChange(this);
      return this;
    },
  };
  return app;
}
