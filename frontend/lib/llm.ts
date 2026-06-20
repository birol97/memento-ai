// Unified LLM access. Provider precedence (first configured wins):
//   1. OpenRouter  — OPENROUTER_API_KEY (OpenAI-compatible gateway; hosted, no local dep)
//   2. Anthropic   — ANTHROPIC_API_KEY
//   3. Ollama      — local fallback
// Switching is just an env var; no code change.
//
//   OPENROUTER_API_KEY  — from openrouter.ai (server-only)
//   OPENROUTER_MODEL    — e.g. "anthropic/claude-sonnet-4" (defaults below)
//   ANTHROPIC_API_KEY / ANTHROPIC_MODEL
//   OLLAMA_BASE_URL / OLLAMA_MODEL
import Anthropic from "@anthropic-ai/sdk";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "~anthropic/claude-sonnet-latest";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
const OLLAMA = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return _client;
}

export function llmLabel(): string {
  return OPENROUTER_KEY ? OPENROUTER_MODEL : ANTHROPIC_KEY ? ANTHROPIC_MODEL : OLLAMA_MODEL;
}

// ── OpenRouter (OpenAI-compatible chat completions) ──
function orHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    Authorization: `Bearer ${OPENROUTER_KEY}`,
    "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "https://memento.ai",
    "X-Title": "Memento AI",
  };
}

async function openrouterGenerate(prompt: string, json: boolean, system?: string, maxTokens = 1024): Promise<string> {
  const messages: { role: string; content: string }[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: json ? `${prompt}\n\nReturn ONLY valid JSON — no prose, no markdown fences.` : prompt });
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: orHeaders(),
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages, max_tokens: maxTokens, temperature: 0.2 }),
  });
  if (!res.ok) throw new Error(`openrouter HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  const text: string = j.choices?.[0]?.message?.content ?? "";
  return json ? stripFence(text) : text.trim();
}

function stripFence(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1].trim() : t;
}

export type LlmMsg = { role: "user" | "assistant"; content: string };

async function ollamaGenerate(prompt: string, json: boolean, system?: string): Promise<string> {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: system ? `${system}\n\n${prompt}` : prompt,
      stream: false,
      ...(json ? { format: "json" } : {}),
      options: { temperature: 0.2 },
    }),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const j = await res.json();
  return (j.response || "").trim();
}

/** One-shot generation. `json: true` asks for (and unwraps) a JSON object.
 * Uses Claude when keyed; on ANY Claude failure (no credits, rate limit, bad
 * key) it transparently falls back to the local Ollama model. */
export async function llmGenerate(
  prompt: string,
  opts: { json?: boolean; system?: string; maxTokens?: number } = {},
): Promise<string> {
  const { json = false, system, maxTokens = 1024 } = opts;

  if (OPENROUTER_KEY) {
    try {
      return await openrouterGenerate(prompt, json, system, maxTokens);
    } catch (e) {
      console.warn("[llm] OpenRouter failed, trying next provider:", e instanceof Error ? e.message : e);
    }
  }

  if (ANTHROPIC_KEY) {
    try {
      const userContent = json
        ? `${prompt}\n\nReturn ONLY valid JSON — no prose, no markdown fences.`
        : prompt;
      const msg = await client().messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: userContent }],
      });
      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return json ? stripFence(text) : text.trim();
    } catch (e) {
      console.warn("[llm] Claude failed, falling back to Ollama:", e instanceof Error ? e.message : e);
    }
  }
  return ollamaGenerate(prompt, json, system);
}

/** Streaming chat → a ReadableStream of UTF-8 text chunks (for the copilot). */
export function llmStream(
  system: string,
  messages: LlmMsg[],
  opts: { maxTokens?: number } = {},
): ReadableStream<Uint8Array> {
  const { maxTokens = 1500 } = opts;
  const enc = new TextEncoder();

  if (OPENROUTER_KEY) {
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const upstream = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
            method: "POST",
            headers: orHeaders(),
            body: JSON.stringify({
              model: OPENROUTER_MODEL,
              stream: true,
              max_tokens: maxTokens,
              messages: [{ role: "system", content: system }, ...messages],
            }),
          });
          if (!upstream.ok || !upstream.body) throw new Error(`openrouter HTTP ${upstream.status}`);
          const reader = upstream.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (data === "[DONE]") continue;
              try {
                const tok = JSON.parse(data)?.choices?.[0]?.delta?.content;
                if (tok) controller.enqueue(enc.encode(tok));
              } catch { /* skip partial */ }
            }
          }
        } catch (e) {
          controller.enqueue(enc.encode(`\n[AI error: ${e instanceof Error ? e.message : "stream failed"}]`));
        } finally {
          controller.close();
        }
      },
    });
  }

  if (ANTHROPIC_KEY) {
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const stream = client().messages.stream({
            model: ANTHROPIC_MODEL,
            max_tokens: maxTokens,
            system,
            messages,
          });
          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              controller.enqueue(enc.encode(event.delta.text));
            }
          }
        } catch (e) {
          controller.enqueue(enc.encode(`\n[AI error: ${e instanceof Error ? e.message : "stream failed"}]`));
        } finally {
          controller.close();
        }
      },
    });
  }

  // Ollama fallback (NDJSON → text)
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const upstream = await fetch(`${OLLAMA}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            stream: true,
            messages: [{ role: "system", content: system }, ...messages],
          }),
        });
        if (!upstream.ok || !upstream.body) {
          controller.close();
          return;
        }
        const reader = upstream.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const tok = JSON.parse(line)?.message?.content;
              if (tok) controller.enqueue(enc.encode(tok));
            } catch {
              /* skip partial line */
            }
          }
        }
      } finally {
        controller.close();
      }
    },
  });
}
