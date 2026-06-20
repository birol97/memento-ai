"""Streaming copilot — local Ollama only.

On each committed turn we:
  1. Build a prompt = system + prior-call summaries + last full transcript
     + current session's turns.
  2. Stream tokens from Ollama's ``/api/chat`` back to the websocket.
  3. Persist the final concatenated suggestion in the suggestions table.

The "history context" is recomputed once per session (in ``build_history_block``)
and reused across turns. Per-turn we only re-render the live current-session
transcript.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional

import httpx

from app.core.config import get_settings
from app.core.logger import get_logger

log = get_logger(__name__)


def _extract_json_array(text: str) -> List[Dict[str, Any]]:
    """Best-effort parse of a JSON array from an LLM response.

    Local models often wrap JSON in prose or ```json fences, so we slice from
    the first '[' to the last ']' before parsing. Returns [] on any failure.
    """
    if not text:
        return []
    try:
        start = text.index("[")
        end = text.rindex("]")
    except ValueError:
        return []
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


@dataclass
class LLMResult:
    """Model response plus exactly what we sent to get it.

    `system_prompt` is the full system content (base instructions + history
    block). `prompt` is the user-message we sent. Stored on the suggestion
    row so we can replay or inspect later.
    """
    text: str
    prompt: str
    system_prompt: str


Skill = str  # one of: "sales" | "marketing" | "casual"

VALID_SKILLS: tuple[str, ...] = ("sales", "marketing", "casual")
DEFAULT_SKILL: Skill = "sales"


_GROUNDING_RULE = (
    "GROUNDING: the transcript labels each turn as YOU (the rep using this "
    "tool) or PROSPECT (the person on the other end). Suggest the next "
    "thing YOU should say in response to what the PROSPECT just said. "
    "Reference specifics from PROSPECT lines. If the transcript is empty "
    "or only has YOU lines so far, suggest one short open question to "
    "draw the prospect out — do NOT fall back to a generic sales-meeting "
    "closer like 'what topics do you want to cover next call'."
)


# System prompts used when the copilot fires automatically on each
# committed prospect turn. The rep needs ONE concrete utterance they can
# read aloud — no preface, no explanation.
SUGGEST_PROMPTS: dict[Skill, str] = {
    "sales": (
        "You are a real-time SALES copilot for a B2B rep on a live call. "
        "On each new turn from the prospect, propose ONE 1–3 sentence next "
        "utterance the rep should say. Be specific and tactical. Drive "
        "toward qualification, pain discovery, value framing, or a clear "
        "next step. If the prospect asked a question, answer it concisely. "
        "If they raised an objection, rebut it. Do not greet, do not "
        "preface — just the suggested utterance the rep can read aloud. "
        f"{_GROUNDING_RULE}"
    ),
    "marketing": (
        "You are a real-time MARKETING copilot for a rep on a live call. "
        "Goal: position the product and qualify fit. On each new turn, "
        "propose ONE 1–3 sentence utterance that frames value, surfaces "
        "use-cases relevant to what the prospect just said, or asks a "
        "qualifying question (segment, role, current solution, budget "
        "signal). Be concrete; cite specifics from the transcript. No "
        "filler, no preface — just the words to say. "
        f"{_GROUNDING_RULE}"
    ),
    "casual": (
        "You are a CASUAL conversation copilot. The rep is having an "
        "open-ended discovery / relationship chat — not selling. On each "
        "new turn, propose ONE 1–3 sentence natural follow-up: a curious "
        "question, a brief acknowledgement, or a related observation that "
        "keeps the conversation flowing. Avoid sales language, avoid "
        "pitches, avoid CTAs. No preface — just the words. "
        f"{_GROUNDING_RULE}"
    ),
}


# System prompts used when the rep types a free-text question to the
# copilot mid-call. Same skills, but the rep is reading while talking,
# so we allow up to ~6 sentences and explicit "say this" quotes.
ASK_PROMPTS: dict[Skill, str] = {
    "sales": (
        "You are a real-time SALES copilot for a B2B rep. The rep is "
        "currently on a call and just typed a question to you. You have: "
        "(a) prior conversations with this client (if any), and (b) the "
        "current call transcript so far. Answer concisely, tactically, "
        "and grounded in what the prospect actually said. If the rep asks "
        "for words to say, give them in quotes. No filler ('great "
        "question', 'as a copilot…'). Keep under 6 sentences."
    ),
    "marketing": (
        "You are a real-time MARKETING copilot. The rep typed a question "
        "mid-call. You have prior history and the live transcript. Answer "
        "with positioning, qualification framing, or competitive context "
        "— grounded in this prospect's actual words. If asked for words "
        "to say, quote them. Under 6 sentences. No filler."
    ),
    "casual": (
        "You are a CASUAL conversation copilot. The rep typed a question "
        "during an open-ended chat (not a sales pitch). Answer naturally, "
        "grounded in what the other person said. Suggest light follow-ups "
        "or context, not pitches. If asked for words, quote them. Under 6 "
        "sentences."
    ),
}


def coerce_skill(value: object, default: Skill = DEFAULT_SKILL) -> Skill:
    """Validate a skill string from a control frame; fall back to default."""
    if isinstance(value, str) and value in VALID_SKILLS:
        return value
    return default


def build_history_block(
    history: Dict[str, Any],
    *,
    client: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """Render the static per-client prompt block.

    Combines (a) the rep-authored client profile + objective, (b) earlier
    call summaries, and (c) the full transcript of the most recent call.
    Any of those may be absent — the block is built from whatever's
    available, and we return None only when the block would be empty.
    """
    summaries = history.get("summaries") or []
    last_call = history.get("last_call")
    profile = (client or {}).get("profile")
    objective = (client or {}).get("objective")
    role = (client or {}).get("role")
    deal_stage = (client or {}).get("deal_stage")
    notes = (client or {}).get("notes")
    relationship = (client or {}).get("relationship")

    has_profile = any(
        (v or "").strip()
        for v in (profile, objective, role, deal_stage, notes, relationship)
    )
    if not summaries and not last_call and not has_profile:
        return None

    lines: List[str] = []

    if has_profile:
        name = (client or {}).get("name") or "this client"
        lines.append(f"# Who you're talking to: {name}")
        if relationship and relationship.strip():
            lines.append(
                f"- Your relationship with them: {relationship.strip()}. "
                "Tailor your advice to fit this relationship — match the right "
                "tone, goal, and formality (e.g. a colleague or friend is not a "
                "sales prospect; an expert is someone helping YOU, so help you "
                "ask good questions and follow their guidance)."
            )
        if role and role.strip():
            lines.append(f"- Role: {role.strip()}")
        if deal_stage and deal_stage.strip():
            lines.append(f"- Stage: {deal_stage.strip()}")
        if profile and profile.strip():
            lines.append(f"\n## Profile\n{profile.strip()}")
        if objective and objective.strip():
            lines.append(f"\n## Our objective with them\n{objective.strip()}")
        if notes and notes.strip():
            lines.append(f"\n## Rep notes\n{notes.strip()}")

    if summaries or last_call:
        if lines:
            lines.append("")
        lines.append("# Prior conversations with this client")

    if summaries:
        lines.append("\n## Earlier call summaries (oldest → newest)")
        for s in summaries:
            lines.append(f"- [{s['started_at']}] {s['summary']}")

    if last_call and last_call.get("turns"):
        lines.append(f"\n## Most recent call ({last_call['started_at']}) — full transcript")
        for t in last_call["turns"]:
            speaker = t.get("speaker") or "unknown"
            lines.append(f"  {speaker}: {t['text']}")

    return "\n".join(lines)


_SPEAKER_LABEL = {
    "rep": "YOU",
    "client": "PROSPECT",
    "unknown": "PROSPECT",
}


def render_current_transcript(turns: List[Dict[str, Any]]) -> str:
    """Render the *current* session's turns as YOU/PROSPECT-tagged lines.

    'rep' is the salesperson (the user of this app); 'client' is the
    prospect on the other end. Anything else falls back to PROSPECT —
    that's the safer default for sales coaching since prospect turns are
    what we want the AI to react to.
    """
    if not turns:
        return "(no turns yet — wait for the prospect to speak)"
    return "\n".join(
        f"{_SPEAKER_LABEL.get(t.get('speaker') or 'unknown', 'PROSPECT')}: {t['text']}"
        for t in turns
    )


def _compose_system(system_prompt: str, history_block: Optional[str]) -> str:
    if history_block:
        return f"{system_prompt}\n\n{history_block}"
    return system_prompt


class SuggestionService:
    """Streams suggestions from OpenRouter (hosted) or local Ollama.

    Provider is picked once at construction: OpenRouter if
    ``openrouter_api_key`` is set (works on a hosted backend with no local
    model), otherwise the local Ollama server. The two speak different stream
    formats (OpenAI SSE vs Ollama NDJSON) but share every prompt and the
    ``on_token`` callback surface, so the WebSocket copilot is unaffected.
    """

    def __init__(self) -> None:
        self._settings = get_settings()
        self._client: Optional[httpx.AsyncClient] = None
        self._enabled = bool(self._settings.suggestions_enabled)
        # OpenRouter wins when keyed; else fall back to Ollama.
        self._provider = "openrouter" if self._settings.openrouter_api_key else "ollama"
        if not self._enabled:
            log.info("suggestions disabled (suggestions_enabled=False)")
            return
        if self._provider == "openrouter":
            self._client = httpx.AsyncClient(
                base_url=self._settings.openrouter_base_url,
                timeout=self._settings.ollama_request_timeout,
                headers={
                    "Authorization": f"Bearer {self._settings.openrouter_api_key}",
                    "HTTP-Referer": self._settings.openrouter_app_url,
                    "X-Title": "Memento AI",
                },
            )
        else:
            self._client = httpx.AsyncClient(
                base_url=self._settings.ollama_base_url,
                timeout=self._settings.ollama_request_timeout,
            )
        log.info(
            "suggestions enabled (provider=%s, model=%s)",
            self._provider,
            self.model,
        )

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def provider(self) -> str:
        return self._provider

    @property
    def model(self) -> str:
        if self._provider == "openrouter":
            return self._settings.openrouter_model
        return self._settings.ollama_model

    # ---- public streaming surface --------------------------------------

    async def stream_suggestion(
        self,
        *,
        history_block: Optional[str],
        current_turns: List[Dict[str, Any]],
        on_token: Callable[[str], Awaitable[None]],
        skill: Skill = DEFAULT_SKILL,
    ) -> LLMResult:
        if not self._enabled:
            return LLMResult(text="", prompt="", system_prompt="")
        user_text = (
            "Current call transcript so far (YOU = the rep, PROSPECT = the "
            "person on the other end):\n"
            f"{render_current_transcript(current_turns)}\n\n"
            "What should YOU say next, in response to what the PROSPECT "
            "just said? Reply with the utterance only."
        )
        return await self._stream_chat(
            system_prompt=SUGGEST_PROMPTS.get(skill, SUGGEST_PROMPTS[DEFAULT_SKILL]),
            history_block=history_block,
            user_text=user_text,
            max_tokens=self._settings.suggestion_max_tokens,
            on_token=on_token,
        )

    async def stream_user_query(
        self,
        *,
        prompt: str,
        history_block: Optional[str],
        current_turns: List[Dict[str, Any]],
        on_token: Callable[[str], Awaitable[None]],
        skill: Skill = DEFAULT_SKILL,
    ) -> LLMResult:
        if not self._enabled or not prompt.strip():
            return LLMResult(text="", prompt=prompt.strip(), system_prompt="")
        user_text = (
            "Current call transcript so far (YOU = the rep asking this "
            "question, PROSPECT = the person on the other end):\n"
            f"{render_current_transcript(current_turns)}\n\n"
            "YOUR question to the copilot:\n"
            f"{prompt.strip()}"
        )
        return await self._stream_chat(
            system_prompt=ASK_PROMPTS.get(skill, ASK_PROMPTS[DEFAULT_SKILL]),
            history_block=history_block,
            user_text=user_text,
            max_tokens=max(self._settings.suggestion_max_tokens, 500),
            on_token=on_token,
        )

    async def summarize_session(
        self,
        *,
        turns: List[Dict[str, Any]],
        prior_summary_block: Optional[str] = None,
    ) -> str:
        """Generate a 2–4 sentence summary of the session for future calls."""
        if not self._enabled or not turns:
            return ""
        transcript = render_current_transcript(turns)
        prompt = (
            "Summarize the call below in 2–4 sentences. Capture: "
            "what the prospect cares about, objections raised, "
            "concrete next steps or commitments, anything to remember "
            "for the next call. Be specific.\n\n"
            f"Transcript:\n{transcript}"
        )

        chunks: List[str] = []

        async def _collect(text: str) -> None:
            chunks.append(text)

        try:
            result = await self._stream_chat(
                system_prompt="You write concise, factual call summaries.",
                history_block=None,
                user_text=prompt,
                max_tokens=300,
                on_token=_collect,
            )
        except Exception as exc:
            log.exception("summarize failed: %s", exc)
            return ""
        return (result.text or "".join(chunks)).strip()

    async def extract_memory_entries(
        self,
        *,
        turns: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Extract typed long-term memory from a finished call.

        Returns a list of `{type, content, confidence}` dicts where type is one
        of fact / preference / commitment / signal / history. These get written
        to the customer's Walrus memory doc. Returns [] on any failure — memory
        write is best-effort and must never break call teardown.
        """
        if not self._enabled or not turns:
            return []
        transcript = render_current_transcript(turns)
        system = (
            "You extract durable CRM memory from a sales call transcript and "
            "return STRICT JSON only. Output a JSON array; each item is "
            '{"type": <one of "fact"|"preference"|"commitment"|"signal"|'
            '"history">, "content": <one concise sentence>, "confidence": '
            "<0..1>}. Types: fact = stable truths about the company/person "
            "(industry, team size, stack, decision-makers); preference = how "
            "they like to communicate / what excites them; commitment = a "
            "concrete next step either side promised (with timing if stated); "
            "signal = a recent, time-sensitive cue (mood, budget hint, "
            "competitor named, churn risk); history = a one-line note of what "
            "this call was about. Only include things actually supported by the "
            "transcript. No prose, no markdown — JSON array only."
        )
        prompt = f"Transcript (YOU = rep, PROSPECT = customer):\n{transcript}"
        chunks: List[str] = []

        async def _collect(text: str) -> None:
            chunks.append(text)

        try:
            result = await self._stream_chat(
                system_prompt=system,
                history_block=None,
                user_text=prompt,
                max_tokens=600,
                on_token=_collect,
            )
        except Exception as exc:
            log.exception("memory extraction failed: %s", exc)
            return []
        raw = _extract_json_array(result.text or "".join(chunks))
        return raw

    # ---- streaming plumbing --------------------------------------------

    async def _stream_chat(
        self,
        *,
        system_prompt: str,
        history_block: Optional[str],
        user_text: str,
        max_tokens: int,
        on_token: Callable[[str], Awaitable[None]],
    ) -> LLMResult:
        composed_system = _compose_system(system_prompt, history_block)
        if self._provider == "openrouter":
            full = await self._stream_openrouter(composed_system, user_text, max_tokens, on_token)
        else:
            full = await self._stream_ollama(composed_system, user_text, max_tokens, on_token)
        return LLMResult(
            text=full.strip(),
            prompt=user_text,
            system_prompt=composed_system,
        )

    async def _stream_openrouter(
        self,
        composed_system: str,
        user_text: str,
        max_tokens: int,
        on_token: Callable[[str], Awaitable[None]],
    ) -> str:
        """Stream from OpenRouter's OpenAI-compatible SSE endpoint."""
        assert self._client is not None  # guarded by self._enabled
        payload = {
            "model": self.model,
            "stream": True,
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": composed_system},
                {"role": "user", "content": user_text},
            ],
        }
        full = ""
        try:
            async with self._client.stream("POST", "/chat/completions", json=payload) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        obj = json.loads(data)
                    except json.JSONDecodeError:
                        continue  # skip partial SSE frames
                    if obj.get("error"):
                        raise RuntimeError(f"openrouter error: {obj['error']}")
                    chunk = (((obj.get("choices") or [{}])[0]).get("delta") or {}).get("content") or ""
                    if chunk:
                        full += chunk
                        await on_token(chunk)
        except Exception as exc:
            log.exception("openrouter stream failed: %s", exc)
            raise
        return full

    async def _stream_ollama(
        self,
        composed_system: str,
        user_text: str,
        max_tokens: int,
        on_token: Callable[[str], Awaitable[None]],
    ) -> str:
        """Stream from a local Ollama server (NDJSON)."""
        assert self._client is not None  # guarded by self._enabled
        payload = {
            "model": self.model,
            "stream": True,
            "messages": [
                {"role": "system", "content": composed_system},
                {"role": "user", "content": user_text},
            ],
            "options": {"num_predict": max_tokens},
        }
        full = ""
        try:
            async with self._client.stream("POST", "/api/chat", json=payload) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        log.warning("ollama: skipping non-JSON line: %r", line[:120])
                        continue
                    if obj.get("error"):
                        raise RuntimeError(f"ollama error: {obj['error']}")
                    chunk = (obj.get("message") or {}).get("content") or ""
                    if chunk:
                        full += chunk
                        await on_token(chunk)
                    if obj.get("done"):
                        break
        except Exception as exc:
            log.exception("ollama stream failed: %s", exc)
            raise
        return full
