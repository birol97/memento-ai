"use client";

import { useMemo, useState } from "react";
import type { IconType } from "react-icons";
import { SiGmail, SiSlack, SiWhatsapp } from "react-icons/si";
import { FiPhone } from "react-icons/fi";
import { FaMicrosoft } from "react-icons/fa6";

import { rememberRaw } from "@/app/actions/memory";
import { createClient } from "@/lib/api";
import { clientNamespace } from "@/lib/clientNamespace";
import type { Client } from "@/lib/types";

interface Props {
  /** Called with the freshly created character (its namespace = salescall-client-<id>). */
  onCreated: (client: Client) => void;
  disabled?: boolean;
}

type ChannelKey = "phone" | "email" | "whatsapp" | "slack" | "teams";

interface ChannelDef {
  key: ChannelKey;
  label: string;
  placeholder: string;
  Icon: IconType;
  color: string;
}

const CHANNELS: ChannelDef[] = [
  { key: "phone", label: "Phone", placeholder: "+1 555 …", Icon: FiPhone, color: "#22d3ee" },
  { key: "email", label: "Email", placeholder: "name@company.com", Icon: SiGmail, color: "#EA4335" },
  { key: "whatsapp", label: "WhatsApp", placeholder: "+1 555 …", Icon: SiWhatsapp, color: "#25D366" },
  { key: "slack", label: "Slack", placeholder: "@user / member id", Icon: SiSlack, color: "#36C5F0" },
  { key: "teams", label: "Teams", placeholder: "email / UPN", Icon: FaMicrosoft, color: "#6264A7" },
];

// How this person relates to ME — drives how the live advisor frames its
// advice (a colleague/friend isn't a sales prospect; an expert is helping me).
const RELATIONSHIPS = [
  "Customer",
  "Colleague",
  "Friend",
  "Expert helping me",
  "Mentor",
] as const;

/**
 * A "character" is one customer = one private memory space on Walrus
 * (salescall-client-<id>). Creating a character lets you declare which channels
 * you'll talk to them on (phone / email / Teams / …), how they relate to you,
 * and seed anything you already know — that seed is written straight into their
 * memory namespace so the copilot can recall it on the very first conversation.
 */
export function CreateCharacterButton({ onCreated, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [channels, setChannels] = useState<Record<ChannelKey, string>>({
    phone: "",
    email: "",
    whatsapp: "",
    slack: "",
    teams: "",
  });
  const [enabled, setEnabled] = useState<Set<ChannelKey>>(new Set());
  const [relationship, setRelationship] = useState<string>("");
  const [known, setKnown] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<Client | null>(null);

  const reset = () => {
    setName("");
    setChannels({ phone: "", email: "", whatsapp: "", slack: "", teams: "" });
    setEnabled(new Set());
    setRelationship("");
    setKnown("");
    setErr(null);
  };

  const toggle = (key: ChannelKey) =>
    setEnabled((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // Human-readable summary of the channels the user filled in.
  const channelLines = useMemo(
    () =>
      CHANNELS.filter((c) => enabled.has(c.key) && channels[c.key].trim())
        .map((c) => `${c.label}: ${channels[c.key].trim()}`),
    [enabled, channels],
  );

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      // Phone column drives inbound identity resolution; fall back to WhatsApp.
      const phone =
        (enabled.has("phone") && channels.phone.trim()) ||
        (enabled.has("whatsapp") && channels.whatsapp.trim()) ||
        undefined;
      const email = (enabled.has("email") && channels.email.trim()) || undefined;
      const profile = channelLines.length
        ? `Reachable on — ${channelLines.join(" · ")}`
        : undefined;

      const c = await createClient({
        name: name.trim(),
        phone: phone || undefined,
        email: email || undefined,
        profile,
        relationship: relationship || undefined,
      });

      // The character exists the moment createClient returns — hand off and
      // close immediately so we never block on the (sometimes slow) Walrus write.
      const seedParts = [
        channelLines.length ? `Channels — ${channelLines.join("; ")}.` : "",
        known.trim(),
      ].filter(Boolean);
      setCreated(c);
      onCreated(c);
      reset();
      setOpen(false);

      // Seed the character's memory in the background, so recall returns it from
      // the first conversation. Best-effort — a memory hiccup never blocks create.
      if (seedParts.length) {
        void rememberRaw(clientNamespace(c.id), seedParts.join("\n")).catch(() => {});
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ns-create">
      <button
        type="button"
        className="ns-create-btn"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
      >
        + Create character
      </button>

      {created && !open && (
        <span className="ns-created">
          ✅ created <strong>{created.name}</strong> · <code>{clientNamespace(created.id)}</code>
        </span>
      )}

      {open && (
        <div className="ns-create-pop wide" role="dialog" aria-label="Create character">
          <div className="ns-create-title">Create a character</div>
          <p className="ns-create-hint">
            One character = one private memory space on Walrus
            (<code>salescall-client-&lt;id&gt;</code>). Pick the channels you talk to them on
            and seed anything you already know.
          </p>

          <input
            autoFocus
            type="text"
            placeholder="name / who they are *"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          <div className="char-section-label">Relationship to you</div>
          <div className="char-chips">
            {RELATIONSHIPS.map((r) => (
              <button
                type="button"
                key={r}
                className={`char-chip${relationship === r ? " on" : ""}`}
                onClick={() => setRelationship((cur) => (cur === r ? "" : r))}
              >
                {r}
              </button>
            ))}
          </div>

          <div className="char-section-label">Available channels</div>
          <div className="char-chips">
            {CHANNELS.map(({ key, label, Icon, color }) => (
              <button
                type="button"
                key={key}
                className={`char-chip${enabled.has(key) ? " on" : ""}`}
                onClick={() => toggle(key)}
                style={enabled.has(key) ? { borderColor: color, color } : undefined}
              >
                <Icon size={16} color={color} />
                {label}
              </button>
            ))}
          </div>

          {CHANNELS.filter((c) => enabled.has(c.key)).map(({ key, label, placeholder }) => (
            <input
              key={key}
              type={key === "phone" || key === "whatsapp" ? "tel" : "text"}
              placeholder={`${label} — ${placeholder}`}
              value={channels[key]}
              onChange={(e) => setChannels((p) => ({ ...p, [key]: e.target.value }))}
            />
          ))}

          <div className="char-section-label">What you already know</div>
          <textarea
            rows={3}
            placeholder="Anything grabbed before — past notes, context, who they are… (seeded into memory)"
            value={known}
            onChange={(e) => setKnown(e.target.value)}
          />

          {err && <div className="ns-create-err">{err}</div>}
          <div className="ns-create-actions">
            <button type="button" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={submit}
              disabled={busy || !name.trim()}
            >
              {busy ? "Creating…" : "Create character"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
