"use client";

// Create / edit the AI copilot's character — its name, persona, and the tools it
// may use. Lives in the Tribe section now (moved out of the customer workspace).
// Saved to localStorage via lib/character; every copilot across the app picks it up.
import { useState } from "react";
import { FiCheck } from "react-icons/fi";

import { TOOLS, loadCharacter, saveCharacter, type Character } from "@/lib/character";

export default function TribeCharacter() {
  const [c] = useState<Character>(loadCharacter);
  const [name, setName] = useState(c.name);
  const [persona, setPersona] = useState(c.persona);
  const [tools, setTools] = useState(c.tools);
  const [saved, setSaved] = useState(false);

  const save = () => {
    saveCharacter({ name: name.trim() || "Copilot", persona: persona.trim(), tools });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="tc">
      <div className="tc-head">
        <h2 className="tc-title">AI Character</h2>
        <p className="tc-sub">Give your copilot a persona and choose which tools it can use. It applies everywhere the AI helps you.</p>
      </div>

      <div className="tc-grid">
        <section className="tm-block">
          <label className="tc-f"><span>Name</span>
            <input className="tm-in" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sales Copilot" />
          </label>
          <label className="tc-f"><span>Persona / instructions</span>
            <textarea className="tm-in" rows={6} value={persona} onChange={(e) => setPersona(e.target.value)}
              placeholder="How should it behave — its tone, focus, what to avoid…" />
          </label>
          <button className="tm-btn primary" onClick={save}>{saved ? <><FiCheck /> Saved</> : "Save character"}</button>
        </section>

        <section className="tm-block">
          <div className="tc-tools-title">Tools it can access</div>
          {TOOLS.map((t) => (
            <label key={t.key} className="tc-tool">
              <input type="checkbox" checked={!!tools[t.key]} onChange={(e) => setTools((p) => ({ ...p, [t.key]: e.target.checked }))} />
              <span className="tc-tool-text">
                <span className="tc-tool-label">{t.label}</span>
                <span className="tc-tool-desc">{t.desc}</span>
              </span>
            </label>
          ))}
        </section>
      </div>
    </div>
  );
}
