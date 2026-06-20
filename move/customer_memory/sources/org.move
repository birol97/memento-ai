/// On-chain organization directory — so the company OWNS its team, not a local DB.
///
/// An `Org` object is owned by the company address; its member table is the
/// authoritative directory ("who works here + role"). Because the Org is an
/// owned object, only the company can mutate it (Sui enforces this) — no admin
/// cap needed. Each employee is also issued a `MemberCap` so they can discover
/// their org and prove membership client-side; the Org table stays the source of
/// truth, so a revoked employee's stale MemberCap means nothing (the app
/// re-checks the table).
///
/// Roles: 0=owner, 1=admin, 2=manager, 3=rep.
module salescall::org {
    use std::string::String;
    use sui::event;

    const ENotMember: u64 = 0;

    /// One employee row in the directory.
    public struct Member has store, copy, drop {
        addr: address,
        role: u8,
        label: String,
    }

    /// The company. Owned by the company address → the company owns the directory.
    public struct Org has key, store {
        id: UID,
        name: String,
        owner: address,
        members: vector<Member>,
    }

    /// Issued to each employee: a discovery pointer + membership proof.
    /// The Org table is authoritative; this can go stale after revocation.
    public struct MemberCap has key, store {
        id: UID,
        org: ID,
        member: address,
        role: u8,
        label: String,
    }

    public struct OrgCreated has copy, drop { org: ID, name: String, owner: address }
    public struct MemberAdded has copy, drop { org: ID, member: address, role: u8 }
    public struct MemberRevoked has copy, drop { org: ID, member: address }

    /// Create a company. The creator owns the Org (and thus the directory).
    public fun create_org(name: String, ctx: &mut TxContext) {
        let org = Org {
            id: object::new(ctx),
            name,
            owner: ctx.sender(),
            members: vector::empty<Member>(),
        };
        event::emit(OrgCreated { org: object::id(&org), name: org.name, owner: ctx.sender() });
        transfer::public_transfer(org, ctx.sender());
    }

    /// Add (or update) an employee. Owner-only: needs `&mut Org`, which on Sui
    /// only the Org's owner can supply. Issues a MemberCap to the employee.
    public fun add_member(
        org: &mut Org,
        member: address,
        role: u8,
        label: String,
        ctx: &mut TxContext,
    ) {
        // de-dup: if the address already exists, drop the old row first
        remove_addr(org, member);
        vector::push_back(&mut org.members, Member { addr: member, role, label });
        let cap = MemberCap {
            id: object::new(ctx),
            org: object::id(org),
            member,
            role,
            label,
        };
        event::emit(MemberAdded { org: object::id(org), member, role });
        transfer::public_transfer(cap, member);
    }

    /// Revoke an employee — remove them from the authoritative table. Owner-only.
    /// Their wallet may still hold a stale MemberCap; it carries no authority.
    public fun revoke_member(org: &mut Org, member: address) {
        remove_addr(org, member);
        event::emit(MemberRevoked { org: object::id(org), member });
    }

    /// Read helpers (devInspect-friendly).
    public fun member_count(org: &Org): u64 { vector::length(&org.members) }
    public fun is_member(org: &Org, who: address): bool {
        let mut i = 0; let n = vector::length(&org.members);
        while (i < n) { if (vector::borrow(&org.members, i).addr == who) return true; i = i + 1; };
        false
    }
    public fun role_of(org: &Org, who: address): u8 {
        let mut i = 0; let n = vector::length(&org.members);
        while (i < n) {
            let m = vector::borrow(&org.members, i);
            if (m.addr == who) return m.role;
            i = i + 1;
        };
        abort ENotMember
    }

    /// internal: remove a row by address if present
    fun remove_addr(org: &mut Org, who: address) {
        let mut i = 0; let n = vector::length(&org.members);
        while (i < n) {
            if (vector::borrow(&org.members, i).addr == who) {
                vector::remove(&mut org.members, i);
                return
            };
            i = i + 1;
        }
    }
}
