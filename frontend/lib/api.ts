import type { Attachment, Client, SessionDetail, SessionRow } from "./types";
import { getSessionToken } from "./session";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws/transcribe";

/** Attach the backend session JWT (if signed in) + skip ngrok's browser
 *  interstitial (which otherwise returns HTML and breaks fetch when the backend
 *  is exposed via an ngrok tunnel). Harmless when the backend isn't on ngrok. */
function authHeaders(): Record<string, string> {
  const t = getSessionToken();
  const h: Record<string, string> = { "ngrok-skip-browser-warning": "true" };
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

/** Derive the REST base from the WS URL. */
function deriveHttpBase(): string {
  try {
    const u = new URL(WS_URL);
    const proto = u.protocol === "wss:" ? "https:" : "http:";
    return `${proto}//${u.host}`;
  } catch {
    return "http://localhost:8000";
  }
}

const HTTP_BASE = process.env.NEXT_PUBLIC_API_URL ?? deriveHttpBase();
/** Absolute backend base, for EventSource/SSE etc. that can't use the jget helpers. */
export const API_BASE = HTTP_BASE;

async function jget<T>(path: string): Promise<T> {
  const res = await fetch(`${HTTP_BASE}${path}`, { cache: "no-store", headers: { ...authHeaders() } });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function jpost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${HTTP_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function jpatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${HTTP_BASE}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function jput<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${HTTP_BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function jdelete<T>(path: string): Promise<T> {
  const res = await fetch(`${HTTP_BASE}${path}`, { method: "DELETE", headers: { ...authHeaders() } });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

// ── namespace manifest (the memory-map blob on Walrus) ──
export type ManifestNamespace = { namespace: string; kind: "parent" | "sub"; label: string };
export type ManifestConversation = {
  blob_id: string;
  kind?: string | null;
  direction?: string | null;
  label: string;
  at?: string | null;
  aggregator_url: string;
};
export type Manifest = {
  version: number;
  kind: string;
  customer_id: string;
  client: { id: number; name?: string | null; relationship?: string | null; deal_stage?: string | null };
  generated_at: string;
  namespaces: ManifestNamespace[];
  conversations: ManifestConversation[];
  memory_pointer: string | null;
};
export type PublishManifestResult = {
  blob_id: string;
  aggregator_url: string;
  namespaces: ManifestNamespace[];
  conversations: ManifestConversation[];
  customer_id: string;
  manifest: Manifest;
};

/** Build this customer's namespace map and write it to Walrus. */
export async function publishManifest(clientId: number): Promise<PublishManifestResult> {
  return jpost(`/clients/${clientId}/manifest`, {});
}

/** Read a manifest back from Walrus by blob id (the verify / handoff path). */
export async function fetchManifest(blobId: string): Promise<Manifest> {
  return jget(`/manifest/${encodeURIComponent(blobId)}`);
}

export async function searchClients(query?: string): Promise<Client[]> {
  const qs = query && query.trim() ? `?q=${encodeURIComponent(query)}` : "";
  const data = await jget<{ clients: Client[] }>(`/clients${qs}`);
  return data.clients;
}

export interface ClientWriteInput {
  name?: string;
  phone?: string;
  email?: string;
  notes?: string;
  role?: string;
  deal_stage?: string;
  profile?: string;
  objective?: string;
  relationship?: string;
}

export async function createClient(input: ClientWriteInput & { name: string }): Promise<Client> {
  return jpost<Client>("/clients", input);
}

export async function getClient(clientId: number): Promise<Client> {
  return jget<Client>(`/clients/${clientId}`);
}

export async function updateClient(
  clientId: number,
  patch: ClientWriteInput,
): Promise<Client> {
  return jpatch<Client>(`/clients/${clientId}`, patch);
}

export async function deleteClient(clientId: number): Promise<{ deleted: number }> {
  return jdelete<{ deleted: number }>(`/clients/${clientId}`);
}

export async function setClientTags(clientId: number, tags: string[]): Promise<string[]> {
  const data = await jput<{ tags: string[] }>(`/clients/${clientId}/tags`, { tags });
  return data.tags;
}

export async function listAllTags(): Promise<string[]> {
  const data = await jget<{ tags: string[] }>("/tags");
  return data.tags;
}

export async function listSessionsForClient(clientId: number): Promise<SessionRow[]> {
  const data = await jget<{ sessions: SessionRow[] }>(`/clients/${clientId}/sessions`);
  return data.sessions;
}

export async function getSession(sessionId: string): Promise<SessionDetail> {
  return jget<SessionDetail>(`/sessions/${sessionId}`);
}

export interface Subspace {
  ns_key: string;
  label: string;
  created_at: string;
}

export async function listSubspaces(clientId: number): Promise<Subspace[]> {
  const data = await jget<{ subspaces: Subspace[] }>(`/clients/${clientId}/subspaces`);
  return data.subspaces;
}

export async function createSubspace(clientId: number, label: string): Promise<Subspace> {
  return jpost<Subspace>(`/clients/${clientId}/subspaces`, { label });
}

export async function listAttachments(clientId: number): Promise<Attachment[]> {
  const data = await jget<{ attachments: Attachment[] }>(`/clients/${clientId}/attachments`);
  return data.attachments;
}

export async function uploadAttachment(
  clientId: number,
  file: File,
  onProgress?: (frac: number) => void,
): Promise<Attachment> {
  const form = new FormData();
  form.append("file", file);

  // Use XHR so we can stream upload progress; fetch can't currently report it.
  return new Promise<Attachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${HTTP_BASE}/clients/${clientId}/attachments`);
    const tok = getSessionToken();
    if (tok) xhr.setRequestHeader("Authorization", `Bearer ${tok}`);
    xhr.responseType = "json";
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as Attachment);
      else reject(new Error(`${xhr.status} ${xhr.responseText || "upload failed"}`));
    };
    xhr.onerror = () => reject(new Error("upload network error"));
    xhr.send(form);
  });
}

export function attachmentDownloadUrl(attachmentId: number): string {
  return `${HTTP_BASE}/attachments/${attachmentId}`;
}

export async function deleteAttachment(attachmentId: number): Promise<void> {
  await jdelete(`/attachments/${attachmentId}`);
}

// ─── voice enrollment ────────────────────────────────────────────────────

export interface EnrollmentStatus {
  enrolled: boolean;
  duration_s?: number;
  sample_rate?: number;
  created_at?: string;
}

export async function getEnrollment(): Promise<EnrollmentStatus> {
  return jget<EnrollmentStatus>("/enrollment");
}

/** Upload a Float32 PCM mono 16 kHz blob as the rep's voice print. */
export async function postEnrollment(samples: Float32Array): Promise<EnrollmentStatus> {
  const form = new FormData();
  // Backend expects raw Float32 LE bytes — same format as the WS audio frames.
  const blob = new Blob([samples.buffer], { type: "application/octet-stream" });
  form.append("file", blob, "enrollment.pcm");
  const res = await fetch(`${HTTP_BASE}/enrollment`, { method: "POST", body: form, headers: { ...authHeaders() } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

export async function deleteEnrollment(): Promise<EnrollmentStatus> {
  return jdelete<EnrollmentStatus>("/enrollment");
}

// ─── upload past calls ───────────────────────────────────────────────────

export interface UploadJob {
  id: number;
  client_id: number;
  filename: string;
  status: "pending" | "running" | "done" | "error";
  phase?: "decoding" | "transcribing" | "diarizing" | "summarizing" | null;
  progress: number;
  duration_s?: number | null;
  session_id?: string | null;
  error?: string | null;
  created_at: string;
  finished_at?: string | null;
}

export async function uploadPastCall(
  clientId: number,
  file: File,
  onProgress?: (frac: number) => void,
): Promise<UploadJob> {
  const form = new FormData();
  form.append("file", file);
  return new Promise<UploadJob>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${HTTP_BASE}/clients/${clientId}/sessions/from-audio`);
    const tok = getSessionToken();
    if (tok) xhr.setRequestHeader("Authorization", `Bearer ${tok}`);
    xhr.responseType = "json";
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as UploadJob);
      else reject(new Error(`${xhr.status} ${xhr.responseText || "upload failed"}`));
    };
    xhr.onerror = () => reject(new Error("upload network error"));
    xhr.send(form);
  });
}

export async function getJob(jobId: number): Promise<UploadJob> {
  return jget<UploadJob>(`/jobs/${jobId}`);
}

export async function listClientJobs(clientId: number): Promise<UploadJob[]> {
  const data = await jget<{ jobs: UploadJob[] }>(`/clients/${clientId}/jobs`);
  return data.jobs;
}

// ─── communication channels (email / twilio) ──────────────────────────────
export type ChannelKind = "email" | "twilio";
export interface Channel {
  id: number;
  kind: ChannelKind;
  label?: string | null;
  identity?: string | null;
  status: "connected" | "error";
  created_at: string;
  voice_ready?: boolean; // twilio channel has API key + TwiML App → in-app calling
}
export interface ChannelTest {
  ok: boolean;
  error?: string | null;
}

export async function listChannels(): Promise<Channel[]> {
  const data = await jget<{ channels: Channel[] }>("/channels");
  return data.channels;
}

/** Connect a channel. `config` holds the provider credentials (sent once, then
 * encrypted server-side and never returned). Returns the masked channel + test. */
export async function addChannel(
  kind: ChannelKind,
  label: string,
  config: Record<string, string>,
): Promise<{ channel: Channel; test: ChannelTest }> {
  return jpost("/channels", { kind, label, config });
}

export async function testChannel(id: number): Promise<ChannelTest> {
  return jpost(`/channels/${id}/test`, {});
}

export async function deleteChannel(id: number): Promise<void> {
  await jdelete(`/channels/${id}`);
}

// ─── messages (outbound send + inbox list) ─────────────────────────────────
export interface Message {
  id: number;
  kind: "email" | "sms" | "call" | "twilio" | "note";
  direction: "out" | "in";
  to_addr?: string | null;
  from_addr?: string | null;
  subject?: string | null;
  body?: string | null;
  status: "sent" | "error";
  error?: string | null;
  blob_id?: string | null;
  provider_id?: string | null;
  client_id?: number | null;
  channel_id?: number | null;
  created_at: string;
}

export async function sendMessage(
  channelId: number,
  payload: { to: string; subject?: string; body: string; client_id?: number },
): Promise<{ message: Message; ok: boolean; error?: string | null }> {
  return jpost(`/channels/${channelId}/send`, payload);
}

export async function listMessages(clientId?: number): Promise<Message[]> {
  const q = clientId != null ? `?client_id=${clientId}` : "";
  const data = await jget<{ messages: Message[] }>(`/messages${q}`);
  return data.messages;
}

/** Add a free-text note to a customer — recorded in the thread + stored on Walrus. */
export async function addNote(clientId: number, text: string): Promise<{ message: Message; ok: boolean }> {
  return jpost(`/clients/${clientId}/notes`, { text });
}

export async function logCall(
  clientId: number,
  opts: { to: string; seconds?: number; status?: "completed" | "failed" | "missed"; direction?: "in" | "out"; transcript?: string },
): Promise<{ message: Message; ok: boolean }> {
  return jpost(`/clients/${clientId}/calls`, opts);
}

export type CopilotTurn = { role: "user" | "assistant"; content: string };

/** Stream a copilot reply for an ongoing conversation (multi-turn), grounded in
 * the customer's memory. Pass the full turn history; calls onToken per chunk and
 * resolves with the source count. AbortSignal cancels an in-flight reply. */
export async function streamCopilot(
  clientId: number,
  messages: CopilotTurn[],
  onToken: (t: string) => void,
  signal?: AbortSignal,
  context?: string,
  persona?: string,
  knowledge?: string,
): Promise<{ sources: number }> {
  const res = await fetch("/api/copilot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, messages, context, persona, knowledge }),
    signal,
  });
  const sources = Number(res.headers.get("X-Sources-Count") ?? "0");
  if (!res.ok || !res.body) throw new Error(`copilot ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onToken(dec.decode(value, { stream: true }));
  }
  return { sources };
}

/** Place an outbound call via a connected Voice Relay channel. */
export async function placeCall(
  channelId: number,
  payload: { to: string; client_id?: number },
): Promise<{ message: Message; ok: boolean; error?: string | null; call_sid?: string | null }> {
  return jpost(`/channels/${channelId}/call`, payload);
}

/** Assisted call via the backend's native Twilio media path (uses PUBLIC_BASE_URL +
 *  /ws/twilio transcription → /calls/stream). Works on the backend's own tunnel. */
export async function placeAssistedCall(
  to: string,
): Promise<{ ok: boolean; callSid?: string; error?: string }> {
  return jpost(`/twilio/call`, { to });
}

/** Mint a Twilio Voice access token for the in-browser softphone. */
export async function getVoiceToken(
  channelId: number,
): Promise<{ token: string; identity: string; from?: string | null }> {
  return jpost(`/channels/${channelId}/voice-token`, {});
}

/** Hang up an in-progress call by SID. */
export async function hangupCall(
  channelId: number,
  callSid: string,
): Promise<{ ok: boolean; status?: string }> {
  return jpost(`/channels/${channelId}/hangup`, { call_sid: callSid });
}
