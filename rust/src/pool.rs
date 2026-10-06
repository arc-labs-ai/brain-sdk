//! A fixed-size connection pool over [`BrainClient`].
//!
//! Each [`BrainClient`] is already a *multiplexed* connection — one socket
//! that serves many concurrent requests demultiplexed by `stream_id` — so a
//! pool isn't needed for concurrency. What a pool buys is **socket-level
//! parallelism**: spreading load across N independent TCP connections (and
//! thus N server-side connection slots / shards' accept paths), and isolating
//! a single slow or stalled socket from the rest of the workload.
//!
//! [`Pool::connect`] opens `size` connections up front, each running its own
//! handshake. [`Pool::get`] hands back a shared [`BrainClient`] by round-robin;
//! callers issue verbs on it directly (the client's verbs take `&self`). The
//! returned `Arc` can be cloned and moved into tasks freely.
//!
//! [`Pool::get_healthy`] replaces a member whose connection has died (the
//! server restarted, or the socket failed) before handing it out, so a
//! long-lived pool survives a server restart instead of failing every request
//! on the dead sockets forever. At most one reconnect runs per member at a
//! time; concurrent callers wait for it rather than each opening a socket.
//!
//! Deferred: periodic background health-checking, and graceful per-member BYE
//! on shutdown. Dropping the pool drops every client, which closes its socket
//! (a TCP FIN); it does not send a BYE frame first.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};

use crate::client::{Auth, BrainClient, ClientConfig};
use crate::error::{BrainError, Result};

/// One pooled connection, swappable when it dies.
struct Slot {
    client: RwLock<Arc<BrainClient>>,
    /// Serializes reconnects of this slot so a burst opens one socket.
    reconnecting: tokio::sync::Mutex<()>,
}

impl Slot {
    fn new(client: BrainClient) -> Self {
        Self {
            client: RwLock::new(Arc::new(client)),
            reconnecting: tokio::sync::Mutex::new(()),
        }
    }

    fn current(&self) -> Arc<BrainClient> {
        Arc::clone(&self.client.read().expect("pool slot lock poisoned"))
    }
}

/// A fixed-size set of [`BrainClient`] connections handed out round-robin.
pub struct Pool {
    slots: Vec<Slot>,
    next: AtomicUsize,
    addr: SocketAddr,
    config: ClientConfig,
}

impl std::fmt::Debug for Pool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pool")
            .field("size", &self.slots.len())
            .finish_non_exhaustive()
    }
}

impl Pool {
    /// Open `size` connections to `addr` with the given credential and default
    /// transport settings, and run every handshake. Fails (closing any
    /// already-opened members) if `size` is 0 or any connection's handshake
    /// fails.
    pub async fn connect(addr: SocketAddr, size: usize, auth: Auth) -> Result<Self> {
        Self::connect_with(addr, size, &ClientConfig::new(auth)).await
    }

    /// Open `size` connections to `addr` with an explicit configuration
    /// template, cloned per connection. Each member runs its own handshake.
    /// All members share the template's credential, so the server binds them to
    /// the same agent; they remain individually identifiable by session id.
    pub async fn connect_with(
        addr: SocketAddr,
        size: usize,
        config: &ClientConfig,
    ) -> Result<Self> {
        if size == 0 {
            return Err(BrainError::Protocol(
                "connection pool size must be >= 1".to_string(),
            ));
        }
        let mut slots = Vec::with_capacity(size);
        for _ in 0..size {
            let cfg = config.clone();
            match BrainClient::connect_with(addr, cfg).await {
                Ok(client) => slots.push(Slot::new(client)),
                Err(e) => {
                    // Best-effort close of the members opened so far before
                    // surfacing the failure; dropping each closes its socket.
                    drop(slots);
                    return Err(e);
                }
            }
        }
        Ok(Self {
            slots,
            next: AtomicUsize::new(0),
            addr,
            config: config.clone(),
        })
    }

    /// The number of pooled connections.
    #[must_use]
    pub fn size(&self) -> usize {
        self.slots.len()
    }

    fn next_slot(&self) -> &Slot {
        let idx = self.next.fetch_add(1, Ordering::Relaxed) % self.slots.len();
        &self.slots[idx]
    }

    /// Borrow the next connection, round-robin, as-is — it may be dead if the
    /// server went away. Prefer [`Pool::get_healthy`] for long-lived pools.
    /// The returned `Arc` is cheap to clone and safe to move across tasks; the
    /// underlying client multiplexes concurrent requests itself.
    ///
    /// # Panics
    /// Only if a slot's lock was poisoned by a panic while swapping a client.
    #[must_use]
    pub fn get(&self) -> Arc<BrainClient> {
        self.next_slot().current()
    }

    /// Borrow the next live connection, round-robin, reconnecting it first if
    /// it has died (e.g. the server restarted). Requests already in flight on
    /// the old connection fail as before; new ones get the fresh socket.
    ///
    /// # Errors
    /// The reconnect's [`BrainError`] if the server is still unreachable.
    ///
    /// # Panics
    /// Only if a slot's lock was poisoned by a panic while swapping a client.
    pub async fn get_healthy(&self) -> Result<Arc<BrainClient>> {
        let slot = self.next_slot();
        let client = slot.current();
        if !client.is_closed() {
            return Ok(client);
        }
        let _guard = slot.reconnecting.lock().await;
        // Another caller may have reconnected while we waited.
        let client = slot.current();
        if !client.is_closed() {
            return Ok(client);
        }
        let fresh = Arc::new(BrainClient::connect_with(self.addr, self.config.clone()).await?);
        *slot.client.write().expect("pool slot lock poisoned") = Arc::clone(&fresh);
        Ok(fresh)
    }
}
