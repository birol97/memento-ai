"use client";

import { useEffect, useRef, useState } from "react";
import type {
  AskState,
  AutoIntervalSeconds,
  SuggestionMode,
  SuggestionSkill,
  SuggestionState,
} from "@/lib/types";

interface Props {
  suggestions: SuggestionState[];
  asks: AskState[];
  hasHistory: boolean | null;
  /** Whether the WebSocket is currently open and the user can ask. */
  canAsk: boolean;
  onAsk: (prompt: string) => void;
  mode: SuggestionMode;
  autoIntervalSeconds: AutoIntervalSeconds;
  skill: SuggestionSkill;
  onModeChange: (
    mode: SuggestionMode,
    intervalSeconds: AutoIntervalSeconds,
    skill: SuggestionSkill,
  ) => void;
}

const INTERVAL_OPTIONS: { value: AutoIntervalSeconds; label: string }[] = [
  { value: 0, label: "On turn" },
  { value: 60, label: "Every 1 min" },
  { value: 120, label: "Every 2 min" },
  { value: 300, label: "Every 5 min" },
];

const SKILL_OPTIONS: {
  value: SuggestionSkill;
  label: string;
  hint: string;
}[] = [
  { value: "sales", label: "Sales", hint: "Closing, objection handling, next steps" },
  { value: "marketing", label: "Marketing", hint: "Positioning and qualification" },
  { value: "casual", label: "Casual", hint: "Open discovery, no pitch" },
];

export function SuggestionPanel({
  suggestions,
  asks,
  hasHistory,
  canAsk,
  onAsk,
  mode,
  autoIntervalSeconds,
  skill,
  onModeChange,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastSuggestionText = suggestions[suggestions.length - 1]?.text ?? "";
  const lastAsk = asks[asks.length - 1];

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [suggestions.length, lastSuggestionText, asks.length, lastAsk?.text, lastAsk?.status]);

  const [draft, setDraft] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const text = draft.trim();
    if (!text || !canAsk) return;
    onAsk(text);
    setDraft("");
    // Refocus the textarea so the user can keep typing follow-ups.
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const empty = suggestions.length === 0 && asks.length === 0;

  return (
    <div className="suggestion-panel">
      <div className="suggestion-header">
        <span>Copilot</span>
        {hasHistory === true && (
          <span className="suggestion-badge">prior calls loaded</span>
        )}
        {hasHistory === false && (
          <span className="suggestion-badge muted">no prior history</span>
        )}
        <div className="mode-controls">
          <div className="mode-toggle" role="group" aria-label="Suggestion mode">
            <button
              type="button"
              className={mode === "auto" ? "active" : ""}
              onClick={() => onModeChange("auto", autoIntervalSeconds, skill)}
            >
              Auto
            </button>
            <button
              type="button"
              className={mode === "manual" ? "active" : ""}
              onClick={() => onModeChange("manual", autoIntervalSeconds, skill)}
            >
              Manual
            </button>
          </div>
          <select
            className="mode-interval"
            value={autoIntervalSeconds}
            disabled={mode !== "auto"}
            aria-label="Auto-suggestion cadence"
            onChange={(e) =>
              onModeChange(
                mode,
                Number(e.target.value) as AutoIntervalSeconds,
                skill,
              )
            }
          >
            {INTERVAL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <div className="skill-toggle" role="group" aria-label="Copilot skill">
            {SKILL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={skill === opt.value ? "active" : ""}
                title={opt.hint}
                onClick={() => onModeChange(mode, autoIntervalSeconds, opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="suggestion-list" ref={scrollRef}>
        {empty && (
          <div className="suggestion-empty">
            {mode === "auto" ? (
              <>
                Auto-suggestions will appear here{" "}
                {autoIntervalSeconds === 0
                  ? "after each turn from the prospect."
                  : `at most every ${autoIntervalSeconds / 60} min.`}
                <br />
                Or type a question below to ask the copilot anything.
              </>
            ) : (
              <>
                Manual mode — type a question below and the copilot will answer.
                <br />
                Switch to Auto for hands-free suggestions.
              </>
            )}
          </div>
        )}

        {suggestions.map((s) => (
          <div
            key={`s-${s.turnId}`}
            className={`suggestion ${s.status === "streaming" ? "streaming" : "done"}`}
          >
            <div className="suggestion-meta">auto · turn #{s.turnId}</div>
            <div className="suggestion-text">
              {s.text || <em>thinking…</em>}
              {s.status === "streaming" && <span className="cursor" />}
            </div>
          </div>
        ))}

        {asks.map((a) => (
          <div key={`a-${a.askId}`} className="ask-thread">
            <div className="ask-bubble user">
              <div className="ask-meta">you asked</div>
              <div className="ask-text">{a.prompt}</div>
            </div>
            <div className={`ask-bubble copilot ${a.status}`}>
              <div className="ask-meta">copilot</div>
              <div className="ask-text">
                {a.text || (a.status === "error" ? <em>(error)</em> : <em>thinking…</em>)}
                {a.status === "streaming" && <span className="cursor" />}
              </div>
            </div>
          </div>
        ))}
      </div>

      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          placeholder={
            canAsk
              ? "Ask the copilot something — Enter to send, Shift+Enter for newline"
              : "Start a session to ask the copilot…"
          }
          rows={2}
          disabled={!canAsk}
        />
        <button
          type="submit"
          className="btn-primary"
          disabled={!canAsk || !draft.trim()}
        >
          Ask
        </button>
      </form>
    </div>
  );
}
