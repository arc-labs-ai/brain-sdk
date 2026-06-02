//! Wire-protocol layer: the 32-byte BRN0 frame codec (L1), the CBOR
//! payload codec + trailing raw-vector section (L2), the opcode table,
//! and the typed request/response structs the payloads decode to.

pub mod cbor;
pub mod frame;
pub mod opcode;
pub mod types;

pub use frame::{Frame, FrameError};
pub use opcode::Opcode;
