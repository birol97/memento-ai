"use client";

// Single-screen client workspace: the customer's parent namespace rendered as a
// chat thread (every interaction = a message bubble, click to expand details),
// with all actions (email / SMS / call) and all client info (profile + recalled
// memory + sessions + files) on ONE screen — no tab hopping.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FiMail, FiPhoneCall, FiPaperclip, FiChevronRight, FiEdit3, FiHeadphones, FiCpu, FiInfo, FiLink2, FiTrash2, FiMessageSquare, FiDatabase, FiAlertTriangle, FiX, FiCheck } from "react-icons/fi";

import {
  addNote,
  logCall,
  attachmentDownloadUrl,
  deleteClient,
  getClient,
  listAttachments,
  listChannels,
  listMessages,
  listSessionsForClient,
  sendMessage,
  streamCopilot,
  updateClient,
  uploadAttachment,
  uploadPastCall,
  type Channel,
  type CopilotTurn,
  type Message,
} from "@/lib/api";
import type { Attachment, Client, SessionRow } from "@/lib/types";
import { recallClientMemory, rememberRaw, writeClientMemory } from "@/app/actions/memory";
import { syncMemoryMap } from "@/app/actions/onchain";
import MemoryMapPanel from "./MemoryMapPanel";
import { clientNamespace } from "@/lib/clientNamespace";
import { loadCharacter, characterPrompt } from "@/lib/character";
import { loadKnowledge } from "@/lib/knowledge";
import { Dialer } from "@/components/Dialer";
import { LiveAdvisor } from "@/components/LiveAdvisor";
import { Avatar } from "@/components/Avatar";
import { Resizer } from "@/components/Resizer";
import { LiveCallPanel } from "@/components/LiveCallPanel";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const NOTE = -1; // sentinel channel id for the "internal note" pseudo-channel

const WALRUS_AGG =
  process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR ?? "https://aggregator.walrus-testnet.walrus.space";

const DEAL_STAGES = ["", "prospect", "discovery", "demo", "negotiation", "closed-won", "closed-lost"];

// Authoritative profile text handed to the copilot so it anchors to THIS customer
// (their real name + concrete facts) instead of relying only on fuzzy recall.
function clientContext(c: Client): string {
  const lines = [
    `Name: ${c.name}`,
    c.relationship ? `Relationship to rep: ${c.relationship}` : "",
    c.role ? `Role: ${c.role}` : "",
    c.deal_stage ? `Deal stage: ${c.deal_stage}` : "",
    c.phone ? `Phone: ${c.phone}` : "",
    c.email ? `Email: ${c.email}` : "",
    c.objective ? `Our objective with them: ${c.objective}` : "",
    c.profile ? `Profile / what we know:\n${c.profile}` : "",
    c.notes ? `Notes:\n${c.notes}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

// Dated interaction timeline (from SQLite) so the copilot can answer "when was the
// latest conversation / what did we last talk about" — MemWal stores facts, not dates.
function recentInteractionsText(
  thread: { type: string; at: string; msg?: Message; session?: SessionRow }[],
  name: string,
): string {
  if (!thread.length) return "";
  const rows = thread.slice(-12).reverse().map((it) => {
    const d = new Date(it.at).toLocaleString();
    if (it.type === "session" && it.session) {
      return `- ${d}: Uploaded call — ${(it.session.summary ?? "recorded call").slice(0, 100)}`;
    }
    const m = it.msg!;
    const kind = m.kind === "call" ? "Call" : m.kind === "note" ? "Note" : m.kind === "email" ? "Email" : "Message";
    const dir = m.direction === "out" ? `we → ${name}` : `${name} → us`;
    const snip = `${m.subject ? m.subject + ": " : ""}${(m.body ?? "").slice(0, 100)}`.trim();
    return `- ${d}: ${kind} (${dir}) ${snip}`;
  });
  return "RECENT INTERACTIONS (most recent first, with dates):\n" + rows.join("\n");
}

// Kind icons inherit currentColor so the thread colors them via CSS (theme-aligned).
function KindIcon({ kind }: { kind: string }) {
  if (kind === "email") return <FiMail size={15} />;
  if (kind === "call") return <FiPhoneCall size={15} />;
  if (kind === "note") return <FiEdit3 size={15} />;
  return <FiMessageSquare size={15} />; // sms
}

export function ClientWorkspace({
  clientId,
  embedded = false,
  onDeleted,
}: {
  clientId: number;
  embedded?: boolean;
  onDeleted?: () => void;
}) {
  const router = useRouter();

  const [client, setClient] = useState<Client | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [memory, setMemory] = useState<string[] | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);

  // compose — defaults to the Note pseudo-channel so it always works
  const [channelId, setChannelId] = useState<number>(NOTE);
  const defaultedChannel = useRef(false);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "assistant">("chat"); // main area: thread vs live assistant
  // Right side panel is collapsed by default so the chat reads full-width like a
  // messenger; the header icons reveal customer info or the AI copilot on demand.
  const [panel, setPanel] = useState<"none" | "info" | "copilot" | "chain">("none");
  const [infoW, setInfoW] = useState(360); // resizable width of the right pane
  const [liveTranscript, setLiveTranscript] = useState(""); // captured from an assisted call
  const [dialer, setDialer] = useState<{ channelId: number; to: string; assisted: boolean; sessionId: string } | null>(null);
  const [callChooser, setCallChooser] = useState(false); // "with AI assistant?" prompt
  const threadEnd = useRef<HTMLDivElement | null>(null);

  // Unified, time-sorted timeline: channel messages + uploaded call sessions,
  // so an uploaded call shows up in the thread like any other interaction.
  type ThreadItem =
    | { type: "msg"; key: string; at: string; msg: Message }
    | { type: "session"; key: string; at: string; session: SessionRow };
  const thread = useMemo<ThreadItem[]>(() => {
    const items: ThreadItem[] = [
      ...messages.map((m) => ({ type: "msg" as const, key: `m${m.id}`, at: m.created_at, msg: m })),
      ...sessions.map((s) => ({ type: "session" as const, key: `s${s.id}`, at: s.started_at, session: s })),
    ];
    return items.sort((a, b) => a.at.localeCompare(b.at)); // oldest top, newest bottom
  }, [messages, sessions]);

  const loadThread = useCallback(async () => {
    setMessages(await listMessages(clientId));
  }, [clientId]);

  const load = useCallback(async () => {
    try {
      const [c, ms, ch, ss, at] = await Promise.all([
        getClient(clientId),
        listMessages(clientId),
        listChannels(),
        listSessionsForClient(clientId),
        listAttachments(clientId),
      ]);
      setClient(c);
      setMessages(ms);
      setChannels(ch);
      setSessions(ss);
      setFiles(at);
      setError(null);
      // default to the first real channel once (Note stays available in the list)
      if (!defaultedChannel.current && ch.length) {
        defaultedChannel.current = true;
        setChannelId(ch[0].id);
      }
      setTo((cur) => cur || c.phone || c.email || "");
      // recall memory (best-effort)
      recallClientMemory(clientId)
        .then((r) => setMemory(r.ok ? r.entries : []))
        .catch(() => setMemory([]));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread.length]);

  const isNote = channelId === NOTE;
  const selected = channels.find((c) => c.id === channelId);
  const isEmail = selected?.kind === "email";
  const isTwilio = selected?.kind === "twilio";

  // Switch the active channel and auto-fill the recipient from the customer's
  // contact details, so you're really messaging THEM (not retyping the address).
  const selectChannel = (id: number) => {
    setChannelId(id);
    if (id === NOTE || !client) return;
    const ch = channels.find((c) => c.id === id);
    if (!ch) return;
    const auto = ch.kind === "email" ? client.email : client.phone;
    if (auto && (!to.trim() || to === client.email || to === client.phone)) setTo(auto);
  };

  const doSend = async () => {
    if (!body.trim()) return;
    if (!isNote && !to.trim()) return;
    setSending(true);
    setFlash(null);
    try {
      if (isNote) {
        // A note is recorded in the thread AND written into the customer's memory
        // so the copilot + search recall it. Awaited (not fire-and-forget) so a
        // failed memory write surfaces instead of silently losing the note.
        await addNote(clientId, body.trim());
        const mem = await rememberRaw(clientNamespace(clientId), body.trim());
        setFlash(mem.ok ? { ok: true, text: "Note added ✓ (saved to memory)" } : { ok: false, text: `Note saved, but memory write failed: ${mem.error}` });
      } else {
        const r = await sendMessage(channelId as number, {
          to: to.trim(),
          subject: isEmail ? subject : undefined,
          body,
          client_id: clientId,
        });
        setFlash(r.ok ? { ok: true, text: "Sent ✓" } : { ok: false, text: `Failed: ${r.error ?? "error"}` });
      }
      setBody("");
      setSubject("");
      await loadThread();
      // keep the on-chain/Walrus manifest complete so retrieval never needs SQLite
      syncMemoryMap(clientId).catch(() => {});
    } catch (e) {
      setFlash({ ok: false, text: e instanceof Error ? e.message : "failed" });
    }
    setSending(false);
  };

  const openDialer = (assisted: boolean) => {
    if (channelId === NOTE || !to.trim()) return;
    // unique per-call id so concurrent calls/conferences keep separate transcripts
    setDialer({ channelId, to: to.trim(), assisted, sessionId: `call-${clientId}-${Date.now()}` });
  };

  if (error) return <main className="page"><div className="error">{error}</div></main>;
  if (!client) return <main className="page"><p>Loading…</p></main>;

  const twoCol = view === "chat" && panel !== "none";
  const presence = [client.relationship || client.role || "Customer", client.deal_stage]
    .filter(Boolean)
    .join(" · ");

  return (
    <main className={`cw${embedded ? " cw-embedded" : ""}`}>
      {/* ── Slim messenger-style conversation header ── */}
      <header className="cw-bar">
        <div className="cw-bar-id">
          {!embedded && <Link href="/customers" className="cw-back" title="Back to inbox">←</Link>}
          <Avatar name={client.name} size={38} />
          <div className="cw-bar-name">
            <h1>{client.name}</h1>
            <span className="cw-presence">{presence}</span>
          </div>
        </div>
        <div className="cw-bar-actions">
          <button
            className={`cw-act${view === "assistant" ? " active" : ""}`}
            onClick={() => setView((v) => (v === "assistant" ? "chat" : "assistant"))}
            title="Live call assistant"
            aria-label="Live call assistant"
          >
            <FiHeadphones />
          </button>
          <button
            className={`cw-act${panel === "copilot" ? " active" : ""}`}
            onClick={() => { setView("chat"); setPanel((p) => (p === "copilot" ? "none" : "copilot")); }}
            title="AI Copilot"
            aria-label="AI Copilot"
          >
            <FiCpu />
          </button>
          <button
            className={`cw-act${panel === "info" ? " active" : ""}`}
            onClick={() => { setView("chat"); setPanel((p) => (p === "info" ? "none" : "info")); }}
            title="Customer info"
            aria-label="Customer info"
          >
            <FiInfo />
          </button>
          <button
            className={`cw-act${panel === "chain" ? " active" : ""}`}
            onClick={() => { setView("chat"); setPanel((p) => (p === "chain" ? "none" : "chain")); }}
            title="On-chain memory map (Sui cap → Walrus)"
            aria-label="On-chain memory map"
          >
            <FiLink2 />
          </button>
          <button
            className="cw-act danger"
            title="Delete customer"
            onClick={async () => {
              if (!confirm(`Delete ${client.name}? This cannot be undone.`)) return;
              await deleteClient(clientId);
              if (onDeleted) onDeleted();
              else router.push("/customers");
            }}
            aria-label="Delete customer"
          >
            <FiTrash2 />
          </button>
        </div>
      </header>

      <div className={`cw-body${twoCol ? "" : " solo"}`}>
        {view === "assistant" ? (
          <section className="cw-assistant">
            <PreCallBrief client={client} />
            <LiveCallPanel client={client} channels={channels} onTranscript={setLiveTranscript} />
            <CallMemorySaver client={client} initialTranscript={liveTranscript} onSaved={load} />
            <details className="cw-mic-advisor">
              <summary>🎙 Mic-based advisor (call on speaker)</summary>
              <LiveAdvisor client={client} />
            </details>
          </section>
        ) : (
         <>
        {/* ── Chat thread + action bar ── */}
        <section className="cw-chat">
          <div className="cw-thread">
            {thread.length === 0 ? (
              <p className="cw-empty">No interactions yet. Start the conversation below.</p>
            ) : (
              thread.map((it) => {
                const open = expanded === it.key;
                const toggle = () => setExpanded(open ? null : it.key);

                if (it.type === "session") {
                  const s = it.session;
                  return (
                    <div key={it.key} className={`cw-msg in cw-msg-call${open ? " open" : ""}`} onClick={toggle}>
                      <div className="cw-msg-head">
                        <FiPhoneCall size={15} />
                        <span className="cw-msg-addr">Uploaded call</span>
                        <span className="cw-msg-time">{new Date(s.started_at).toLocaleString()}</span>
                      </div>
                      <div className={`cw-msg-body${open ? "" : " clamp"}`}>
                        {s.summary || <em>Recorded call (open for transcript)</em>}
                      </div>
                      {open && (
                        <div className="cw-msg-detail">
                          <Link href={`/sessions/${s.id}`} onClick={(e) => e.stopPropagation()}>Open full session ↗</Link>
                        </div>
                      )}
                    </div>
                  );
                }

                const m = it.msg;
                return (
                  <div
                    key={it.key}
                    className={`cw-msg ${m.direction === "out" ? "out" : "in"}${open ? " open" : ""}`}
                    onClick={toggle}
                  >
                    <div className="cw-msg-head">
                      <KindIcon kind={m.kind} />
                      <span className="cw-msg-addr">
                        {m.kind === "note"
                          ? "Note"
                          : m.direction === "out"
                            ? (m.to_addr ? `→ ${m.to_addr}` : "Sent")
                            : (m.from_addr ? `← ${m.from_addr}` : "Received")}
                      </span>
                      <span className={`cw-msg-status ${m.status}`}>{m.status}</span>
                      {m.blob_id && <span className="cw-walrus-badge" title="Stored on Walrus decentralized storage — click to verify"><FiDatabase size={10} /> Walrus</span>}
                      <span className="cw-msg-time">{new Date(m.created_at).toLocaleString()}</span>
                    </div>
                    {m.subject && <div className="cw-msg-subj">{m.subject}</div>}
                    <div className={`cw-msg-body${open ? "" : " clamp"}`}>
                      {m.body || <em>{m.kind === "call" ? "Phone call" : "(no content)"}</em>}
                    </div>
                    {open && (
                      <div className="cw-msg-detail">
                        {m.error && <div className="cw-msg-err"><FiAlertTriangle size={13} /> {m.error}</div>}
                        <dl>
                          <dt>Channel</dt><dd>{m.kind}</dd>
                          {m.provider_id && (<><dt>Provider id</dt><dd><code>{m.provider_id}</code></dd></>)}
                          {m.blob_id && (<><dt>Blob id</dt><dd><code>{m.blob_id.slice(0, 14)}…</code></dd></>)}
                        </dl>
                        {m.blob_id && <WalrusVerify blobId={m.blob_id} />}
                      </div>
                    )}
                  </div>
                );
              })
            )}
            <div ref={threadEnd} />
          </div>

          <div className="cw-compose">
            {/* Channel selector on top — pick HOW you reach the client, then type */}
            <div className="cw-chans">
              <button
                className={`cw-chan${isNote ? " active" : ""}`}
                onClick={() => selectChannel(NOTE)}
                title="Private internal note (not sent to the client)"
              >
                <FiEdit3 size={14} /> Note
              </button>
              {channels.map((c) => (
                <button
                  key={c.id}
                  className={`cw-chan${channelId === c.id ? " active" : ""}`}
                  onClick={() => selectChannel(c.id)}
                  title={`Reach ${client.name} via ${c.label}`}
                >
                  {c.kind === "twilio" ? <FiPhoneCall size={14} /> : <FiMail size={14} />} {c.label}
                </button>
              ))}
              {channels.length === 0 && (
                <Link href="/channels" className="cw-chan cw-chan-add">+ Connect a channel</Link>
              )}
            </div>
            {!isNote && (
              <div className="cw-compose-row">
                <span className="cw-to-label">To</span>
                <input
                  className="cw-to"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder={isEmail ? "name@company.com" : "+15551234567"}
                />
                {isTwilio && (
                  <button className="cw-call" onClick={() => setCallChooser(true)} disabled={!to.trim()} title="Call">
                    <FiPhoneCall /> Call
                  </button>
                )}
              </div>
            )}
            {isEmail && (
              <input className="cw-subj" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
            )}
            <div className="cw-compose-send">
              <textarea
                rows={2}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={isNote ? "Jot a note about " + client.name + "…" : isEmail ? "Write an email…" : "Write a message…"}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void doSend();
                }}
              />
              <button className="primary" onClick={() => void doSend()} disabled={sending || !body.trim()}>
                {sending ? "Saving…" : isNote ? "Add note" : isEmail ? "Send email" : "Send"}
              </button>
            </div>
            {flash && <span className={flash.ok ? "cw-ok" : "cw-err"}>{flash.text}</span>}
          </div>
        </section>

        {/* ── Right pane: collapses by default; header icons reveal it ── */}
        {panel !== "none" && (
          <Resizer onResize={(dx) => setInfoW((w) => clamp(w - dx, 280, 620))} />
        )}
        {panel !== "none" && (
          <aside className={`cw-info${panel === "copilot" ? " cw-info-copilot" : ""}`} style={{ width: infoW }}>
            <div className="cw-info-bar">
              <span className="cw-info-title">
                {panel === "copilot" ? <><FiCpu /> AI Copilot</> : panel === "chain" ? <><FiLink2 /> On-chain memory map</> : <><FiInfo /> Customer info</>}
              </span>
              <button className="cw-info-close" onClick={() => setPanel("none")} title="Close" aria-label="Close panel"><FiX /></button>
            </div>
            {panel === "copilot" ? (
              <CopilotPane clientId={clientId} clientName={client.name} context={`${clientContext(client)}\n\n${recentInteractionsText(thread, client.name)}`} onUse={(t) => setBody(t)} />
            ) : panel === "chain" ? (
              <MemoryMapPanel clientId={clientId} clientName={client.name} />
            ) : (
              <>
                <ProfilePanel client={client} onSaved={load} />
                <MemoryPanel clientId={clientId} entries={memory} />
                <SessionsPanel clientId={clientId} sessions={sessions} onChanged={load} />
                <FilesPanel clientId={clientId} files={files} onChanged={load} />
              </>
            )}
          </aside>
        )}
         </>
        )}
      </div>

      {dialer && (
        <Dialer
          channelId={dialer.channelId}
          to={dialer.to}
          assisted={dialer.assisted}
          sessionId={dialer.sessionId}
          clientId={clientId}
          clientName={client.name}
          context={`${clientContext(client)}\n\n${recentInteractionsText(thread, client.name)}`}
          onTranscript={(t) => setLiveTranscript(t)}
          onEnded={(info) => {
            // log the call (with transcript → Walrus + summary) AND write the
            // transcript into the customer's memory so the AI recalls THIS call.
            logCall(clientId, { to: dialer.to, seconds: info.seconds, status: info.status, transcript: info.transcript })
              // once the call blob is on Walrus, refresh the on-chain memory map
              // so the cap → manifest → conversation-blobs chain includes it.
              .then(() => syncMemoryMap(clientId))
              .catch(() => {});
            if (info.transcript.trim()) writeClientMemory(clientId, `Phone call:\n${info.transcript}`).catch(() => {});
          }}
          onClose={() => { setDialer(null); void loadThread(); }}
        />
      )}

      {callChooser && (
        <div className="char-overlay" onClick={() => setCallChooser(false)}>
          <div className="char-modal" onClick={(e) => e.stopPropagation()}>
            <h2>📞 Call {client.name}</h2>
            <p className="cw-muted">Do you want the AI assistant on this call?</p>
            <div className="cw-call-choices">
              <button
                className="cw-choice"
                disabled={!selected?.voice_ready}
                onClick={() => { setCallChooser(false); openDialer(true); }}
              >
                <span className="cw-choice-t">🤖 With AI assistant</span>
                <span className="cw-choice-d">
                  {selected?.voice_ready
                    ? "Two-way call — the AI listens live, transcribes, and you can ask it mid-call. Saves to memory after."
                    : "Needs API Key + TwiML App on this Twilio channel (Settings → Channels)."}
                </span>
              </button>
              <button
                className="cw-choice"
                disabled={!selected?.voice_ready}
                onClick={() => { setCallChooser(false); openDialer(false); }}
              >
                <span className="cw-choice-t">📞 Just call</span>
                <span className="cw-choice-d">
                  {selected?.voice_ready
                    ? "Browser softphone — talk directly, no AI listening."
                    : "Needs API Key + TwiML App on this Twilio channel (Settings → Channels)."}
                </span>
              </button>
            </div>
            <div className="char-actions">
              <button onClick={() => setCallChooser(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// ── AI Copilot: a CONTINUOUS chat (keeps history, multi-turn — like a chat
// assistant), grounded in the customer's memory. Its own thread, separate from
// the message-to-send box; "Use ↦" drops a reply into the compose box. ──
function CopilotPane({
  clientId,
  clientName,
  context,
  onUse,
}: {
  clientId: number;
  clientName: string;
  context: string;
  onUse: (text: string) => void;
}) {
  const [turns, setTurns] = useState<CopilotTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [turns]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = async () => {
    const q = input.trim();
    if (!q || busy) return;
    setErr(null);
    setInput("");
    const history: CopilotTurn[] = [...turns, { role: "user", content: q }];
    setTurns([...history, { role: "assistant", content: "" }]); // placeholder for the streaming reply
    setBusy(true);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    let acc = "";
    try {
      await streamCopilot(clientId, history, (t) => {
        acc += t;
        setTurns((prev) => {
          const next = prev.slice();
          next[next.length - 1] = { role: "assistant", content: acc };
          return next;
        });
      }, ac.signal, context, characterPrompt(loadCharacter()), loadKnowledge());
    } catch (e) {
      if (!ac.signal.aborted) {
        setErr(e instanceof Error ? e.message : "copilot unavailable");
        setTurns((prev) => prev.slice(0, -1)); // drop the empty assistant turn
      }
    } finally {
      if (abortRef.current === ac) setBusy(false);
    }
  };

  const reset = () => { abortRef.current?.abort(); setBusy(false); setTurns([]); setErr(null); };

  return (
    <div className="cw-copilot">
      <div className="cw-copilot-head">
        <span className="cw-copilot-label">AI Copilot</span>
        {turns.length > 0 && <button className="cw-mini-btn" onClick={reset}>New chat</button>}
      </div>

      <div className="cw-cochat">
        {turns.length === 0 ? (
          <p className="cw-muted">
            Talk to the copilot continuously — draft replies, plan next steps, dig into history. It remembers this conversation and is grounded in {clientName}&apos;s memory. “Use ↦” drops a reply into the message box.
          </p>
        ) : (
          turns.map((t, i) => {
            const streaming = busy && i === turns.length - 1;
            return (
              <div key={i} className={`cw-co-msg ${t.role}`}>
                <div className="cw-co-bubble">
                  {t.content}
                  {streaming && <span className="cw-cursor">▍</span>}
                </div>
                {t.role === "assistant" && t.content && !streaming && (
                  <button className="cw-sugg-use" onClick={() => onUse(t.content)}>Use ↦</button>
                )}
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>

      {err && <p className="cw-err">{err}</p>}
      <div className="cw-copilot-ask">
        <textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message the copilot… (Enter to send, Shift+Enter for newline)"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
        />
        <button className="primary" onClick={() => void send()} disabled={busy || !input.trim()}>
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

// ── Pre-call brief: AI prep BEFORE you call, grounded in the customer's profile
// + memory, your knowledge base, and the objective of the call. Pure text — needs
// no mic, so it works as a "prep me" helper right on the screen before dialing. ──
function PreCallBrief({ client }: { client: Client }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async () => {
    setErr(null);
    setText("");
    setBusy(true);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    let acc = "";
    const ask =
      `Give me a concise PRE-CALL BRIEF for my upcoming call with ${client.name}. ` +
      "Use the customer profile, the objective of this relationship, my knowledge base, and recalled memory. " +
      "Structure it as:\n1) Who they are (1–2 lines)\n2) The objective of this call\n" +
      "3) Three talking points tailored to them\n4) Likely objections + how to handle them.\n" +
      "Keep it tight and glanceable while on the call.";
    try {
      await streamCopilot(
        client.id,
        [{ role: "user", content: ask }],
        (t) => { acc += t; setText(acc); },
        ac.signal,
        clientContext(client),
        characterPrompt(loadCharacter()),
        loadKnowledge(),
      );
    } catch (e) {
      if (!ac.signal.aborted) setErr(e instanceof Error ? e.message : "brief unavailable");
    } finally {
      if (abortRef.current === ac) setBusy(false);
    }
  };

  return (
    <div className="cw-brief">
      <div className="cw-brief-head">
        <span className="cw-brief-title">📋 Pre-call brief</span>
        <button className="cw-mini-btn" onClick={() => void run()} disabled={busy}>
          {busy ? "Thinking…" : text ? "Regenerate" : "Prep me for this call"}
        </button>
      </div>
      <p className="cw-muted">
        Grounded in {client.name}&apos;s profile + memory, your knowledge base, and the call objective.
      </p>
      {err && <p className="cw-err">{err}</p>}
      {text && <div className="cw-brief-body">{text}{busy && <span className="cw-cursor">▍</span>}</div>}
    </div>
  );
}

// ── After the call: save what was said into the customer's MemWal memory so the
// AI recalls it next time. analyzeAndWait extracts facts ("moved to Morocco")
// from the transcript + context and stores them as recallable memories. ──
function CallMemorySaver({ client, onSaved, initialTranscript }: { client: Client; onSaved?: () => void; initialTranscript?: string }) {
  const [transcript, setTranscript] = useState("");
  const [ctx, setCtx] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // when an assisted call ends, prefill with its captured transcript
  useEffect(() => {
    if (initialTranscript && initialTranscript.trim()) setTranscript(initialTranscript);
  }, [initialTranscript]);

  const save = async () => {
    if (!transcript.trim() || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const header = ctx.trim() ? `Phone call — ${ctx.trim()}` : "Phone call";
      const r = await writeClientMemory(client.id, `${header}\n\n${transcript.trim()}`);
      if (r.ok) {
        await addNote(client.id, `📞 ${header}`).catch(() => {}); // visible record in the thread
        syncMemoryMap(client.id).catch(() => {}); // refresh the on-chain memory map
        setMsg({ ok: true, text: `Saved to memory ✓ — ${r.saved}/${r.total} facts the AI will recall` });
        setTranscript("");
        setCtx("");
        onSaved?.();
      } else {
        setMsg({ ok: false, text: r.error });
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "save failed" });
    }
    setBusy(false);
  };

  return (
    <div className="cw-brief">
      <div className="cw-brief-head">
        <span className="cw-brief-title">📞 Log a call → memory</span>
      </div>
      <p className="cw-muted">
        After a call, paste what was said. The AI extracts the facts and remembers them about {client.name}
        {" "}— so next time it knows (e.g. &ldquo;moved to Morocco&rdquo;).
      </p>
      <input
        className="cw-to"
        style={{ width: "100%", marginBottom: 8 }}
        value={ctx}
        onChange={(e) => setCtx(e.target.value)}
        placeholder="Context (optional) — e.g. follow-up about pension"
      />
      <textarea
        rows={5}
        style={{ width: "100%", resize: "vertical" }}
        value={transcript}
        onChange={(e) => setTranscript(e.target.value)}
        placeholder="Paste the call transcript or notes of what was said…"
      />
      <div className="kb-actions" style={{ marginTop: 8 }}>
        <button className="cw-mini-btn" onClick={() => void save()} disabled={busy || !transcript.trim()}>
          {busy ? "Saving…" : "Save to memory"}
        </button>
        {msg && <span className={msg.ok ? "cw-ok" : "cw-err"}>{msg.text}</span>}
      </div>
    </div>
  );
}

// ── collapsible section shell ──
function Panel({ title, count, defaultOpen = true, children }: { title: string; count?: number; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`cw-panel${open ? " open" : ""}`}>
      <button className="cw-panel-head" onClick={() => setOpen((o) => !o)}>
        <FiChevronRight className="cw-panel-caret" />
        <span>{title}</span>
        {count != null && <span className="cw-panel-count">{count}</span>}
      </button>
      {open && <div className="cw-panel-body">{children}</div>}
    </section>
  );
}

function ProfilePanel({ client, onSaved }: { client: Client; onSaved: () => void }) {
  const [name, setName] = useState(client.name);
  const [phone, setPhone] = useState(client.phone ?? "");
  const [email, setEmail] = useState(client.email ?? "");
  const [relationship, setRelationship] = useState(client.relationship ?? "");
  const [dealStage, setDealStage] = useState(client.deal_stage ?? "");
  const [profile, setProfile] = useState(client.profile ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await updateClient(client.id, {
        name: name.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        relationship: relationship || undefined,
        deal_stage: dealStage || undefined,
        profile: profile.trim() || undefined,
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Profile">
      <label className="cw-f"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="cw-f"><span>Phone</span><input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
      <label className="cw-f"><span>Email</span><input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label className="cw-f"><span>Relationship</span><input value={relationship} onChange={(e) => setRelationship(e.target.value)} placeholder="Customer / Colleague / …" /></label>
      <label className="cw-f">
        <span>Deal stage</span>
        <select value={dealStage} onChange={(e) => setDealStage(e.target.value)}>
          {DEAL_STAGES.map((s) => <option key={s} value={s}>{s || "—"}</option>)}
        </select>
      </label>
      <label className="cw-f"><span>Notes</span><textarea rows={3} value={profile} onChange={(e) => setProfile(e.target.value)} /></label>
      <button className="primary" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save profile"}</button>
    </Panel>
  );
}

// Retrieve a blob straight from the public Walrus aggregator — a decentralized
// network independent of our backend. Walrus blob ids are content-addressed, so a
// successful fetch by id IS the integrity proof: you get back exactly what was
// stored, from decentralized storage, verified by the network.
function WalrusVerify({ blobId }: { blobId: string }) {
  const [state, setState] = useState<"idle" | "loading" | "ok" | "fail">("idle");
  const [bytes, setBytes] = useState(0);
  const [content, setContent] = useState("");

  const verify = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setState("loading");
    try {
      const res = await fetch(`${WALRUS_AGG}/v1/blobs/${blobId}`);
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      setBytes(new Blob([text]).size);
      setContent(text);
      setState("ok");
    } catch {
      setState("fail");
    }
  };

  return (
    <div className="cw-walrus" onClick={(e) => e.stopPropagation()}>
      <button className="cw-mini-btn" onClick={verify} disabled={state === "loading"}>
        {state === "loading" ? "Retrieving…" : state === "ok" ? "Re-verify on Walrus" : <><FiDatabase /> Verify on Walrus</>}
      </button>
      <a className="cw-walrus-link" href={`${WALRUS_AGG}/v1/blobs/${blobId}`} target="_blank" rel="noreferrer">open ↗</a>
      {state === "ok" && (
        <div className="cw-walrus-ok">
          <FiCheck /> Retrieved <b>{bytes}</b> bytes from the Walrus network — content-addressed &amp; verified.
          <pre className="cw-walrus-pre">{content.slice(0, 600)}</pre>
        </div>
      )}
      {state === "fail" && <div className="cw-walrus-fail">Couldn&apos;t reach the aggregator (CORS/network) — use “open ↗”.</div>}
    </div>
  );
}

function MemoryPanel({ clientId, entries }: { clientId: number; entries: string[] | null }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = results ?? entries;

  const search = async () => {
    setBusy(true);
    try {
      const r = await recallClientMemory(clientId, q.trim() || undefined);
      setResults(r.ok ? r.entries : []);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Memory (MemWal)" count={shown?.length}>
      <div className="cw-memq">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void search(); }}
          placeholder="Probe memory… e.g. “Casablanca”, “last call”"
        />
        <button className="cw-mini-btn" onClick={() => void search()} disabled={busy}>{busy ? "…" : "Recall"}</button>
      </div>
      <p className="cw-muted" style={{ fontSize: "0.7rem", margin: "4px 0 6px" }}>
        MemWal returns the closest matches (top-k), not a full list — type a fact to verify it&apos;s stored.
      </p>
      {shown == null ? (
        <p className="cw-muted">Recalling…</p>
      ) : shown.length === 0 ? (
        <p className="cw-muted">Nothing recalled{q ? ` for “${q}”` : ""} yet.</p>
      ) : (
        <ul className="cw-mem">{shown.map((t, i) => <li key={i}>{t}</li>)}</ul>
      )}
    </Panel>
  );
}

function SessionsPanel({ clientId, sessions, onChanged }: { clientId: number; sessions: SessionRow[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    try { await uploadPastCall(clientId, f); onChanged(); } finally { setBusy(false); e.target.value = ""; }
  };
  return (
    <Panel title="Sessions" count={sessions.length} defaultOpen={false}>
      <label className="cw-upload">
        <FiPaperclip /> {busy ? "Uploading…" : "Upload a past call (audio)"}
        <input type="file" accept="audio/*" hidden onChange={onUpload} disabled={busy} />
      </label>
      <ul className="cw-list">
        {sessions.map((s) => (
          <li key={s.id}>
            <Link href={`/sessions/${s.id}`}>
              {new Date(s.started_at).toLocaleString()}
              {s.summary ? ` · ${s.summary.slice(0, 40)}` : ""}
            </Link>
          </li>
        ))}
        {sessions.length === 0 && <li className="cw-muted">No sessions.</li>}
      </ul>
    </Panel>
  );
}

function FilesPanel({ clientId, files, onChanged }: { clientId: number; files: Attachment[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    try { await uploadAttachment(clientId, f); onChanged(); } finally { setBusy(false); e.target.value = ""; }
  };
  return (
    <Panel title="Files" count={files.length} defaultOpen={false}>
      <label className="cw-upload">
        <FiPaperclip /> {busy ? "Uploading…" : "Attach a file"}
        <input type="file" hidden onChange={onUpload} disabled={busy} />
      </label>
      <ul className="cw-list">
        {files.map((a) => (
          <li key={a.id}><a href={attachmentDownloadUrl(a.id)} target="_blank" rel="noreferrer">{a.filename}</a></li>
        ))}
        {files.length === 0 && <li className="cw-muted">No files.</li>}
      </ul>
    </Panel>
  );
}
