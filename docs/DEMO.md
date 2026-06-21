# Demo & Judge Walkthrough

**Live app:** https://memento-ai-red.vercel.app
**Network:** Sui + Walrus **testnet** (no real funds, gasless sign-in).

> **Access:** sign in with Google. If you see a "not verified / test user" screen, the
> OAuth consent is in *Testing* mode for the hackathon — reply with your Google email and
> you'll be added as a tester. No wallet or seed phrase needed (zkLogin via Enoki).

---

## The story in one line

> *An organization's AI memory should be **owned by the company**, **verifiable**, and
> **operated by employees under revocable access** — not trapped in a vendor's database.*
> Memento AI is that, built on Sui (ownership) + Walrus (verifiable storage).

---

## 2-minute path (TL;DR)

1. **Sign in with Google** → gasless zkLogin identity.
2. **Onboarding wizard** → create company **Acme Wealth** → create first client **Maria Lopez**.
3. Open Maria → **add a note**: *"Maria agreed to wire $50,000 by June 30. Prefers email over calls."*
4. **Tribe → Search**: *"What did Maria commit to?"* → answer comes from verifiable memory.
5. **Monitor** → run a tick → the agent finds the **June 30 commitment** and drafts a follow-up.
6. **Org** tab → add an employee, **grant** them access to Maria, then **revoke** it → access dies instantly, ownership never moved.

---

## Full scenario (with exact inputs) — and what each step *proves*

### Act 1 · Sign in & onboard — *memory is born as a company-owned asset*
- Click **Sign in with Google** (zkLogin via Enoki — gasless, no wallet).
- Onboarding wizard:
  - **Company:** `Acme Wealth`
  - **First client:** `Maria Lopez`, phone `+1 555 0100`, email `maria@example.com`
- ✅ **Proves:** before any data is entered, the org and its memory are provisioned as an
  on-chain, company-owned structure — identity and ownership come first.

### Act 2 · Capture a conversation — *Walrus-first, verifiable memory*
- Open **Maria Lopez**.
- Add a **note** (or use the **live mic advisor** and say it aloud):
  > *"Maria agreed to wire $50,000 by June 30. She prefers email over phone calls, and she's comparing us against Fidelity."*
- ✅ **Proves:** the conversation becomes a **content-addressed Walrus blob**, anchored
  on-chain — not a private SQL row. The local DB is only a disposable cache.

### Act 3 · Recall, search & edit — *the memory actually works*
- **Tribe → Search** (natural language), try:
  - *"What did Maria commit to?"*
  - *"Do I have any scheduled payments coming up?"*
  - *"Who is comparing us to a competitor?"*
- **Tribe → Character / client research** on Maria → full-context brief.
- **Natural-language update:** in Maria's workspace, type:
  > *"Maria's number is +1 555 0199"*
  → the phone field updates from plain English.
- ✅ **Proves:** the org's knowledge is queryable in natural language over verifiable
  memory, and editable conversationally — no forms to hunt through.

### Act 4 · Agents that act on memory — *the multi-agent monitor*
- Open **Monitor** → **Run** a tick.
  - **Scanner** finds the *"wire $50,000 by June 30"* commitment.
  - **Drafter** writes a follow-up email/message.
  - **Actioner** queues it **for your approval** (nothing sends without a human).
- ✅ **Proves:** a long-running agent pipeline coordinates **through Walrus** and surfaces
  due commitments — agentic and durable, but human-gated for outbound actions.

### Act 5 · Organizational access control — *the core pitch*
- Open **Org**:
  - **Add a member** (a second Google address — a teammate, or a second account of yours).
  - **Grant** that employee access to **Maria Lopez only**.
  - As that employee, you can now **read & write Maria's memory** — with *their own key*.
  - **Revoke** the grant → the employee is locked out of Maria **instantly**.
- ✅ **Proves:** per-customer, **revocable, cryptographic** employee access. The company
  owns the data; employees operate under scoped authority that can be pulled back at any
  time — and **ownership never moves** when access is granted or revoked.

### Act 6 · Verify it's real — *on-chain + Walrus, not a mock*
- The customer's memory is anchored to a Sui **`CustomerMemoryCap`** object — viewable on
  [Suiscan (testnet)](https://suiscan.xyz/testnet).
- Its memory is a **Walrus blob** anyone can fetch by ID from the public testnet aggregator.
- ✅ **Proves:** ownership is a real on-chain object and memory is real verifiable storage —
  the demo is backed by the chain, not a database pretending to be one.

---

## Feature → one-sentence value (cheat sheet)

| Feature | What it proves in one sentence |
|---|---|
| zkLogin sign-in | Mainstream users get a real Sui identity with no wallet, no gas. |
| Onboarding wizard | Org memory is provisioned as an owned, on-chain asset before use. |
| Notes / live mic advisor | Conversations become verifiable Walrus memory, with real-time coaching. |
| Tribe Search | The org's whole memory is queryable in plain English. |
| Natural-language edits | You update a client by talking, not filling forms. |
| Multi-agent Monitor | Agents coordinate over Walrus to catch commitments — human-approved. |
| Grant / revoke access | Employees get per-customer, revocable, cryptographic access. |
| Sui cap + Walrus blob | Ownership and memory are verifiable on-chain, not in a private DB. |

---

## Presenter notes (≈5 min)

| Time | Beat | Say this |
|---|---|---|
| 0:00 | Hook | "Every AI copilot forgets — and the ones that don't, store your company's memory in someone else's database. We fixed who *owns* the memory." |
| 0:30 | Sign in + onboard | "Google sign-in, no wallet. The moment I create Acme Wealth, its memory exists as a company-owned, on-chain asset." |
| 1:30 | Capture + recall | "I log what Maria promised. Now I can *ask* my memory — and the answer comes from a verifiable Walrus blob, not a hidden table." |
| 2:30 | Monitor | "A long-running agent reads that same memory off Walrus, catches the June 30 commitment, and drafts the follow-up — I just approve." |
| 3:30 | Grant/revoke | "I hand an employee access to *one* client with *their own* key — then revoke it instantly. They never had the company key, and ownership never moved." |
| 4:30 | Verify | "Here's the Sui object that owns it, and the Walrus blob behind it. It's real — owned, verifiable, revocable. That's organizational memory." |

**Tips:** have the second Google account ready for Act 5; pre-create Maria if you want to
skip onboarding live; if the mic advisor is unavailable, use a typed note — the rest is
identical.
