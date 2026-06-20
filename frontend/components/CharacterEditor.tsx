"use client";

// Edit the AI copilot's character: its name, persona, and which tools it may use.
import { useState } from "react";

import { TOOLS, saveCharacter, type Character } from "@/lib/character";

export function CharacterEditor({
  initial,
  onSave,
  onClose,
}: {
  initial: Character;
  onSave: (c: Character) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [persona, setPersona] = useState(initial.persona);
  const [tools, setTools] = useState(initial.tools);

  const save = () => {
    const c: Character = { name: name.trim() || "Copilot", persona: persona.trim(), tools };
    saveCharacter(c);
    onSave(c);
    onClose();
  };

  return (
    <div className="char-overlay" onClick={onClose}>
      <div className="char-modal" onClick={(e) => e.stopPropagation()}>
        <h2>🎭 AI Character</h2>
        <p className="cw-muted">Give the copilot a persona and choose which tools it can use.</p>

        <label className="cw-f"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="cw-f">
          <span>Persona / instructions</span>
          <textarea rows={4} value={persona} onChange={(e) => setPersona(e.target.value)} placeholder="How should the copilot behave, its tone, what it should focus on…" />
        </label>

        <div className="char-tools">
          <div className="char-tools-title">Tools it can access</div>
          {TOOLS.map((t) => (
            <label key={t.key} className="char-tool">
              <input
                type="checkbox"
                checked={!!tools[t.key]}
                onChange={(e) => setTools((p) => ({ ...p, [t.key]: e.target.checked }))}
              />
              <span className="char-tool-label">{t.label}</span>
              <span className="char-tool-desc">{t.desc}</span>
            </label>
          ))}
        </div>

        <div className="char-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>Save character</button>
        </div>
      </div>
    </div>
  );
}
