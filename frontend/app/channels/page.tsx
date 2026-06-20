"use client";

// Connections — one card per provider (Twilio, Email) with an elegant toggle.
// Flip a provider on to reveal its credential form and connect; connected
// providers show their account(s) with live status. Multiple accounts per
// provider are supported ("add another"). Credentials are encrypted server-side.
import { useCallback, useEffect, useState } from "react";

import {
  addChannel,
  deleteChannel,
  listChannels,
  testChannel,
  type Channel,
  type ChannelKind,
} from "@/lib/api";
import { VoiceEnrollment } from "@/components/VoiceEnrollment";
import { loadKnowledge, saveKnowledge } from "@/lib/knowledge";

type FieldDef = { key: string; label: string; type?: "text" | "password" | "number"; placeholder?: string; optional?: boolean };
type Provider = { kind: ChannelKind; title: string; icon: string; blurb: string; fields: FieldDef[] };

const PROVIDERS: Provider[] = [
  {
    kind: "twilio",
    title: "Twilio",
    icon: "📞",
    blurb: "Make calls & send SMS from your Twilio number. API key + TwiML App enable in-app calling.",
    fields: [
      { key: "label", label: "Label", placeholder: "e.g. Main line", optional: true },
      { key: "account_sid", label: "Account SID", placeholder: "ACxxxxxxxx" },
      { key: "auth_token", label: "Auth Token", type: "password" },
      { key: "phone_number", label: "Phone number", placeholder: "+15551234567" },
      { key: "api_key_sid", label: "API Key SID (for in-app calling)", placeholder: "SKxxxxxxxx", optional: true },
      { key: "api_key_secret", label: "API Key Secret", type: "password", optional: true },
      { key: "twiml_app_sid", label: "TwiML App SID", placeholder: "APxxxxxxxx", optional: true },
    ],
  },
  {
    kind: "email",
    title: "Email",
    icon: "✉️",
    blurb: "Send & receive email via your mailbox (SMTP).",
    fields: [
      { key: "label", label: "Label", placeholder: "e.g. Sales inbox", optional: true },
      { key: "from_email", label: "From address", placeholder: "you@company.com" },
      { key: "smtp_host", label: "SMTP host", placeholder: "smtp.gmail.com" },
      { key: "smtp_port", label: "SMTP port", type: "number", placeholder: "587" },
      { key: "smtp_username", label: "Username", placeholder: "you@company.com" },
      { key: "smtp_password", label: "Password / app password", type: "password" },
    ],
  },
];

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`toggle${on ? " on" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="toggle-knob" />
    </button>
  );
}

type SettingsTab = "channels" | "voice" | "knowledge";

const SETTINGS_TABS: { key: SettingsTab; label: string; icon: string }[] = [
  { key: "channels", label: "Channels", icon: "🔌" },
  { key: "voice", label: "My voice", icon: "🎙" },
  { key: "knowledge", label: "Knowledge base", icon: "📚" },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("channels");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setChannels(await listChannels());
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="container">
      <header>
        <h1>Settings</h1>
        <p className="sub">Connect channels, enroll your voice, and give the AI your knowledge base.</p>
      </header>

      <div className="set-tabs">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.key}
            className={`set-tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            <span>{t.icon}</span> {t.label}
          </button>
        ))}
      </div>

      {tab === "channels" && (
        <section>
          <p className="sub">
            Toggle a channel on, enter its credentials, and connect. Calls &amp; messages
            flow through your own accounts; everything is stored on Walrus.
          </p>
          {loading ? (
            <p className="empty">loading…</p>
          ) : (
            <div className="conn-grid">
              {PROVIDERS.map((p) => (
                <ProviderCard
                  key={p.kind}
                  provider={p}
                  accounts={channels.filter((c) => c.kind === p.kind)}
                  onChanged={load}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "voice" && (
        <section className="set-pane">
          <h2 className="set-h2">🎙 Your voice</h2>
          <p className="sub">
            Enroll a short sample of your voice once. The live assistant uses it to tell
            <b> you</b> apart from the customer while transcribing the call.
          </p>
          <VoiceEnrollment />
        </section>
      )}

      {tab === "knowledge" && (
        <section className="set-pane">
          <KnowledgeBase />
        </section>
      )}
    </main>
  );
}

function KnowledgeBase() {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setText(loadKnowledge());
  }, []);

  const save = () => {
    saveKnowledge(text);
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  };

  return (
    <>
      <h2 className="set-h2">📚 Knowledge base</h2>
      <p className="sub">
        Your playbook — products, pitch angles, objection handling, policies. The AI copilot
        and the live call advisor use this (plus the customer&apos;s profile and the call
        objective) to ground their advice in <b>your</b> knowledge.
      </p>
      <textarea
        className="kb-text"
        rows={16}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"e.g.\n• We sell low-cost index & dividend ETFs; min ticket $1k.\n• If they worry about risk → emphasize diversification + long horizon.\n• Never promise returns; always say 'historically'.\n• Competitor X is pricier; we have no account fees."}
      />
      <div className="kb-actions">
        <button className="wiz-next" onClick={save}>Save knowledge base</button>
        {saved && <span className="ch-ok">Saved ✓</span>}
      </div>
    </>
  );
}

function ProviderCard({
  provider,
  accounts,
  onChanged,
}: {
  provider: Provider;
  accounts: Channel[];
  onChanged: () => Promise<void>;
}) {
  const connected = accounts.length > 0;
  const [open, setOpen] = useState(false); // form revealed
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const on = connected || open;

  const flip = async () => {
    if (!on) {
      setOpen(true);
      setMsg(null);
      return;
    }
    // turning off: if accounts exist, disconnect them all (with confirm)
    if (connected) {
      if (!window.confirm(`Disconnect all ${provider.title} accounts?`)) return;
      setBusy(true);
      await Promise.all(accounts.map((a) => deleteChannel(a.id)));
      setBusy(false);
      await onChanged();
    }
    setOpen(false);
    setForm({});
    setMsg(null);
  };

  const connect = async () => {
    // Validate required fields up front so an incomplete form gives a clear
    // message instead of a bare 400 from the backend. Optional fields (e.g.
    // TwiML App SID, API Key) may be left blank.
    const missing = provider.fields.filter((f) => !f.optional && !(form[f.key] ?? "").trim());
    if (missing.length) {
      setMsg({ ok: false, text: `Please fill: ${missing.map((f) => f.label).join(", ")}` });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const { label, ...config } = form;
      const r = await addChannel(provider.kind, label || provider.title, config as Record<string, string>);
      setMsg(
        r.test.ok
          ? { ok: true, text: "Connected ✓" }
          : { ok: false, text: `Saved, but test failed: ${r.test.error ?? "error"}` },
      );
      setForm({});
      await onChanged();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "failed to connect" });
    }
    setBusy(false);
  };

  return (
    <section className={`conn-card${on ? " on" : ""}`}>
      <div className="conn-head">
        <span className="conn-icon">{provider.icon}</span>
        <span className="conn-meta">
          <strong>{provider.title}</strong>
          <span className="conn-blurb">{provider.blurb}</span>
        </span>
        <span className={`conn-state ${connected ? "ok" : ""}`}>
          {connected ? `${accounts.length} connected` : "off"}
        </span>
        <Toggle on={on} onClick={() => void flip()} disabled={busy} />
      </div>

      {on && (
        <div className="conn-body">
          {accounts.length > 0 && (
            <ul className="conn-accounts">
              {accounts.map((a) => (
                <li key={a.id}>
                  <span className="conn-acc-id">
                    <strong>{a.label}</strong>
                    {a.identity && <span className="conn-acc-identity"> · {a.identity}</span>}
                  </span>
                  <span className={`conn-acc-status ${a.status === "connected" ? "ok" : "bad"}`}>
                    ● {a.status}
                  </span>
                  <span className="conn-acc-actions">
                    <button onClick={async () => { await testChannel(a.id); await onChanged(); }}>test</button>
                    <button className="danger" onClick={async () => { await deleteChannel(a.id); await onChanged(); }}>
                      remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="conn-form">
            {provider.fields.map((f) => (
              <label key={f.key} className="ch-field">
                <span>{f.label}{f.optional && <em className="ch-opt"> (optional)</em>}</span>
                <input
                  type={f.type ?? "text"}
                  value={form[f.key] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <div className="conn-actions">
            <button className="primary" onClick={() => void connect()} disabled={busy}>
              {busy ? "Connecting…" : connected ? `Add another ${provider.title}` : `Connect ${provider.title}`}
            </button>
            {msg && <span className={msg.ok ? "ch-ok" : "ch-err"}>{msg.text}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
