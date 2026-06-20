// "My knowledge base" — the rep/org playbook the AI should use when advising:
// products, pitch angles, objection handling, policies. Stored per-device for now
// (localStorage), mirroring lib/character.ts; swap for a backend per-org store later.
// It's injected into the copilot + live-advisor prompts so advice reflects YOUR
// knowledge, not just the model's general training.

const KEY = "salescall.knowledgeBase";

export function loadKnowledge(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveKnowledge(text: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, text);
  } catch {
    /* ignore */
  }
}
