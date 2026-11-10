// App bootstrap + screen router (SPEC §9).
//
// Loads the assessment manifest, lets the learner pick an assessment (or honors
// ?a=<id> / a single default), restores any saved session (SPEC §7), wires
// auto-save, and routes between screens.

import { loadAssessment, loadManifest } from "./data/loadAssessment.js";
import { createApp, SCREENS } from "./state.js";
import { getOrCreateSeed, loadSession, saveSession, hasSavedProgress } from "./session.js";
import { renderPicker } from "./screens/picker.js";
import { renderInstructions } from "./screens/instructions.js";
import { renderQuiz } from "./screens/quiz.js";
import { renderResults } from "./screens/results.js";
import { renderError } from "./screens/error.js";
import { RESULTS_ENDPOINT } from "./config.js";
import {
  learnerIdFromUrl,
  resolveLearnerId,
  startAttempt,
  currentAttempt,
  buildStartedEvent,
  buildSubmittedEvent,
  sendEvent,
} from "./telemetry.js";

// Fallback when no manifest is present — keeps the app working with one file.
const DEFAULT_ENTRY = {
  id: "default",
  title: "Assessment",
  file: "data/spec-driven-development-assessment.json",
  description: "",
};

const root = document.getElementById("app");
const app = createApp(render);

// Experiment telemetry (see telemetry.js). Hooks read app.sessionKey at call
// time, so they follow whichever assessment is open.
app.learnerId = resolveLearnerId(globalThis.location.href);
app.onStart = () => {
  const attempt = startAttempt(app.sessionKey);
  sendEvent(RESULTS_ENDPOINT, buildStartedEvent(app, attempt));
};
app.onSubmit = (results) => {
  sendEvent(RESULTS_ENDPOINT, buildSubmittedEvent(app, results, currentAttempt(app.sessionKey)));
};

function render(a) {
  switch (a.screen) {
    case SCREENS.PICKER:
      return renderPicker(root, a);
    case SCREENS.QUIZ:
      return renderQuiz(root, a);
    case SCREENS.RESULTS:
      return renderResults(root, a);
    case SCREENS.ERROR:
      return renderError(root, a);
    case SCREENS.INSTRUCTIONS:
    default:
      return renderInstructions(root, a);
  }
}

function urlParam() {
  try {
    return new URL(globalThis.location.href).searchParams.get("a");
  } catch {
    return null;
  }
}
function setUrlParam(id) {
  try {
    const u = new URL(globalThis.location.href);
    u.searchParams.set("a", id);
    globalThis.history.replaceState(null, "", u);
  } catch {
    /* no history/URL (e.g. file://) — deep-linking just won't persist */
  }
}

// Load + install one assessment, restoring its own fingerprint-scoped session.
async function openAssessment(entry) {
  try {
    const model = await loadAssessment(entry.file);
    app.reset(); // drop any previously-open assessment's in-memory state
    app.setModel(model);
    app.assessment = entry;
    // Namespace the session by manifest id + content fingerprint: distinct
    // assessments never collide (even with identical content), and a content
    // change still invalidates stale saves (the fingerprint part changes).
    app.sessionKey = `${entry.id}:${model.fingerprint}`;
    document.title = `${model.meta.capability_name} — Assessment`;
    app.setSessionSeed(getOrCreateSeed(app.sessionKey));
    if (hasSavedProgress(app.sessionKey)) app.hydrate(loadSession(app.sessionKey));
    app.persist = (a) => saveSession(app.sessionKey, a.serialize());
    setUrlParam(entry.id);
    app.go(app.submitted ? SCREENS.RESULTS : SCREENS.INSTRUCTIONS);
  } catch (err) {
    console.error("[assessment] failed to load:", err);
    app.fail(err);
  }
}
app.open = openAssessment;

async function boot() {
  try {
    const manifest = await loadManifest();
    const entries = manifest && manifest.length ? manifest : [DEFAULT_ENTRY];
    app.assessments = entries;

    const chosen = entries.find((e) => e.id === urlParam());
    if (chosen) await openAssessment(chosen); // deep-linked
    else if (learnerIdFromUrl(globalThis.location.href)) {
      // Experiment link from the platform: never offer the picker (it would let
      // a learner switch to the other variant).
      throw new Error("This assessment link is incomplete. Please reopen it from the course page.");
    } else if (entries.length === 1) await openAssessment(entries[0]); // nothing to pick
    else app.go(SCREENS.PICKER); // let the learner choose
  } catch (err) {
    console.error("[assessment] failed to boot:", err);
    app.fail(err);
  }
}

boot();
