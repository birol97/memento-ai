/// On-chain ownership + verifiability for a customer's Walrus-backed memory.
///
/// A `CustomerMemoryCap` is a transferable capability object: whoever holds it
/// "owns" that customer's memory. It also carries the pointer to the latest
/// Walrus memory blob (moving the off-chain SQLite pointer on-chain), and each
/// call anchors a new blob by emitting a verifiable `CallAnchored` event.
///
/// The killer demo: a manager calls `transfer_cap` to hand a customer from
/// Rep A to Rep B — ownership of the entire relationship moves in one tx, with
/// zero data migration (the memory itself stays on Walrus).
///
/// NOTE: authored for `sui move build` — compile/publish with the Sui CLI (not
/// yet run in this environment; see README).
module salescall::customer_memory {
    use sui::event;

    /// Transferable capability granting ownership of one customer's memory.
    /// IDs are raw UTF-8 bytes (copyable) so events can carry them freely.
    public struct CustomerMemoryCap has key, store {
        id: UID,
        customer_id: vector<u8>,
        /// Walrus blob ID of the latest memory document for this customer.
        memory_blob_id: vector<u8>,
    }

    /// Emitted whenever a call's memory is anchored on-chain — the
    /// verifiability backbone. The sequence of these events is an auditable
    /// history of every memory snapshot for a customer.
    public struct CallAnchored has copy, drop {
        customer_id: vector<u8>,
        memory_blob_id: vector<u8>,
        by: address,
    }

    /// Emitted when a customer is handed off to a different rep.
    public struct CapTransferred has copy, drop {
        customer_id: vector<u8>,
        to: address,
    }

    /// Mint a cap for a customer, anchor its first memory blob, and give the
    /// cap to the caller.
    public fun mint(
        customer_id: vector<u8>,
        memory_blob_id: vector<u8>,
        ctx: &mut TxContext,
    ) {
        let cap = CustomerMemoryCap {
            id: object::new(ctx),
            customer_id,
            memory_blob_id,
        };
        event::emit(CallAnchored {
            customer_id: cap.customer_id,
            memory_blob_id: cap.memory_blob_id,
            by: ctx.sender(),
        });
        transfer::public_transfer(cap, ctx.sender());
    }

    /// Anchor a new memory blob after a call: move the pointer + emit the event.
    public fun anchor(
        cap: &mut CustomerMemoryCap,
        memory_blob_id: vector<u8>,
        ctx: &TxContext,
    ) {
        cap.memory_blob_id = memory_blob_id;
        event::emit(CallAnchored {
            customer_id: cap.customer_id,
            memory_blob_id: cap.memory_blob_id,
            by: ctx.sender(),
        });
    }

    /// Hand the customer off to another rep (the killer demo moment).
    public fun transfer_cap(cap: CustomerMemoryCap, to: address) {
        event::emit(CapTransferred { customer_id: cap.customer_id, to });
        transfer::public_transfer(cap, to);
    }

    /// Read the current Walrus pointer (for off-chain clients).
    public fun memory_blob_id(cap: &CustomerMemoryCap): vector<u8> {
        cap.memory_blob_id
    }

    public fun customer_id(cap: &CustomerMemoryCap): vector<u8> {
        cap.customer_id
    }
}
