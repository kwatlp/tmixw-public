import React, { useCallback, useEffect, useMemo, useState } from "react";
import "../styles/wizard.css";
import "../styles/forge.css";

/**
 * App-owned character creation wizard (design doc 01). Mounted after a template
 * carrying a character_creation.json is applied to a fresh world. Renders the
 * spec's steps, validates client-side for responsiveness (core re-validates
 * authoritatively on submit), previews derived stats live over IPC, grades the
 * freeform Unique Power, and writes the structured sheet via characterCreate.
 *
 * The narrator is out of the loop here — nothing is rolled or invented; every
 * value is a player choice. On success the world's opening narration confirms
 * the finished sheet rather than fabricating one.
 */
export default function CharacterForge({ spec, onDone }) {
  const steps = spec?.steps ?? [];
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [graded, setGraded] = useState({}); // fieldId -> graded object
  const [gradingId, setGradingId] = useState("");
  const [preview, setPreview] = useState(null); // { stats, derived, resources }
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const reviewing = stepIndex >= steps.length;
  const step = steps[stepIndex];

  const set = useCallback((id, value) => {
    setAnswers((a) => ({ ...a, [id]: value }));
  }, []);

  // Live derived/stat preview — refreshed whenever a stat or option changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await window.api.characterPreview(answers, graded);
        if (!cancelled && p?.ok) setPreview(p);
      } catch {
        /* preview is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [answers, graded]);

  const stepValid = useMemo(() => (step ? isStepValid(step, answers) : true), [step, answers]);

  const next = useCallback(() => {
    setError("");
    setStepIndex((i) => Math.min(i + 1, steps.length));
  }, [steps.length]);
  const back = useCallback(() => {
    setError("");
    setStepIndex((i) => Math.max(0, i - 1));
  }, []);

  const grade = useCallback(
    async (field) => {
      setGradingId(field.id);
      setError("");
      try {
        const r = await window.api.characterGradeField(field.id, answers[field.id] ?? "");
        if (r?.ok) setGraded((g) => ({ ...g, [field.id]: r.graded }));
        else setError(r?.error || "Could not grade that.");
      } catch (e) {
        setError(String(e?.message ?? e));
      } finally {
        setGradingId("");
      }
    },
    [answers]
  );

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError("");
    try {
      const r = await window.api.characterCreate(answers, graded);
      if (r?.ok) {
        onDone?.(r.character);
        return;
      }
      setError(r?.errors?.length ? r.errors.join(" · ") : r?.error || "Could not create the character.");
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  }, [answers, graded, onDone]);

  if (steps.length === 0) {
    // No usable spec — don't strand the player; hand straight to the world.
    onDone?.(null);
    return null;
  }

  return (
    <div className="wizard-root forge-root" role="dialog" aria-label="Create your character">
      <div className="wizard-inner">
        <section className="wizard-panel forge-panel">
          <p className="wizard-kicker">{spec.title || "Character Forge"}</p>

          {reviewing ? (
            <ReviewScreen spec={spec} answers={answers} graded={graded} preview={preview} />
          ) : (
            <>
              <h2 className="wizard-title">{step.title || step.id}</h2>
              {stepIndex === 0 && spec.intro ? <p className="wizard-copy">{spec.intro}</p> : null}
              <div className="forge-fields">
                {(step.fields ?? []).map((f) => (
                  <Field
                    key={f.id}
                    field={f}
                    value={answers[f.id]}
                    answers={answers}
                    setAnswer={set}
                    preview={preview}
                    graded={graded[f.id]}
                    grading={gradingId === f.id}
                    onGrade={() => grade(f)}
                  />
                ))}
              </div>
            </>
          )}

          {error ? <p className="wizard-error">{error}</p> : null}

          <div className="wizard-actions forge-actions">
            <span className="forge-progress wizard-muted">
              {reviewing ? "Review" : `Step ${stepIndex + 1} of ${steps.length}`}
            </span>
            <div className="forge-action-buttons">
              {stepIndex > 0 ? (
                <button type="button" className="wizard-secondary" onClick={back} disabled={submitting}>
                  Back
                </button>
              ) : null}
              {reviewing ? (
                <button type="button" className="wizard-primary" onClick={submit} disabled={submitting}>
                  {submitting ? "Creating…" : "Enter the world"}
                </button>
              ) : (
                <button type="button" className="wizard-primary" onClick={next} disabled={!stepValid}>
                  Next
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

// --- field dispatch ---------------------------------------------------------

function Field({ field, value, answers, setAnswer, preview, graded, grading, onGrade }) {
  switch (field.type) {
    case "text":
      return (
        <label className="forge-field">
          <span className="wizard-label">{field.label || field.id}{field.required ? " *" : ""}</span>
          <input
            className="forge-input"
            type="text"
            maxLength={field.maxLen || undefined}
            value={value ?? ""}
            onChange={(e) => setAnswer(field.id, e.target.value)}
          />
        </label>
      );
    case "longtext":
      return (
        <label className="forge-field">
          <span className="wizard-label">{field.label || field.id}{field.required ? " *" : ""}</span>
          <textarea
            className="forge-input forge-textarea"
            maxLength={field.maxLen || undefined}
            rows={3}
            value={value ?? ""}
            onChange={(e) => setAnswer(field.id, e.target.value)}
          />
        </label>
      );
    case "single-select":
      return <SingleSelect field={field} value={value} answers={answers} setAnswer={setAnswer} />;
    case "multi-select":
      return <MultiSelect field={field} value={value} setAnswer={setAnswer} />;
    case "point-buy":
      return <PointBuy field={field} value={value} setAnswer={setAnswer} preview={preview} />;
    case "freeform-graded":
      return (
        <Freeform
          field={field}
          value={value}
          setAnswer={setAnswer}
          graded={graded}
          grading={grading}
          onGrade={onGrade}
        />
      );
    default:
      return null;
  }
}

function SingleSelect({ field, value, answers, setAnswer }) {
  const chosen = (field.options ?? []).find((o) => o.id === value);
  return (
    <div className="forge-field">
      <span className="wizard-label">{field.label || field.id}{field.required ? " *" : ""}</span>
      <div className="forge-options">
        {(field.options ?? []).map((o) => (
          <button
            key={o.id}
            type="button"
            className={value === o.id ? "forge-option selected" : "forge-option"}
            aria-pressed={value === o.id}
            onClick={() => setAnswer(field.id, o.id)}
          >
            <span className="forge-option-name">{o.label || o.id}</span>
            {o.summary ? <span className="forge-option-summary">{o.summary}</span> : null}
          </button>
        ))}
      </div>

      {chosen && Array.isArray(chosen.subtypes) && chosen.subtypes.length > 0 ? (
        <SubPicker
          label="Subtype"
          options={chosen.subtypes.map((s) => ({ id: s.id, label: s.label || s.id }))}
          value={answers[`${field.id}__subtype`]}
          onPick={(v) => setAnswer(`${field.id}__subtype`, v)}
        />
      ) : null}

      {chosen?.effects?.statChoice ? (
        <StatChoice
          rule={chosen.effects.statChoice}
          allStats={["STR", "AGI", "CON", "INT", "CHA", "WIL"]}
          value={answers[`${field.id}__statChoice`] ?? []}
          onChange={(v) => setAnswer(`${field.id}__statChoice`, v)}
        />
      ) : null}
      {chosen?.effects?.statChoiceSecondary ? (
        <StatChoice
          rule={chosen.effects.statChoiceSecondary}
          allStats={["STR", "AGI", "CON", "INT", "CHA", "WIL"]}
          value={answers[`${field.id}__statChoiceSecondary`] ?? []}
          onChange={(v) => setAnswer(`${field.id}__statChoiceSecondary`, v)}
        />
      ) : null}
      {chosen?.effects?.skillChoice ? (
        <SubPicker
          label="Skill"
          options={(chosen.effects.skillChoice.from ?? []).map((s) => ({ id: s, label: s }))}
          value={answers[`${field.id}__skillChoice`]}
          onPick={(v) => setAnswer(`${field.id}__skillChoice`, v)}
        />
      ) : null}
    </div>
  );
}

function SubPicker({ label, options, value, onPick }) {
  return (
    <div className="forge-subpicker">
      <span className="forge-sublabel">{label}</span>
      <div className="forge-chips">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={value === o.id ? "forge-chip selected" : "forge-chip"}
            onClick={() => onPick(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function StatChoice({ rule, allStats, value, onChange }) {
  const pool = Array.isArray(rule.from) ? rule.from : allStats;
  const count = Number.isInteger(rule.count) ? rule.count : 1;
  const toggle = (s) => {
    const has = value.includes(s);
    if (has) onChange(value.filter((x) => x !== s));
    else if (value.length < count) onChange([...value, s]);
  };
  return (
    <div className="forge-subpicker">
      <span className="forge-sublabel">
        Bonus +{rule.amount} — choose {count}
      </span>
      <div className="forge-chips">
        {pool.map((s) => (
          <button
            key={s}
            type="button"
            className={value.includes(s) ? "forge-chip selected" : "forge-chip"}
            onClick={() => toggle(s)}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function MultiSelect({ field, value, setAnswer }) {
  const sel = Array.isArray(value) ? value : [];
  const toggle = (opt) => {
    if (sel.includes(opt)) setAnswer(field.id, sel.filter((x) => x !== opt));
    else if (sel.length < field.count) setAnswer(field.id, [...sel, opt]);
  };
  return (
    <div className="forge-field">
      <span className="wizard-label">
        {field.label || field.id} ({sel.length}/{field.count})
      </span>
      <div className="forge-chips">
        {(field.options ?? []).map((opt) => (
          <button
            key={opt}
            type="button"
            className={sel.includes(opt) ? "forge-chip selected" : "forge-chip"}
            onClick={() => toggle(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

function PointBuy({ field, value, setAnswer, preview }) {
  const stats = field.stats ?? [];
  const min = Number.isInteger(field.min) ? field.min : 0;
  const max = Number.isInteger(field.max) ? field.max : 99;
  const vals = value && typeof value === "object" ? value : Object.fromEntries(stats.map((s) => [s, min]));
  const spent = stats.reduce((sum, s) => sum + (Number(vals[s]) || 0), 0);
  const remaining = field.pool - spent;

  const bump = (s, delta) => {
    const cur = Number(vals[s]) || 0;
    const nextVal = cur + delta;
    if (nextVal < min || nextVal > max) return;
    if (delta > 0 && remaining <= 0) return;
    setAnswer(field.id, { ...vals, [s]: nextVal });
  };

  // Seed the answer object on first render so validation/preview have a value.
  useEffect(() => {
    if (!value) setAnswer(field.id, Object.fromEntries(stats.map((s) => [s, min])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="forge-field">
      <div className="forge-pointbuy-head">
        <span className="wizard-label">{field.label || "Allocate points"}</span>
        <span className={remaining === 0 ? "forge-pool ok" : "forge-pool"}>
          {remaining} point{remaining === 1 ? "" : "s"} left
        </span>
      </div>
      <div className="forge-stat-grid">
        {stats.map((s) => (
          <div key={s} className="forge-stat-row">
            <span className="forge-stat-name">{s}</span>
            <div className="forge-stepper">
              <button type="button" onClick={() => bump(s, -1)} aria-label={`decrease ${s}`}>
                −
              </button>
              <span className="forge-stat-val">{Number(vals[s]) || 0}</span>
              <button type="button" onClick={() => bump(s, 1)} aria-label={`increase ${s}`}>
                +
              </button>
            </div>
          </div>
        ))}
      </div>
      {preview?.derived ? <DerivedPreview derived={preview.derived} /> : null}
    </div>
  );
}

function DerivedPreview({ derived }) {
  return (
    <div className="forge-derived">
      {Object.entries(derived).map(([k, v]) => (
        <span key={k} className="forge-derived-item">
          <span className="forge-derived-key">{k}</span>
          <span className="forge-derived-val">{v}</span>
        </span>
      ))}
    </div>
  );
}

function Freeform({ field, value, setAnswer, graded, grading, onGrade }) {
  return (
    <div className="forge-field">
      <span className="wizard-label">{field.label || field.id}{field.required ? " *" : ""}</span>
      <textarea
        className="forge-input forge-textarea"
        rows={3}
        maxLength={field.maxLen || undefined}
        value={value ?? ""}
        onChange={(e) => setAnswer(field.id, e.target.value)}
        placeholder="Describe it in your own words…"
      />
      <div className="forge-grade-row">
        <button
          type="button"
          className="wizard-secondary"
          onClick={onGrade}
          disabled={grading || !String(value ?? "").trim()}
        >
          {grading ? "Grading…" : graded ? "Re-grade" : "Grade my idea"}
        </button>
      </div>
      {graded ? (
        <div className="forge-grade-card">
          <div className="forge-grade-name">
            {graded.name}
            {graded.graded === false ? <span className="forge-grade-tag">offline draft</span> : null}
          </div>
          {graded.reliable ? <p className="forge-grade-line"><b>Reliable:</b> {graded.reliable}</p> : null}
          {graded.stretch ? <p className="forge-grade-line"><b>Stretch:</b> {graded.stretch}</p> : null}
          {graded.cost ? <p className="forge-grade-line"><b>Cost:</b> {graded.cost}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function ReviewScreen({ spec, answers, graded, preview }) {
  const label = (fieldId, optId) => {
    for (const step of spec.steps ?? []) {
      for (const f of step.fields ?? []) {
        if (f.id === fieldId) {
          const o = (f.options ?? []).find((x) => x.id === optId);
          return o?.label || optId;
        }
      }
    }
    return optId;
  };
  return (
    <div className="forge-review">
      <h2 className="wizard-title">{answers.name || "Your character"}</h2>
      <p className="wizard-copy">Confirm your sheet. Nothing here was rolled for you.</p>
      <div className="forge-review-grid">
        {answers.race ? <Row k="Bloodline" v={label("race", answers.race)} /> : null}
        {answers.origin ? <Row k="Origin" v={label("origin", answers.origin)} /> : null}
        {preview?.stats ? (
          <Row k="Stats" v={Object.entries(preview.stats).map(([s, n]) => `${s} ${n}`).join("  ")} />
        ) : null}
        {Array.isArray(answers.skills) ? <Row k="Skills" v={answers.skills.join(", ")} /> : null}
        {graded.unique_power ? <Row k="Unique Power" v={graded.unique_power.name} /> : null}
      </div>
      {preview?.derived ? <DerivedPreview derived={preview.derived} /> : null}
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="forge-review-row">
      <span className="forge-review-key">{k}</span>
      <span className="forge-review-val">{v}</span>
    </div>
  );
}

// --- light client-side step validation (core is authoritative on submit) ----

function isStepValid(step, answers) {
  for (const f of step.fields ?? []) {
    const v = answers[f.id];
    if (f.type === "text" || f.type === "longtext" || f.type === "freeform-graded") {
      if (f.required && !String(v ?? "").trim()) return false;
    } else if (f.type === "single-select") {
      if (f.required && !v) return false;
      const opt = (f.options ?? []).find((o) => o.id === v);
      if (opt) {
        if (Array.isArray(opt.subtypes) && opt.subtypes.length > 0 && !answers[`${f.id}__subtype`]) return false;
        if (opt.effects?.statChoice) {
          const need = opt.effects.statChoice.count ?? 1;
          if ((answers[`${f.id}__statChoice`] ?? []).length !== need) return false;
        }
        if (opt.effects?.skillChoice && !answers[`${f.id}__skillChoice`]) return false;
      }
    } else if (f.type === "multi-select") {
      if ((Array.isArray(v) ? v.length : 0) !== f.count) return false;
    } else if (f.type === "point-buy") {
      const vals = v && typeof v === "object" ? v : {};
      const spent = (f.stats ?? []).reduce((s, k) => s + (Number(vals[k]) || 0), 0);
      if (f.spendAllRequired !== false && spent !== f.pool) return false;
    }
  }
  return true;
}
