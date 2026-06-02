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
//! Deferred (documented as later work): transparent reconnect of a dropped
//! member, health-checking, and graceful per-member BYE on shutdown. Dropping
//! the pool drops every client, which closes its socket (a TCP FIN); it does
//! not send a BYE frame first.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use crate::client::{BrainClient, ClientConfig};
use crate::error::{BrainError, Result};

/// A fixed-size set of [`BrainClient`] connections handed out round-robin.
pub struct Pool {
    clients: Vec<Arc<BrainClient>>,
    next: AtomicUsize,
}

impl Pool {
    /// Open `size` connections to `addr`, each with the default configuration,
    /// and run every handshake. Fails (closing any already-opened members) if
    /// `size` is 0 or any connection's handshake fails.
    pub async fn connect(addr: SocketAddr, size: usize) -> Result<Self> {
        Self::connect_with(addr, size, &ClientConfig::default()).await
    }

    /// Open `size` connections to `addr` with an explicit configuration
    /// template, cloned per connection. Each member runs its own handshake; a
    /// fresh agent id is minted per member (so they are distinguishable
    /// server-side) unless the template pins one.
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
        let mut clients = Vec::with_capacity(size);
        for _ in 0..size {
            let mut cfg = config.clone();
            // Distinct agent per socket unless the caller pinned one — keeps
            // pooled connections individually identifiable in server logs.
            cfg.agent_id = crate::client::new_id();
            match BrainClient::connect_with(addr, cfg).await {
                Ok(client) => clients.push(Arc::new(client)),
                Err(e) => {
                    // Best-effort close of the members opened so far before
                    // surfacing the failure; dropping each closes its socket.
                    drop(clients);
                    return Err(e);
                }
            }
        }
        Ok(Self {
            clients,
            next: AtomicUsize::new(0),
        })
    }

    /// The number of pooled connections.
    #[must_use]
    pub fn size(&self) -> usize {
        self.clients.len()
    }

    /// Borrow the next connection, round-robin. The returned `Arc` is cheap to
    /// clone and safe to move across tasks; the underlying client multiplexes
    /// concurrent requests itself.
    #[must_use]
    pub fn get(&self) -> Arc<BrainClient> {
        let idx = self.next.fetch_add(1, Ordering::Relaxed) % self.clients.len();
        Arc::clone(&self.clients[idx])
    }
}
