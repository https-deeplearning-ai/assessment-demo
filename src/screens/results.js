// Results screen (SPEC §3.4): score summary + per-challenge, per-question review
// with the learner's answer, the canonical correct solution, and outcome (shape +
// label, not color alone). Read-only; Retake clears state and returns to start.

import { SCREENS } from "../state.js";
import { el, mountScreen, heading } from "./dom.js";
import { focusHeading, announce } from "../util/a11y.js";
import { widgetFor } from "../questions/registry.js";
import { grade } from "../scoring.js";
import { startFresh } from "../session.js";
import {
  buildSurveyUrl,
  buildSurveyBody,
  formResponseUrl,
  submitSurvey,
} from "../survey.js";
import { getItem, setItem } from "../util/storage.js";
import { currentAttempt } from "../telemetry.js";

const OUTCOME = {
  correct: { shape: "✓", label: "Correct" },
  partial: { shape: "◐", label: "Partial" },
  incorrect: { shape: "✕", label: "Incorrect" },
  "not-answered": { shape: "○", label: "Not answered" },
};

const fmt = (n) => String(Math.round(n * 100) / 100); // 0.6667 -> "0.67", 1 -> "1"

export function renderResults(root, app) {
  const { model } = app;
  const r = app.results || grade(app); // recompute if arrived without stored results

  const section = mountScreen(root, "results");
  const h1 = heading("Here's how you did");
  section.append(h1, summaryBlock(r));

  const challenges = model.challenges.filter((ch) => ch.questions.length);
  section.append(reviewNav(challenges)); // jump to any challenge's review (SPEC §3.4)
  const surveyValues = {
    uh: app.learnerId,
    variant: app.assessment && app.assessment.variant,
    score: fmt(r.totalEarned),
    percentage: r.percentage,
  };
  const survey = model.meta.survey_questions.length
    ? inPageSurvey(model.meta, surveyValues, surveyDoneKey(app))
    : surveyBlock(model.meta, surveyValues); // null when no survey configured
  if (survey) section.append(survey);
  for (const ch of challenges) section.append(challengeBlock(ch, r, app));

  const actions = el("div", "actions");
  const retake = el("button", "dl-btn dl-btn--primary", "Retake");
  retake.type = "button";
  retake.addEventListener("click", () => {
    app.setSessionSeed(startFresh(app.sessionKey));
    app.reset();
    app.go(SCREENS.INSTRUCTIONS);
  });
  actions.append(retake);
  section.append(actions);

  focusHeading(h1);
  // Polite: this is a route landing, not a system event, and focus already reads the h1.
  announce(`Results: ${fmt(r.totalEarned)} of ${r.totalPossible} points, ${r.percentage} percent.`);
}

// Post-assessment survey rendered in the page and posted to the Google Form, so
// uh / variant travel as hidden values the learner never sees. One response per
// attempt: once sent, a re-render shows the thank-you note instead.
function surveyDoneKey(app) {
  const attempt = currentAttempt(app.sessionKey);
  return `assessment:survey:${app.sessionKey}:${attempt ? attempt.session_id : ""}`;
}

function inPageSurvey(meta, values, doneKey) {
  const action = formResponseUrl(meta.survey_url);
  if (!action) return null;

  const wrap = el("aside", "results-survey");
  wrap.setAttribute("aria-label", "Survey");
  const thanks = () => {
    wrap.replaceChildren(el("p", "results-survey__text", "Thanks for your feedback!"));
  };
  if (getItem(doneKey)) {
    thanks();
    return wrap;
  }

  const form = el("form", "survey");
  form.noValidate = true;
  form.append(el("p", "results-survey__text", "One last step — please answer this 2-minute survey."));

  meta.survey_questions.forEach((q, i) => {
    const id = `survey-q${i}`;
    if (q.type === "scale") {
      const fs = el("fieldset", "survey__q");
      fs.append(el("legend", "survey__title", q.title));
      const row = el("div", "survey__scale");
      if (q.min_label) row.append(el("span", "survey__end", q.min_label));
      for (let n = q.min; n <= q.max; n++) {
        const label = el("label", "survey__opt");
        const input = el("input");
        input.type = "radio";
        input.name = q.entry;
        input.value = String(n);
        label.append(input, el("span", null, String(n)));
        row.append(label);
      }
      if (q.max_label) row.append(el("span", "survey__end", q.max_label));
      fs.append(row);
      form.append(fs);
    } else {
      const box = el("div", "survey__q");
      const label = el("label", "survey__title", q.title);
      label.htmlFor = id;
      const ta = el("textarea", "survey__text");
      ta.id = id;
      ta.name = q.entry;
      ta.rows = 3;
      ta.maxLength = 2000;
      box.append(label, ta);
      form.append(box);
    }
  });

  const status = el("p", "survey__status");
  status.setAttribute("role", "status");
  const submit = el("button", "dl-btn dl-btn--primary", "Submit survey");
  submit.type = "submit";
  form.append(submit, status);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const answers = {};
    for (const [k, v] of new FormData(form).entries()) answers[k] = v;
    if (!Object.values(answers).some((v) => String(v).trim())) {
      status.textContent = "Please answer at least one question.";
      return;
    }
    submit.disabled = true;
    status.textContent = "Sending…";
    const ok = await submitSurvey(action, buildSurveyBody(meta.survey_prefill, values, answers));
    if (ok) {
      setItem(doneKey, "1");
      thanks();
      announce("Thanks for your feedback!");
    } else {
      submit.disabled = false;
      status.textContent = "Couldn't send. Please check your connection and try again.";
    }
  });

  wrap.append(form);
  return wrap;
}

// Post-assessment survey, embedded (Google Form, prefilled with the learner id +
// variant + score so responses join the results sheet), plus a new-tab fallback.
function surveyBlock(meta, values) {
  if (!meta.survey_url) return null;
  const embedUrl = buildSurveyUrl(meta.survey_url, meta.survey_prefill, values, { embedded: true });
  const url = buildSurveyUrl(meta.survey_url, meta.survey_prefill, values);
  if (!url) return null;

  const wrap = el("aside", "results-survey");
  wrap.setAttribute("aria-label", "Survey");
  wrap.append(
    el("p", "results-survey__text", "One last step — please answer this 2-minute survey.")
  );
  const frame = el("iframe", "results-survey__frame");
  frame.src = embedUrl;
  frame.title = "Assessment survey";
  frame.loading = "lazy";
  wrap.append(frame);

  const a = el("a", "results-survey__link", "Survey not loading? Open it in a new tab");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.append(el("span", "sr-only", " (opens in a new tab)"));
  wrap.append(a);
  return wrap;
}

// "Review by challenge" — anchor links to each challenge's review section (SPEC §3.4).
function reviewNav(challenges) {
  const nav = el("nav", "results-jump");
  nav.setAttribute("aria-label", "Jump to a challenge");
  nav.append(el("span", "results-jump__label", "Review by challenge:"));
  for (const ch of challenges) {
    const a = el("a", "results-jump__link", `Challenge ${ch.challenge_number}`);
    a.setAttribute("href", `#rc-${ch.challenge_number}`);
    nav.append(a);
  }
  return nav;
}

function summaryBlock(r) {
  const wrap = el("section", "results-summary");
  wrap.setAttribute("aria-label", "Score summary");
  wrap.append(
    el("p", "results-summary__score", `${fmt(r.totalEarned)} / ${r.totalPossible} points · ${r.percentage}%`)
  );
  const c = r.counts;
  wrap.append(
    el(
      "p",
      "results-summary__counts",
      `${c.correct} correct · ${c.partial} partial · ${c.incorrect} incorrect · ${c["not-answered"]} not answered`
    )
  );
  const ul = el("ul", "results-summary__challenges");
  for (const ch of r.byChallenge) {
    ul.append(el("li", "", `Challenge ${ch.challenge}: ${fmt(ch.earned)} / ${ch.possible}`));
  }
  wrap.append(ul);
  return wrap;
}

function challengeBlock(ch, r, app) {
  const sec = el("section", "results-challenge");
  sec.id = `rc-${ch.challenge_number}`; // anchor target for the review-nav links
  const h2 = el("h2", "", `Challenge ${ch.challenge_number}`);
  h2.tabIndex = -1; // focusable so the jump link lands focus here
  sec.append(h2);
  if (ch.scenario) sec.append(el("p", "results-challenge__scenario", ch.scenario));
  for (const q of ch.questions) sec.append(questionCard(q, r.byUid.get(q.uid), app));
  return sec;
}

function questionCard(q, res, app) {
  const mod = widgetFor(q.type);
  const o = OUTCOME[res.outcome];

  const card = el("article", `rcard rcard--${res.outcome}`);
  card.append(el("p", "rcard__prompt", q.prompt));

  const outcome = el("p", "rcard__outcome");
  const icon = el("span", "rcard__icon", o.shape);
  icon.setAttribute("aria-hidden", "true");
  outcome.append(icon, el("span", "", `${o.label} — ${fmt(res.earned)} of ${q.points} pt`));
  card.append(outcome);

  card.append(answerList("Your answer", mod.describeAnswer(app.answers.get(q.uid), q)));
  card.append(answerList("Correct answer", mod.describeSolution(q)));
  if (q.behavior) card.append(el("p", "rcard__behavior", `Skill: ${q.behavior}`));
  return card;
}

function answerList(title, lines) {
  const clean = (lines || []).filter((l) => l && String(l).trim());
  const wrap = el("div", "rcard__answer");
  wrap.append(el("p", "rcard__answer-title", title));
  if (!clean.length) {
    wrap.append(el("p", "rcard__answer-empty", "—"));
    return wrap;
  }
  const ul = el("ul", "rcard__answer-list");
  for (const line of clean) ul.append(el("li", "", line));
  wrap.append(ul);
  return wrap;
}
