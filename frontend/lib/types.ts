export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "recording"
  | "stopped"
  | "error";

export interface TranscriptSegment {
  text: string;
  start: number; // seconds, session-relative
  end: number;
}

export interface PartialMessage {
  type: "partial" | "final";
  text: string;
  segments: TranscriptSegment[];
  buffer_seconds: number;
  inference_ms: number;
  end_to_end_ms: number;
  server_ts: string;
  /** Set on `final` when the turn was persisted to the DB. */
  turn_id?: number;
  /** Set on `final` when speaker diarization classified the turn. */
  speaker?: "rep" | "client" | "unknown";
  /** Optional cosine similarity to the rep voice print, for debugging. */
  speaker_similarity?: number;
}

export interface ClientAttachedMessage {
  type: "client_attached";
  client: Client;
  has_history: boolean;
  /** How many long-term memory entries were recalled from Walrus on attach. */
  memory_entries: number;
  server_ts: string;
}

export interface MemoryWrittenMessage {
  type: "memory_written";
  /** Walrus blob ID of the new customer-memory document. */
  blob_id: string;
  /** Public aggregator URL — anyone can GET this to verify the memory is on Walrus. */
  aggregator_url: string;
  /** Entries added by this call. */
  added: number;
  /** Total entries now in the customer's memory doc. */
  total: number;
  server_ts: string;
}

export interface SuggestionStartMessage {
  type: "suggestion_start";
  turn_id: number;
}

export interface SuggestionTokenMessage {
  type: "suggestion_token";
  text: string;
}

export interface SuggestionEndMessage {
  type: "suggestion_end";
  turn_id: number;
  full_text: string;
}

export interface AskStartMessage {
  type: "ask_start";
  ask_id: string;
  prompt: string;
}

export interface AskTokenMessage {
  type: "ask_token";
  ask_id: string;
  text: string;
}

export interface AskEndMessage {
  type: "ask_end";
  ask_id: string;
  full_text: string;
  error?: boolean;
}

export interface SpeechStartMessage {
  type: "speech_start";
  turn_start: number; // session-relative seconds
  server_ts: string;
}

export interface TurnEndMessage {
  type: "turn_end";
  turn_start: number;
  turn_end: number;
  server_ts: string;
}

export interface ReadyMessage {
  type: "ready";
  session_id: string;
  server_ts: string;
}

export interface StoppedMessage {
  type: "stopped";
  server_ts: string;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export interface PongMessage {
  type: "pong";
  server_ts: string;
}

export interface ModeChangedMessage {
  type: "mode_changed";
  mode: SuggestionMode;
  auto_interval_seconds: AutoIntervalSeconds;
  skill: SuggestionSkill;
  server_ts: string;
}

export type ServerMessage =
  | ReadyMessage
  | PartialMessage
  | SpeechStartMessage
  | TurnEndMessage
  | StoppedMessage
  | ErrorMessage
  | PongMessage
  | ClientAttachedMessage
  | MemoryWrittenMessage
  | SuggestionStartMessage
  | SuggestionTokenMessage
  | SuggestionEndMessage
  | AskStartMessage
  | AskTokenMessage
  | AskEndMessage
  | ModeChangedMessage;

/** Auto = fire suggestions on a turn-driven cadence. Manual = only respond
 *  to typed prompts (the `ask_*` flow). */
export type SuggestionMode = "auto" | "manual";

/** Allowed throttle values for auto mode. 0 = "fire on every committed turn". */
export type AutoIntervalSeconds = 0 | 60 | 120 | 300;

/** Persona / skill the copilot uses to compose suggestions. Swaps the
 *  system prompt server-side. */
export type SuggestionSkill = "sales" | "marketing" | "casual";

export interface Client {
  id: number;
  name: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  role?: string | null;
  deal_stage?: string | null;
  /** Free-text "who they are" (industry, role context, history). */
  profile?: string | null;
  /** Free-text "what we want from talking to them". */
  objective?: string | null;
  /** How they relate to me — colleague, friend, expert helping me, customer… */
  relationship?: string | null;
  tags?: string[];
  /** The customer's own org-owned MemWalAccount id (org-memory model). */
  memwal_account_id?: string | null;
  created_at: string;
}

export interface Attachment {
  id: number;
  client_id: number;
  filename: string;
  mime_type: string | null;
  size_bytes: number;
  storage_path: string;
  uploaded_at: string;
}

export interface SessionRow {
  id: string;
  client_id: number | null;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
}

export interface SessionDetail {
  session: SessionRow;
  client: Client | null;
  turns: {
    id: number;
    speaker: string;
    text: string;
    t_start: number | null;
    t_end: number | null;
    server_ts: string;
  }[];
  suggestions: {
    id: number;
    turn_id: number | null;
    text: string;
    model: string | null;
    created_at: string;
  }[];
}

export interface SuggestionState {
  turnId: number;
  text: string;
  status: "streaming" | "done";
}

/** A free-text question the rep typed to the copilot, plus its streamed answer. */
export interface AskState {
  askId: string;
  prompt: string;
  text: string;
  status: "pending" | "streaming" | "done" | "error";
}

/** A single turn (one utterance), live or finalized. */
export interface Turn {
  id: string;
  /** DB row id, present once the turn has been persisted. */
  dbTurnId?: number;
  status: "live" | "final";
  /** Session-relative seconds when speech began. */
  startSec?: number;
  /** Session-relative seconds when speech ended. Set on turn_end or final. */
  endSec?: number;
  text: string;
  /** Wall-clock ISO when the server finalized this turn. */
  finalizedAtIso?: string;
  /** Whisper inference time for the final pass. */
  inferenceMs?: number;
  /** Diarization label, set on final when an enrollment is loaded. */
  speaker?: "rep" | "client" | "unknown";
}
