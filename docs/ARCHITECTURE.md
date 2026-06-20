# Architecture

Memento AI separates three concerns that most CRMs collapse into one database row:
**ownership**, **access**, and **storage**. Each maps to a different primitive.

| Concern | Primitive | Who controls it |
|---|---|---|
| Ownership | Sui object (`CustomerMemoryCap`) | the organization (transferable) |
| Access | MemWal delegate key (per customer) | each employee, granted/revoked by the org |
| Storage | Walrus content-addressed blob | anyone can verify; key-holders can read |

---

## 1. Storage — Walrus

Customer memory is not a SQL row; it's a tree of content-addressed blobs:

```
manifest blob  (index of namespaces + conversations for one customer)
   ├── namespace: profile        → conversation blobs
   ├── namespace: calls          → conversation blobs
   └── namespace: commitments    → conversation blobs
```

The blob IDs are anchored on-chain (see §2), so the on-chain object is a verifiable
pointer to the exact memory state. SQLite in the backend is a **rebuildable cache** —
recall and timelines read from Walrus, so nothing important lives only on a laptop.

Walrus is lease-based: blobs persist for `WALRUS_EPOCHS` and must be renewed for longer
retention. That lease length is the real durability knob.

---

## 2. Ownership — Sui Move packages

- **`customer_memory`** — `CustomerMemoryCap`: one capability per customer. It anchors
  the customer's manifest blob ID. Owning the cap = owning that customer's memory.
  Transferring the cap to another address is a full ownership handoff.
- **`org`** — `Org { owner, members[] }` + `MemberCap`. The on-chain organization
  directory: the owner adds/revokes members, each member holds a `MemberCap` describing
  their role (owner / admin / manager / rep). This is the source of truth for RBAC.

---

## 3. Access — MemWal delegate keys

[MemWal](https://github.com/mysten-incubation/memwal) gives each customer an on-chain
`MemWalAccount` with an owner key and a list of **delegate keys**. Access is granted and
revoked on-chain by the owner — independently of who owns the Sui cap.

- **Per-customer owner keys are derived, never stored:**
  `HKDF(orgMaster, "memwal-org-v1", "owner:" + customerId)` → a per-customer keypair.
  The org master key never reaches the browser.
- **Employees use their own keys.** To give an employee access to one customer, the org
  adds that employee's public key as a delegate on that customer's MemWal account.
  Revoking is removing the delegate — instant, on-chain, scoped to a single customer.
- **Ownership stays put.** Granting/revoking access never moves the Sui cap, so an org can
  let a rep work a customer and pull that access back without ever surrendering ownership.

This is the core pitch: **organizational memory** — owned by the company, operated by
employees under scoped, revocable, verifiable authority.

---

## 4. Identity — Enoki zkLogin

Users sign in with Google; [Enoki](https://docs.enoki.mystenlabs.com/) turns that into a
Sui identity and sponsors transactions (gasless). No seed phrase, no wallet extension —
which matters for a CRM whose users are sales reps, not crypto natives.

---

## 5. Runtime split

- **Frontend (Next.js 14 → Vercel).** Hosts the UI and all user-facing AI (copilot,
  tribe search, briefs, the multi-agent monitor) as server actions/routes that call
  OpenRouter. Derives per-customer MemWal keys and talks to Sui/Walrus directly.
- **Backend (FastAPI → Railway).** Long-running + WebSocket: the live mic advisor streams
  audio in, runs Whisper transcription + VAD turn detection, and streams next-utterance
  suggestions back (from OpenRouter, with a local-Ollama fallback). Vercel's serverless
  model can't hold a persistent WebSocket, which is why this tier is separate.

---

## 6. Multi-agent monitor

A long-running pipeline that coordinates entirely through Walrus blobs:

```
Scanner  → finds due commitments across customer memory   → writes findings blob
Drafter  → turns findings into outreach drafts            → writes drafts blob
Actioner → prepares sends, gated on human approval        → writes action + state blob
```

State is a resumable Walrus blob, so the pipeline is durable and its working memory is
itself verifiable — a concrete demonstration of agents coordinating over shared,
content-addressed state rather than a private queue.
