// Shared commitment extraction — used by the /api/client-commitments route AND
// the Scanner agent. A commitment = an action + a resolvable future date.
import { llmGenerate } from "@/lib/llm";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const iso = (d: Date) => d.toISOString().slice(0, 10);

export type CommitEvent = { at?: string; text?: string };
export type Commitment = { source_index: number; what: string; due: string; due_iso: string | null };

/** Resolve a stated deadline ("30 January", "next Tuesday", "by March") to an
 * absolute future date relative to when it was said. Deterministic. */
export function resolveDue(due: string, refDate: Date): string | null {
  const s = due.toLowerCase().trim();
  const dm = s.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s*(?:of\s+)?([a-z]+)/) || s.match(/([a-z]+)\s+(\d{1,2})/);
  if (dm) {
    const mi = MONTHS.findIndex((m) => (dm[2] && isNaN(Number(dm[2])) ? dm[2] : dm[1]).startsWith(m.slice(0, 3)));
    const day = Number(/^\d/.test(dm[1]) ? dm[1] : dm[2]);
    if (mi >= 0 && day >= 1 && day <= 31) {
      let y = refDate.getUTCFullYear();
      let cand = new Date(Date.UTC(y, mi, day));
      if (cand <= refDate) cand = new Date(Date.UTC(++y, mi, day));
      return iso(cand);
    }
  }
  const wd = WEEKDAYS.findIndex((w) => s.includes(w));
  if (wd >= 0) {
    const cand = new Date(refDate);
    let add = (wd - refDate.getUTCDay() + 7) % 7;
    if (add === 0) add = 7;
    cand.setUTCDate(cand.getUTCDate() + add);
    return iso(cand);
  }
  const monthOnly = MONTHS.findIndex((m) => s.includes(m));
  if (monthOnly >= 0) {
    let y = refDate.getUTCFullYear();
    let cand = new Date(Date.UTC(y, monthOnly, 1));
    if (cand <= refDate) cand = new Date(Date.UTC(++y, monthOnly, 1));
    return iso(cand);
  }
  return null;
}

/** Extract dated commitments from a customer's captured records (LLM + resolver). */
export async function extractCommitments(events: CommitEvent[]): Promise<Commitment[]> {
  const rows = events.map((e, i) => ({ i, at: (e.at || "").slice(0, 10), text: (e.text || "").trim() })).filter((e) => e.text);
  if (!rows.length) return [];
  const prompt =
    "From these dated records, extract every COMMITMENT or DEADLINE that references a " +
    "specific date or timeframe — payment promises, meetings, follow-ups, renewals, deliveries.\n" +
    "For each, return an object with:\n" +
    "  source_index  — the #index of the record it came from\n" +
    "  what          — short label, e.g. \"Will pay\", \"Meeting\", \"Renewal\"\n" +
    "  due           — the deadline AS STATED, e.g. \"30 January\", \"next Tuesday\"\n" +
    "  due_iso       — resolve `due` to an absolute YYYY-MM-DD, future relative to the record's " +
    "'recorded' date (next occurrence if year missing); null if unresolvable\n" +
    "Only include items that genuinely reference a date/deadline. Ground strictly in the text. " +
    "Return ONLY JSON: {\"commitments\":[ ... ]}.\n\nRECORDS:\n" +
    rows.map((r) => `#${r.i} (recorded ${r.at || "?"}): ${r.text.slice(0, 300)}`).join("\n");

  try {
    const raw = await llmGenerate(prompt, { json: true, maxTokens: 700 });
    const parsed = JSON.parse(raw || "{}");
    const arr = Array.isArray(parsed.commitments) ? parsed.commitments : [];
    return arr
      .map((c: Record<string, unknown>) => {
        const source_index = Number(c.source_index);
        const due = typeof c.due === "string" ? c.due : "";
        let due_iso = typeof c.due_iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.due_iso) ? c.due_iso : null;
        if (!due_iso && due) {
          const refRaw = events[source_index]?.at;
          const ref = refRaw ? new Date(refRaw) : null;
          if (ref && !isNaN(ref.getTime())) due_iso = resolveDue(due, ref);
        }
        return { source_index, what: typeof c.what === "string" ? c.what : "", due, due_iso };
      })
      .filter((c: Commitment) => c.what && c.due);
  } catch {
    return [];
  }
}
