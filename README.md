<div align="center">

# 🧠 Memento AI

### Verifiable organizational memory for AI agents — owned by the company, on Sui + Walrus.

*A live conversation copilot whose every memory is content-addressed on Walrus and whose
ownership is a Sui object. Employees get cryptographic, per-customer, revocable access —
the company keeps the keys.*

</div>

---

## What it is

Most AI copilots forget. The ones that don't, store their memory in someone else's
database. **Memento AI** is an organizational CRM copilot where memory is a **verifiable,
company-owned asset**:

- **Every customer memory lives on [Walrus](https://www.walrus.xyz/)** — content-addressed
  blobs, not a private SQL row. Anyone with the blob ID can verify the data; only key-holders
  can read what's encrypted.
- **Ownership is on-chain.** Each customer's memory is anchored to a Sui `CustomerMemoryCap`
  the organization owns. Handing off an account = transferring an object between addresses.
- **Access ≠ ownership.** Employees read/write a customer's memory through their **own keys**
  via revocable [MemWal](https://github.com/mysten-incubation/memwal) delegate grants. The
  org never shares its master key, and can revoke any employee from any customer instantly.

The result is memory an organization can **trust, audit, and outlive any single employee** —
the missing substrate for AI agents that act on a company's behalf.

---

## Key features

| | |
|---|---|
| 🎙️ **Live mic advisor** | Real-time call transcription (Whisper) + streamed next-utterance coaching, grounded in the customer's full verifiable history. |
| 🗂️ **Walrus-first memory** | Recall and timeline are read from Walrus, not local DB. The SQLite layer is a disposable cache. |
| 🔗 **On-chain ownership** | `CustomerMemoryCap` (per customer) + `Org`/`MemberCap` (org directory) Move packages on Sui. |
| 🔑 **Per-customer revocable access** | Org grants/revokes each employee's read+write on a single customer via MemWal delegate keys — derived, never stored. |
| 🤝 **zkLogin sign-in** | Google sign-in via [Enoki](https://docs.enoki.mystenlabs.com/) — gasless sponsored transactions, no wallet install. |
| 🔎 **Tribe search & research** | Google-like natural-language search across a customer base + full-context client briefs. |
| 🤖 **Multi-agent monitor** | A long-running Scanner → Drafter → Actioner pipeline that coordinates through Walrus and surfaces due commitments as human-approved drafts. |
| 🚀 **Forced onboarding** | First-run wizard: create company → team → first customer before the app unlocks. |

---

## Architecture

```
                         Browser (judge / rep)
                                │  zkLogin (Google, gasless via Enoki)
                                ▼
        ┌──────────────────────────────────────────────┐
        │  Frontend — Next.js 14  (Vercel)              │
        │  • Copilot, Tribe search, Brief, Monitor      │
        │  • Server actions call OpenRouter (LLM)       │
        │  • Derives per-customer MemWal keys (HKDF)    │
        └───────────────┬───────────────┬──────────────┘
                        │ REST + WSS     │ MemWal SDK / Sui RPC
                        ▼                ▼
        ┌───────────────────────┐   ┌──────────────────────────────┐
        │ Backend — FastAPI     │   │  Sui testnet                 │
        │ (Railway)             │   │  • CustomerMemoryCap (own)   │
        │ • Live mic advisor    │   │  • Org + MemberCap (RBAC)    │
        │   Whisper → suggest   │   │  • MemWalAccount + delegates │
        │   (OpenRouter stream) │   └──────────────────────────────┘
        └───────────┬───────────┘                  │
                    │ put / get blobs              │ anchors blob IDs
                    ▼                               ▼
            ┌───────────────────────────────────────────────┐
            │  Walrus testnet — content-addressed memory     │
            │  manifest blob → namespaces → conversation     │
            └───────────────────────────────────────────────┘
```

**Ownership vs. access, on separate rails:**
- *Ownership* = Sui caps (transferable authority over a customer's memory).
- *Access* = MemWal delegate keys (per-customer read/write an employee holds with their own key).
- The org can revoke access without moving ownership, and transfer ownership without leaking its master key.

Deeper writeup: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Tech stack

- **Chain:** Sui (Move) — `customer_memory` + `org` packages · **Storage:** Walrus (testnet)
- **Memory access:** MemWal (on-chain account + delegate keys) · **Auth:** Enoki zkLogin (gasless)
- **Frontend:** Next.js 14, React 18, TypeScript · **Backend:** FastAPI, faster-whisper (CPU)
- **LLM:** OpenRouter (provider-agnostic — Claude / Gemini)

---

## Walrus track alignment

Memento AI is a **verifiable data platform for AI agents**:
- Agent memory is **content-addressed and verifiable** on Walrus, not siloed in a private DB.
- **Ownership and access are programmable on Sui** — the org owns the data; agents and
  employees act under scoped, revocable, on-chain authority.
- A **long-running multi-agent pipeline** reads and writes its working state through Walrus,
  demonstrating durable, shared, verifiable agent coordination.

---

## Quickstart (local)

```bash
# Backend (FastAPI + Whisper)
cd backend && pip install -r requirements.txt && ./run.sh        # :8000

# Frontend (Next.js)
cd frontend && npm install && npm run dev                        # :3000
```

Copy `frontend/.env.local.example` → `.env.local` and `backend/.env.example` → `.env`,
then fill in your Sui/Walrus/Enoki/OpenRouter values. Deploy is **Vercel (frontend) +
Railway (backend)** — the backend ships with a `Dockerfile` and `railway.json`.

---

<div align="center">
<sub>Built for the Walrus hackathon · Sui testnet · memory that outlives the employee.</sub>
</div>
