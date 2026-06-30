"use client";

// Public hero / landing page — the first thing a signed-out visitor sees (and what
// a shared link on X lands on). It explains Memento AI, its use cases, and launches
// the app. The actual auth logic stays in AuthGate; this is the presentation + the
// launch CTAs. Core pitch: customers change and employees change, but the
// organization's memory and history stay — owned on-chain (Sui + Walrus).
import { useState } from "react";

import { Logo } from "@/components/Logo";

const X_URL = "https://x.com";

interface LandingProps {
  /** org (Google / zkLogin) sign-in */
  busy: boolean;
  connecting: boolean;
  googleReady: boolean;
  onGoogle: () => void;
  /** employee ("customer") sign-in by key */
  empBusy: boolean;
  empErr: string | null;
  onEmployeeSignIn: (publicKey: string, privateKey: string) => void;
  /** org sign-in error */
  error: string | null;
}

export function Landing({
  busy,
  connecting,
  googleReady,
  onGoogle,
  empBusy,
  empErr,
  onEmployeeSignIn,
  error,
}: LandingProps) {
  const [empMode, setEmpMode] = useState(false);
  const [empPub, setEmpPub] = useState("");
  const [empPriv, setEmpPriv] = useState("");

  const googleLabel = busy
    ? "Signing you in…"
    : connecting
      ? "Connecting…"
      : googleReady
        ? "Continue with Google"
        : "Loading…";

  function launch() {
    if (!busy && !connecting && googleReady) onGoogle();
    document.getElementById("launch")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <div className="lp">
      {/* ── top nav ─────────────────────────────────────────────── */}
      <header className="lp-nav">
        <a className="lp-brand" href="#top">
          <Logo size={30} />
          <span>Memento&nbsp;AI</span>
        </a>
        <nav className="lp-nav-links">
          <a href="#why">Why</a>
          <a href="#uses">Use cases</a>
          <a href="#how">How it works</a>
        </nav>
        <button className="lp-nav-cta" onClick={launch}>Launch app</button>
      </header>

      {/* ── hero ────────────────────────────────────────────────── */}
      <section className="lp-hero" id="top">
        <div className="lp-hero-glow" aria-hidden />
        <div className="lp-hero-inner">
          <span className="lp-eyebrow">On-chain institutional memory · Sui&nbsp;+&nbsp;Walrus</span>
          <h1 className="lp-h1">
            People leave.<br />
            <span className="lp-accent">Knowledge stays.</span>
          </h1>
          <p className="lp-sub">
            Memento&nbsp;AI turns every customer conversation into institutional memory
            your organization owns&nbsp;forever. Reps come and go. Customers evolve. The
            relationship — every call, commitment, and signal — stays with the org,
            anchored on-chain.
          </p>

          <div className="lp-cta" id="launch">
            {!empMode ? (
              <>
                <button className="lp-btn-google" onClick={onGoogle} disabled={busy || connecting || !googleReady}>
                  {googleLabel}
                </button>
                <button className="lp-btn-ghost" onClick={() => setEmpMode(true)}>
                  I&apos;m an employee →
                </button>
              </>
            ) : (
              <div className="lp-emp">
                <label className="lp-lbl">Public key</label>
                <input
                  className="lp-in"
                  placeholder="0x… (optional — view only)"
                  value={empPub}
                  onChange={(e) => setEmpPub(e.target.value)}
                />
                <label className="lp-lbl">Private key</label>
                <input
                  className="lp-in"
                  type="password"
                  placeholder="your key (for read / write)"
                  value={empPriv}
                  onChange={(e) => setEmpPriv(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") onEmployeeSignIn(empPub, empPriv); }}
                />
                <button
                  className="lp-btn-google"
                  onClick={() => onEmployeeSignIn(empPub, empPriv)}
                  disabled={empBusy || (!empPriv.trim() && !empPub.trim())}
                >
                  {empBusy ? "Checking access…" : "Sign in as employee"}
                </button>
                <button className="lp-btn-ghost" onClick={() => setEmpMode(false)}>← Back</button>
                {empErr && <p className="lp-err">⚠ {empErr}</p>}
                <p className="lp-fineprint">You&apos;ll see only the customers your org granted your key.</p>
              </div>
            )}
          </div>

          {error && <p className="lp-err">⚠ {error}</p>}
          {!empMode && (
            <p className="lp-trust">
              Gasless sign-in with Google (zkLogin) — no wallet, no seed phrase.
              Your memory lives on Sui&nbsp;&amp;&nbsp;Walrus, not a vendor database.
            </p>
          )}
        </div>
      </section>

      {/* ── what changes vs. what stays ─────────────────────────── */}
      <section className="lp-section" id="why">
        <h2 className="lp-h2">What changes — and what doesn&apos;t</h2>
        <p className="lp-lede">
          Your org is in constant motion. Memento separates the parts that turn over
          from the one thing that should never be lost.
        </p>
        <div className="lp-trio">
          <div className="lp-change">
            <span className="lp-tag lp-tag-flux">changes</span>
            <h3>Customers</h3>
            <p>New contacts arrive, deals evolve, accounts churn and come back. The roster never stops moving.</p>
          </div>
          <div className="lp-change">
            <span className="lp-tag lp-tag-flux">changes</span>
            <h3>Employees</h3>
            <p>Reps leave, new hires onboard, teams reshuffle. Tribal knowledge usually walks out the door with them.</p>
          </div>
          <div className="lp-change lp-stays">
            <span className="lp-tag lp-tag-stay">stays</span>
            <h3>Your org&apos;s memory</h3>
            <p>Every relationship, conversation, and commitment — owned by the organization, on-chain, for good. This is the asset.</p>
          </div>
        </div>
      </section>

      {/* ── use cases ───────────────────────────────────────────── */}
      <section className="lp-section lp-section-alt" id="uses">
        <h2 className="lp-h2">Built for teams that can&apos;t afford to forget</h2>
        <div className="lp-grid">
          <article className="lp-card">
            <div className="lp-card-ic">🎧</div>
            <h3>Live call copilot</h3>
            <p>Real-time suggestions during the call, grounded in everything the org already remembers about this customer.</p>
          </article>
          <article className="lp-card">
            <div className="lp-card-ic">🔁</div>
            <h3>Zero-loss handoffs</h3>
            <p>When a rep leaves, the next one inherits the full relationship history. No knowledge walks out the door.</p>
          </article>
          <article className="lp-card">
            <div className="lp-card-ic">🔐</div>
            <h3>You own the memory</h3>
            <p>Customer memory is anchored on Sui and stored on Walrus — portable, verifiable, and independent of any vendor.</p>
          </article>
          <article className="lp-card">
            <div className="lp-card-ic">🧭</div>
            <h3>Org-grade access</h3>
            <p>Delegate a customer&apos;s memory to an employee on-chain, then revoke it instantly the moment they leave.</p>
          </article>
        </div>
      </section>

      {/* ── how it works ────────────────────────────────────────── */}
      <section className="lp-section" id="how">
        <h2 className="lp-h2">How it works</h2>
        <ol className="lp-steps">
          <li>
            <span className="lp-step-n">1</span>
            <div>
              <h3>Sign in with Google</h3>
              <p>Get a Sui identity via zkLogin — gasless, no wallet, no seed phrase. Your org is created on-chain.</p>
            </div>
          </li>
          <li>
            <span className="lp-step-n">2</span>
            <div>
              <h3>Capture conversations</h3>
              <p>Calls, notes, any channel — distilled into typed memory and anchored to each customer.</p>
            </div>
          </li>
          <li>
            <span className="lp-step-n">3</span>
            <div>
              <h3>Recall everywhere</h3>
              <p>The copilot and every teammate recall it instantly. People change; the memory stays with the org.</p>
            </div>
          </li>
        </ol>
        <div className="lp-final">
          <h2 className="lp-h2">Start building memory your org keeps.</h2>
          <button className="lp-btn-google lp-btn-wide" onClick={onGoogle} disabled={busy || connecting || !googleReady}>
            {googleLabel}
          </button>
        </div>
      </section>

      {/* ── footer ──────────────────────────────────────────────── */}
      <footer className="lp-footer">
        <div className="lp-foot-brand">
          <Logo size={22} />
          <span>Memento&nbsp;AI</span>
        </div>
        <span className="lp-foot-meta">On-chain memory · Built on Sui&nbsp;+&nbsp;Walrus</span>
        <a className="lp-foot-x" href={X_URL} target="_blank" rel="noopener noreferrer">Follow on X ↗</a>
      </footer>
    </div>
  );
}
