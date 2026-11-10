// Instructions screen (SPEC §3.1).

import { SCREENS } from "../state.js";
import { el, mountScreen, heading } from "./dom.js";
import { focusHeading, announce } from "../util/a11y.js";
import { hasSavedProgress, startFresh } from "../session.js";
import { isPersistent } from "../util/storage.js";

const TYPE_LABELS = {
  single_selection: "Multiple choice — one answer",
  multiple_selections: "Multiple choice — select all that apply",
  grouping: "Grouping — sort items into categories",
  matching: "Matching — pair items across two lists",
  ordering: "Ordering — arrange items in sequence",
};

export function renderInstructions(root, app) {
  const { meta, counts } = app.model;
  const persistent = isPersistent();
  const section = mountScreen(root, "instructions");

  const h1 = heading(meta.capability_name);
  section.append(h1, metaLine(meta));
  if (meta.lead_scenario) section.append(el("p", "screen__lead", meta.lead_scenario));

  section.append(summary(counts), typeLegend(app.model), howItWorks(persistent));

  // Caveat goes ABOVE the actions so it's seen/heard before the learner commits.
  if (!persistent) {
    const notice = el(
      "p",
      "screen__notice",
      "Heads up — this browser won't save your progress, so it won't survive a reload."
    );
    notice.setAttribute("role", "note");
    section.append(notice);
  }
  section.append(actions(root, app));

  // Moving focus to the h1 makes the screen reader announce the title; a
  // separate announcement here would double-speak, so we rely on focus alone.
  focusHeading(h1);
  if (!persistent) {
    announce("This browser won't save your progress, so it won't survive a reload.");
  }
}

function metaLine(meta) {
  const bits = [meta.audience, meta.estimated_duration, "no time limit"].filter(Boolean);
  return el("p", "screen__meta", bits.join(" · "));
}

function summary(counts) {
  return el(
    "p",
    "screen__summary",
    `${counts.challenges} challenges · ${counts.questions} questions · ${counts.totalPoints} points`
  );
}

// A <section> is only exposed as a landmark region if it has an accessible name,
// so each section's <h2> is given an id and referenced via aria-labelledby.
function labelledSection(modifier, headingText, headingId) {
  const wrap = el("section", modifier);
  const h2 = el("h2", "", headingText);
  h2.id = headingId;
  wrap.setAttribute("aria-labelledby", headingId);
  wrap.append(h2);
  return wrap;
}

function typeLegend(model) {
  const present = new Map();
  for (const q of model.questions) present.set(q.type, (present.get(q.type) || 0) + 1);

  const wrap = labelledSection("legend", "Question types", "legend-heading");
  const list = el("ul", "legend__list");
  for (const [type, count] of present) {
    const label = TYPE_LABELS[type] || type;
    list.append(el("li", "legend__item", `${label} (${count})`));
  }
  wrap.append(list);
  return wrap;
}

function howItWorks(persistent) {
  const wrap = labelledSection("howto", "How it works", "howto-heading");
  const list = el("ul", "howto__list");
  const notes = [
    "Move freely between questions — use Back, Next, or the question navigator to jump to any question.",
    // Only promise reload-safety when storage actually works (the notice covers the other case).
    persistent
      ? "Your progress is saved automatically and survives a page reload."
      : "Your answers are kept as you work through the assessment.",
    "You can change any answer until you submit.",
    "Each question shows how many points it is worth.",
  ];
  for (const note of notes) list.append(el("li", "", note));
  wrap.append(list);
  return wrap;
}

function actions(root, app) {
  const wrap = el("div", "actions");
  const key = app.sessionKey;

  if (hasSavedProgress(key)) {
    // Resume is the primary action; starting over is secondary (SPEC §3.1).
    const resume = primaryButton("Resume", () => app.go(SCREENS.QUIZ));
    const startOver = secondaryButton("Start over", () => {
      app.reset(); // clear in-memory answers/index/results
      app.setSessionSeed(startFresh(key)); // clear storage + mint a new seed
      notifyStart(app);
      // assertive region so it isn't clobbered by the quiz's polite "Question 1…"
      announce("Progress cleared. Starting over.", { assertive: true });
      app.go(SCREENS.QUIZ);
    });
    wrap.append(resume, startOver);
  } else {
    wrap.append(
      primaryButton("Start assessment", () => {
        notifyStart(app);
        app.go(SCREENS.QUIZ);
      })
    );
  }
  return wrap;
}

// A fresh attempt begins (not on Resume); telemetry must never block the quiz.
function notifyStart(app) {
  if (!app.onStart) return;
  try {
    app.onStart();
  } catch {
    /* ignore */
  }
}

function primaryButton(text, onClick) {
  const b = el("button", "dl-btn dl-btn--primary", text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function secondaryButton(text, onClick) {
  const b = el("button", "dl-btn dl-btn--secondary", text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}
