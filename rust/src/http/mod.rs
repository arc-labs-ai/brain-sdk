//! The HTTP tier of the Brain SDK — [`BrainHttpClient`] + its contract types.
//!
//! Talks JSON to the Brain HTTP edge (`brain-edge` self-hosted, or the Arc cloud
//! gateway). The native wire client is [`crate::BrainClient`]. The method names,
//! request fields, response fields, and error shape match the Python and
//! TypeScript SDKs exactly.

pub mod client;
pub mod error;
pub mod retry;
pub mod types;

pub use client::{BrainHttpClient, DEFAULT_BASE_URL, DEFAULT_TIMEOUT};
pub use error::BrainHttpError;
pub use retry::HttpRetryPolicy;
pub use types::{
    Capabilities, Endpoint, EncodeInput, EncodeResult, ForgetInput, ForgetResult, InferenceStep,
    LinkInput, LinkResult, MemoryHit, Permissions, PlanInput, PlanResult, PlanStep, ReasonInput,
    ReasonResult, RecallInput, RecallResult, UnlinkInput, UnlinkResult, Whoami,
};
