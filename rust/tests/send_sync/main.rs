//! The public async surface must be spawnable on a multi-threaded runtime.
//!
//! `clippy::future_not_send` fires on the crate's two generic request helpers
//! (`streamed` and `unary` in `client.rs`) because their `Req` parameter has no
//! `Sync` bound, so *in general* the future they return need not be `Send`.
//! That says nothing about the futures callers actually get: every public verb
//! instantiates `Req` with a concrete wire type, and those are all `Sync`.
//!
//! The lint is therefore allowed at the crate level — and this file is why that
//! is safe. It asserts the property directly, on the real futures, at compile
//! time. If one ever stops being `Send` (a `std::sync::MutexGuard` held across
//! an `.await`, an `Rc` somewhere in a request path), this file stops
//! compiling. That is a tighter guarantee than the lint gives: the lint checks
//! the generic helpers, this checks the API a caller actually reaches.
//!
//! Nothing here connects to anything. Building a future without awaiting it is
//! enough for the compiler to check its auto-traits — an `async` body does not
//! run until polled.

// The `_`-prefixed functions below are never called: compiling them IS the
// assertion. Rust still fully type- and borrow-checks dead code, so an
// auto-trait regression is a compile error here even though nothing runs.
#![allow(dead_code)]

use std::future::Future;
use std::net::SocketAddr;

use brain_db_sdk::verbs::{EncodeBuilder, ForgetBuilder, RecallBuilder};
use brain_db_sdk::{Auth, BrainClient, BrainError, BrainHttpClient, ClientConfig};

/// Compile-time only: accepts a value solely to constrain it to `Send`.
const fn assert_send<T: Send>(_: &T) {}

/// Compile-time only: `Send + Sync` for anything shared across tasks.
const fn assert_send_sync<T: Send + Sync>() {}

#[test]
fn the_clients_and_their_config_are_send_and_sync() {
    // A client behind an `Arc`, used from several tasks, is the normal
    // deployment shape; that needs both bounds on the client itself.
    assert_send_sync::<BrainClient>();
    assert_send_sync::<BrainHttpClient>();
    assert_send_sync::<ClientConfig>();
    assert_send_sync::<Auth>();
    // An error crossing a task boundary is the whole point of returning it.
    assert_send_sync::<BrainError>();
}

/// Every public wire verb's future must be `Send`, or `tokio::spawn` rejects it.
///
/// This is the check `clippy::future_not_send` cannot make: it is written
/// against the concrete futures rather than the generic helpers behind them.
/// Never called — compiling it is the assertion.
fn _wire_verb_futures_are_send(client: &BrainClient) {
    assert_send(&client.encode(&EncodeBuilder::new("").build()));
    assert_send(&client.recall(&RecallBuilder::new("").build()));
    assert_send(&client.forget(&ForgetBuilder::new(0).build()));
}

/// `close` consumes the client, so it needs an owned one rather than a borrow.
fn _the_close_future_is_send(client: BrainClient) {
    assert_send(&client.close());
}

/// The HTTP tier is a separate transport and gets the same guarantee.
fn _http_verb_futures_are_send(client: &BrainHttpClient) {
    assert_send(&client.whoami());
    assert_send(&client.capabilities());
}

/// Connecting is itself an async call a caller may spawn.
fn _connect_futures_are_send() {
    let addr = SocketAddr::from(([127, 0, 0, 1], 1));
    assert_send(&BrainClient::connect(addr, Auth::Token(Vec::new())));
    assert_send(&BrainClient::connect_with(
        addr,
        ClientConfig::new(Auth::Token(Vec::new())),
    ));
}

/// A `Send` future is still useless to `tokio::spawn` if it borrows a stack
/// local, so this pins the shape a spawn actually needs: `Send + 'static`, with
/// an owned client moved into the task.
#[test]
fn a_spawned_task_can_own_a_client() {
    const fn spawnable<F: Future<Output = ()> + Send + 'static>(_: &F) {}

    let task = async {
        let addr = SocketAddr::from(([127, 0, 0, 1], 1));
        // Nothing listens there; the point is that the whole body type-checks
        // as `Send + 'static`. The future is never polled.
        if let Ok(client) = BrainClient::connect(addr, Auth::Token(Vec::new())).await {
            let _ = client.close().await;
        }
    };
    spawnable(&task);
}
