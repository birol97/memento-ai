// The AI copilot's "character": a persona + which tools it's allowed to use.
// Stored in the browser for now (per-device); swap loadCharacter/saveCharacter for
// a backend per-org call later. The persona + tool policy are injected into the
// copilot's system prompt so the user controls how the agent behaves.

export type ToolKey = "recall" | "recommend" | "email" | "sms" | "call" | "note";

export const TOOLS: { key: ToolKey; label: string; desc: string }[] = [
  { key: "recall", label: "Recall memory", desc: "Ground answers in the customer's stored memory." },
  { key: "recommend", label: "Recommend products", desc: "Propose specific products / investments that fit the profile." },
  { key: "email", label: "Draft email", desc: "Compose email messages." },
  { key: "sms", label: "Draft SMS", desc: "Compose short text messages." },
  { key: "call", label: "Script a call", desc: "Suggest a phone-call script / talking points." },
  { key: "note", label: "Suggest notes", desc: "Propose internal notes to save about the customer." },
];

export type Character = {
  name: string;
  persona: string;
  tools: Record<ToolKey, boolean>;
};

export const DEFAULT_CHARACTER: Character = {
  name: "Sales Copilot",
  persona:
    "A sharp, concise relationship copilot. Friendly and professional, never pushy. "
    + "Tailors everything to the customer's profile and respects what they want to avoid.",
  tools: { recall: true, recommend: true, email: true, sms: true, call: true, note: true },
};

const KEY = "salescall.character";

export function loadCharacter(): Character {
  if (typeof window === "undefined") return DEFAULT_CHARACTER;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_CHARACTER;
    const c = JSON.parse(raw) as Partial<Character>;
    return {
      name: c.name || DEFAULT_CHARACTER.name,
      persona: c.persona ?? DEFAULT_CHARACTER.persona,
      tools: { ...DEFAULT_CHARACTER.tools, ...(c.tools || {}) },
    };
  } catch {
    return DEFAULT_CHARACTER;
  }
}

export function saveCharacter(c: Character): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

/** Build the persona + tool-policy instruction injected into the copilot prompt. */
export function characterPrompt(c: Character): string {
  const on = TOOLS.filter((t) => c.tools[t.key]).map((t) => t.label);
  const off = TOOLS.filter((t) => !c.tools[t.key]).map((t) => t.label);
  return (
    `You are "${c.name}". ${c.persona}\n`
    + `TOOLS YOU MAY USE: ${on.length ? on.join(", ") : "none"}.\n`
    + (off.length ? `DO NOT use or offer: ${off.join(", ")}.` : "")
  );
}
