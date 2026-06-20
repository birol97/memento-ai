"use client";

// Compose + send via a connected channel, and view the message log (the start of
// the omnichannel inbox). Sent content is stored on Walrus by the backend.
import { useCallback, useEffect, useState } from "react";
import { SiTwilio } from "react-icons/si";
import { FiMail, FiPhoneCall } from "react-icons/fi";

import {
  hangupCall,
  listChannels,
  listMessages,
  sendMessage,
  type Channel,
  type Message,
} from "@/lib/api";
import { Dialer } from "@/components/Dialer";

const TWILIO_RED = "#F22F46";

/** Omnichannel icon per message kind — Twilio brand for SMS/calls. */
function MsgIcon({ kind }: { kind: string }) {
  if (kind === "email") return <FiMail size={18} color="#7aa2f7" />;
  if (kind === "call") return <FiPhoneCall size={18} color={TWILIO_RED} />;
  return <SiTwilio size={18} color={TWILIO_RED} />; // sms / twilio
}

function ChannelIcon({ kind }: { kind: string }) {
  return kind === "twilio" ? <SiTwilio color={TWILIO_RED} /> : <FiMail color="#7aa2f7" />;
}

const WALRUS_AGG =
  process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR ?? "https://aggregator.walrus-testnet.walrus.space";

export default function MessagesPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [channelId, setChannelId] = useState<number | "">("");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const [ch, ms] = await Promise.all([listChannels(), listMessages()]);
    setChannels(ch);
    setMessages(ms);
    if (channelId === "" && ch.length) setChannelId(ch[0].id);
  }, [channelId]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = channels.find((c) => c.id === channelId);
  const isEmail = selected?.kind === "email";
  const isTwilio = selected?.kind === "twilio";

  // Send email / SMS (needs a body).
  const doSend = async () => {
    if (channelId === "" || !to.trim() || !bodyText.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await sendMessage(channelId, {
        to: to.trim(),
        subject: isEmail ? subject : undefined,
        body: bodyText,
      });
      setMsg(r.ok ? { ok: true, text: "Sent ✓" } : { ok: false, text: `Failed: ${r.error ?? "error"} (recorded)` });
      setBodyText("");
      setSubject("");
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "failed" });
    }
    setBusy(false);
  };

  const onHangup = async (m: Message) => {
    if (!m.channel_id || !m.provider_id) return;
    try {
      await hangupCall(m.channel_id, m.provider_id);
      await load();
    } catch {
      /* call may already be ended */
    }
  };

  // In-app softphone (Twilio Voice SDK): open the Dialer for two-way talk.
  const [dialer, setDialer] = useState<{ channelId: number; to: string } | null>(null);
  const openDialer = () => {
    if (channelId === "" || !to.trim()) return;
    setDialer({ channelId, to: to.trim() });
  };

  return (
    <main className="container">
      <header>
        <h1>Inbox</h1>
        <p className="sub">
          One omnichannel timeline — email, SMS and calls across your connected accounts,
          stored on Walrus.
        </p>
      </header>

      <section className="card">
        <h2 className="card-title">
          Compose {selected && <span className="compose-ch-icon"><ChannelIcon kind={selected.kind} /></span>}
        </h2>
        {channels.length === 0 ? (
          <p className="empty">
            No channels connected. Add one on the <a href="/channels">Channels</a> page first.
          </p>
        ) : (
          <div className="msg-compose">
            <label className="ch-field">
              <span>From channel</span>
              <select value={channelId} onChange={(e) => setChannelId(Number(e.target.value))}>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.kind === "twilio" ? "📞" : "✉️"} {c.label} · {c.identity}
                  </option>
                ))}
              </select>
            </label>
            <label className="ch-field">
              <span>{isEmail ? "To (email)" : "To (phone, +15551234567)"}</span>
              <input value={to} onChange={(e) => setTo(e.target.value)} placeholder={isEmail ? "name@company.com" : "+1…"} />
            </label>
            {isEmail && (
              <label className="ch-field msg-wide">
                <span>Subject</span>
                <input value={subject} onChange={(e) => setSubject(e.target.value)} />
              </label>
            )}
            <label className="ch-field msg-wide">
              <span>{isTwilio ? "Message (for SMS)" : "Message"}</span>
              <textarea rows={4} value={bodyText} onChange={(e) => setBodyText(e.target.value)} />
            </label>
            <div className="msg-wide" style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button className="primary" onClick={() => void doSend()} disabled={busy || !bodyText.trim()}>
                {busy ? "Sending…" : isEmail ? "Send email" : "Send SMS"}
              </button>
              {isTwilio && (
                <button onClick={openDialer} disabled={!to.trim()}>
                  📞 Call (in-app)
                </button>
              )}
              {msg && <span className={msg.ok ? "ch-ok" : "ch-err"}>{msg.text}</span>}
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">Communication log</h2>
        {messages.length === 0 ? (
          <p className="empty">Nothing sent yet.</p>
        ) : (
          <ul className="msg-log">
            {messages.map((m) => (
              <li key={m.id} className="msg-row">
                <span className="msg-dir">{m.direction === "out" ? "↗" : "↘"}</span>
                <span className="msg-kind"><MsgIcon kind={m.kind} /></span>
                <span className="msg-body">
                  <strong>{m.to_addr}</strong>
                  {m.subject && <span className="msg-subj"> · {m.subject}</span>}
                  <div className="msg-preview">{(m.body ?? "").slice(0, 140)}</div>
                </span>
                <span className={`msg-status ${m.status === "sent" ? "ok" : "bad"}`}>
                  {m.status}
                  {m.kind === "call" && m.status === "sent" && m.provider_id && (
                    <button className="msg-hangup" onClick={() => void onHangup(m)}>End call</button>
                  )}
                </span>
                <span className="msg-meta">
                  {new Date(m.created_at).toLocaleString()}
                  {m.blob_id && (
                    <>
                      {" · "}
                      <a href={`${WALRUS_AGG}/v1/blobs/${m.blob_id}`} target="_blank" rel="noreferrer">
                        walrus ↗
                      </a>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dialer && (
        <Dialer
          channelId={dialer.channelId}
          to={dialer.to}
          onClose={() => setDialer(null)}
        />
      )}
    </main>
  );
}
