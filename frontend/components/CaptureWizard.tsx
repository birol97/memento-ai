"use client";

import { useState } from "react";
import type { IconType } from "react-icons";
import { SiGmail, SiSlack, SiWhatsapp, SiGooglemeet } from "react-icons/si";
import { FiUploadCloud, FiFileText } from "react-icons/fi";

import { ClientPicker } from "./ClientPicker";
import { CreateCharacterButton } from "./CreateCharacterButton";
import { Recorder } from "./Recorder";
import { clientNamespace } from "@/lib/clientNamespace";
import type { Client } from "@/lib/types";

const SUI_EXPLORER = process.env.NEXT_PUBLIC_SUI_EXPLORER ?? "https://suiscan.xyz/testnet";

type ChannelKey = "upload" | "email" | "sms" | "slack" | "meeting" | "note";

const CHANNELS: {
  key: ChannelKey;
  label: string;
  hint: string;
  kind: "voice" | "text";
  fromLabel?: string;
  Icon: IconType;
  color: string;
}[] = [
  { key: "email", label: "Gmail", hint: "Paste an email / thread", kind: "text", fromLabel: "sender email", Icon: SiGmail, color: "#EA4335" },
  { key: "slack", label: "Slack", hint: "Paste a Slack conversation", kind: "text", fromLabel: "sender", Icon: SiSlack, color: "#36C5F0" },
  { key: "sms", label: "WhatsApp / SMS", hint: "Paste a message thread", kind: "text", fromLabel: "phone", Icon: SiWhatsapp, color: "#25D366" },
  { key: "meeting", label: "Meeting", hint: "Paste a meeting transcript", kind: "text", fromLabel: "attendee", Icon: SiGooglemeet, color: "#2684FC" },
  { key: "upload", label: "Upload recording", hint: "Audio file → transcribe", kind: "voice", Icon: FiUploadCloud, color: "#22d3ee" },
  { key: "note", label: "Note", hint: "Type a quick note", kind: "text", Icon: FiFileText, color: "#8793ab" },
];

export function CaptureWizard() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [client, setClient] = useState<Client | null>(null);
  const [channel, setChannel] = useState<ChannelKey | null>(null);

  const channelDef = CHANNELS.find((c) => c.key === channel) ?? null;

  return (
    <div className="wiz">
      <ol className="wiz-steps">
        {[
          [1, "Customer"],
          [2, "Channel"],
          [3, "Capture"],
        ].map(([n, label]) => (
          <li
            key={n as number}
            className={`wiz-step${step === n ? " active" : ""}${step > (n as number) ? " done" : ""}`}
          >
            <span className="wiz-num">{step > (n as number) ? "✓" : (n as number)}</span>
            <span className="wiz-label">{label}</span>
          </li>
        ))}
      </ol>

      {/* Step 1 — customer */}
      {step === 1 && (
        <div className="wiz-panel">
          <h2 className="wiz-title">Who is this about?</h2>
          <p className="wiz-sub">Pick a character, or create a new one.</p>
          <div className="wiz-pick">
            <ClientPicker value={client} onChange={setClient} />
            <CreateCharacterButton onCreated={setClient} />
          </div>
          {client && <p className="wiz-ns">🗂 {clientNamespace(client.id)}</p>}
          <div className="wiz-actions">
            <button className="wiz-next" disabled={!client} onClick={() => setStep(2)}>
              Next →
            </button>
          </div>
        </div>
      )}

      {/* Step 2 — channel */}
      {step === 2 && (
        <div className="wiz-panel">
          <h2 className="wiz-title">Where is the information from?</h2>
          <p className="wiz-sub">
            Pick a channel to capture into {client?.name}&apos;s memory. For a live call, use the{" "}
            <strong>Assistant</strong> tab.
          </p>
          <div className="channel-grid">
            {CHANNELS.map((c) => (
              <button
                key={c.key}
                className={`channel-card${channel === c.key ? " active" : ""}`}
                onClick={() => setChannel(c.key)}
              >
                <span className="channel-icon">
                  <c.Icon size={26} color={c.color} />
                </span>
                <span className="channel-name">{c.label}</span>
                <span className="channel-hint">{c.hint}</span>
              </button>
            ))}
          </div>
          <div className="wiz-actions">
            <button className="wiz-back" onClick={() => setStep(1)}>
              ← Back
            </button>
            <button className="wiz-next" disabled={!channel} onClick={() => setStep(3)}>
              Next →
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — capture */}
      {step === 3 && client && channelDef && (
        <div className="wiz-panel">
          <div className="wiz-capture-head">
            <button className="wiz-back" onClick={() => setStep(2)}>
              ← Change channel
            </button>
            <span className="wiz-context">
              <channelDef.Icon size={16} color={channelDef.color} />{" "}
              {channelDef.label} → <strong>{client.name}</strong>
            </span>
          </div>

          {channelDef.kind === "voice" ? (
            <Recorder presetClient={client} />
          ) : (
            <TextCapture client={client} channel={channelDef} />
          )}
        </div>
      )}
    </div>
  );
}

function TextCapture({
  client,
  channel,
}: {
  client: Client;
  channel: { key: ChannelKey; label: string; fromLabel?: string };
}) {
  const [from, setFrom] = useState("");
  const [threadId, setThreadId] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<
    | { genericCount: number; specificCount: number; subLabel: string; anchorDigest?: string }
    | { error: string }
    | null
  >(null);

  const submit = async () => {
    if (!text.trim()) return;
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: channel.key,
          clientId: client.id,
          from: from.trim() || undefined,
          text: text.trim(),
          threadId: threadId.trim() || undefined,
        }),
      });
      const j = await res.json();
      if (j.ok) {
        setResult({
          genericCount: j.genericCount ?? 0,
          specificCount: j.specificCount ?? 0,
          subLabel: j.subLabel,
          anchorDigest: j.anchorDigest,
        });
        setText("");
        setThreadId("");
      } else {
        setResult({ error: j.error || "failed" });
      }
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : "request failed" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="text-capture">
      <div className="tc-row">
        <input
          className="tc-input"
          placeholder={channel.fromLabel ? `${channel.fromLabel} (optional)` : "from (optional)"}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          disabled={saving}
        />
        <input
          className="tc-input"
          placeholder="thread / subject (optional)"
          value={threadId}
          onChange={(e) => setThreadId(e.target.value)}
          disabled={saving}
        />
      </div>
      <textarea
        className="tc-text"
        rows={8}
        placeholder={`Paste the ${channel.label.toLowerCase()} content here…`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={saving}
      />
      <div className="wiz-actions">
        <button className="wiz-next" onClick={submit} disabled={saving || !text.trim()}>
          {saving ? "Saving to memory…" : "Save to memory"}
        </button>
      </div>

      {result && "subLabel" in result && (
        <div className="tc-ok">
          ✅ {result.genericCount} profile fact{result.genericCount === 1 ? "" : "s"} → generic ·{" "}
          {result.specificCount} note{result.specificCount === 1 ? "" : "s"} + raw → “{result.subLabel}”
          {result.anchorDigest && (
            <>
              {" · "}
              <a href={`${SUI_EXPLORER}/tx/${result.anchorDigest}`} target="_blank" rel="noreferrer">
                anchored on Sui ↗
              </a>
            </>
          )}
        </div>
      )}
      {result && "error" in result && <div className="error">{result.error}</div>}
    </div>
  );
}
