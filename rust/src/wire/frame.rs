//! Brain wire-protocol frame codec.
//!
//! Re-implements Brain's 32-byte `BRN0` frame header. The conformance
//! corpus is the drift guard against the server.
//!
//! Layout — all multi-byte integers big-endian:
//! ```text
//! byte  0..4   magic "BRN0"
//! byte  4      version (= 1)
//! byte  5..7   opcode (u16 BE; high byte = namespace 0x00 / 0x01)
//! byte  7      flags (EOS=0x80, MPL=0x40, CMP=0x20)
//! byte  8..12  header_crc32c (u32 BE) — CRC32C over header bytes 0..8 ++ 12..32
//! byte 12..16  stream_id (u32 BE)
//! byte 16..19  payload_len (u24 BE)
//! byte 19      reserved_a (= 0)
//! byte 20..24  payload_crc32c (u32 BE; 0 when payload empty)
//! byte 24..32  reserved_b (8 bytes, = 0)
//! ```
//! Payload (not part of this header) = CBOR map + optional trailing raw
//! little-endian f32 vector section.

/// Magic bytes at offset 0: ASCII `"BRN0"`.
pub const MAGIC: [u8; 4] = *b"BRN0";

/// Wire-protocol version (header byte 4).
pub const WIRE_VERSION: u8 = 1;

/// Total header size, in bytes.
pub const HEADER_SIZE: usize = 32;

// Frame flag bits (header byte 7).
pub const FLAG_EOS: u8 = 0x80;
pub const FLAG_MPL: u8 = 0x40;
pub const FLAG_CMP: u8 = 0x20;

/// Flag bits that are defined; everything else MUST be zero on the wire.
/// A corrupt or hostile peer that sets a reserved bit is rejected rather
/// than silently reinterpreted.
pub const FLAGS_DEFINED_MASK: u8 = FLAG_EOS | FLAG_MPL | FLAG_CMP;

// Opcode namespaces (high byte of the u16 opcode).
pub const OPCODE_NS_SUBSTRATE: u8 = 0x00;
pub const OPCODE_NS_TYPED_GRAPH: u8 = 0x01;

// Field byte offsets within the 32-byte header.
pub const OFF_MAGIC: usize = 0;
pub const OFF_VERSION: usize = 4;
pub const OFF_OPCODE: usize = 5;
pub const OFF_FLAGS: usize = 7;
pub const OFF_HEADER_CRC: usize = 8;
pub const OFF_STREAM_ID: usize = 12;
pub const OFF_PAYLOAD_LEN: usize = 16;
pub const OFF_RESERVED_A: usize = 19;
pub const OFF_PAYLOAD_CRC: usize = 20;
pub const OFF_RESERVED_B: usize = 24;

/// Max payload size: `2^24 - 1` (the u24 `payload_len` field).
pub const MAX_PAYLOAD_BYTES: usize = 0xff_ff_ff;

/// Errors raised while decoding a frame off the wire. Each maps to a
/// wire protocol-error condition; a mismatch is fail-stop for the
/// connection (a corrupt frame desynchronizes the byte stream).
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FrameError {
    /// First four bytes were not `b"BRN0"`.
    #[error("bad frame magic")]
    BadMagic,
    /// Version byte did not match [`WIRE_VERSION`].
    #[error("unsupported wire version: got {got}, expected {expected}")]
    BadVersion { got: u8, expected: u8 },
    /// `header_crc32c` did not match the recomputed CRC.
    #[error("header CRC mismatch")]
    BadHeaderCrc,
    /// `payload_crc32c` did not match the CRC of the payload bytes.
    #[error("payload CRC mismatch")]
    BadPayloadCrc,
    /// `payload_len` exceeded the negotiated maximum — rejected before
    /// any payload buffer is reserved, so a hostile length can't force a
    /// large allocation.
    #[error("payload length {len} exceeds maximum {max}")]
    OversizePayload { len: u32, max: u32 },
    /// A reserved header byte or reserved flag bit was non-zero.
    #[error("reserved field or flag bit was non-zero")]
    ReservedNonZero,
    /// Not enough bytes buffered yet to decode the frame; caller should
    /// read more from the socket and retry.
    #[error("truncated frame: have {have} bytes, need {need}")]
    Truncated { have: usize, need: usize },
}

/// A decoded frame: header fields + the raw payload bytes (CBOR section
/// plus any trailing raw-vector section, undivided at this layer).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub opcode: u16,
    pub flags: u8,
    pub stream_id: u32,
    pub payload: Vec<u8>,
}

/// CRC32C over the header bytes that exclude the `header_crc32c` field
/// itself: bytes `0..8` concatenated with `12..32`. The 4-byte CRC slot
/// is held at zero so encode and decode agree on the covered bytes.
fn compute_header_crc(header: &[u8; HEADER_SIZE]) -> u32 {
    let mut buf = [0u8; HEADER_SIZE - 4];
    buf[..OFF_HEADER_CRC].copy_from_slice(&header[..OFF_HEADER_CRC]);
    buf[OFF_HEADER_CRC..].copy_from_slice(&header[OFF_STREAM_ID..]);
    crc32c::crc32c(&buf)
}

impl Frame {
    /// Build a frame from its parts.
    #[must_use]
    pub fn new(opcode: u16, flags: u8, stream_id: u32, payload: Vec<u8>) -> Self {
        Self {
            opcode,
            flags,
            stream_id,
            payload,
        }
    }

    /// Serialize the frame to a wire-ready byte vector: the 32-byte
    /// header with both CRC32C fields computed, followed by the payload.
    ///
    /// # Panics
    ///
    /// Panics if `payload.len()` exceeds [`MAX_PAYLOAD_BYTES`]; the u24
    /// length field physically cannot represent more.
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        assert!(
            self.payload.len() <= MAX_PAYLOAD_BYTES,
            "payload length {} exceeds 24-bit max",
            self.payload.len()
        );

        let mut out = vec![0u8; HEADER_SIZE + self.payload.len()];
        {
            let header = &mut out[..HEADER_SIZE];
            header[OFF_MAGIC..OFF_MAGIC + 4].copy_from_slice(&MAGIC);
            header[OFF_VERSION] = WIRE_VERSION;
            header[OFF_OPCODE..OFF_OPCODE + 2].copy_from_slice(&self.opcode.to_be_bytes());
            header[OFF_FLAGS] = self.flags;
            // header_crc32c (8..12) left zero until computed below.
            header[OFF_STREAM_ID..OFF_STREAM_ID + 4].copy_from_slice(&self.stream_id.to_be_bytes());
            #[allow(clippy::cast_possible_truncation)]
            let len_be = (self.payload.len() as u32).to_be_bytes();
            header[OFF_PAYLOAD_LEN..OFF_PAYLOAD_LEN + 3].copy_from_slice(&len_be[1..]);
            // reserved_a (19) and reserved_b (24..32) left zero.
            // An empty payload carries a zero payload CRC by convention,
            // which crc32c of an empty slice already produces.
            let payload_crc = crc32c::crc32c(&self.payload);
            header[OFF_PAYLOAD_CRC..OFF_PAYLOAD_CRC + 4]
                .copy_from_slice(&payload_crc.to_be_bytes());
        }

        let header_arr: [u8; HEADER_SIZE] = out[..HEADER_SIZE]
            .try_into()
            .expect("invariant: out starts with exactly HEADER_SIZE header bytes");
        let header_crc = compute_header_crc(&header_arr);
        out[OFF_HEADER_CRC..OFF_HEADER_CRC + 4].copy_from_slice(&header_crc.to_be_bytes());

        out[HEADER_SIZE..].copy_from_slice(&self.payload);
        out
    }

    /// Decode a single frame off the front of `bytes`, returning the
    /// frame and the unconsumed tail so a caller can loop over a stream.
    ///
    /// Validates magic / version / reserved bytes / reserved flag bits,
    /// verifies the header CRC, then checks `payload_len` against
    /// [`MAX_PAYLOAD_BYTES`] **before** slicing the payload, and finally
    /// verifies the payload CRC.
    pub fn decode(bytes: &[u8]) -> Result<(Frame, &[u8]), FrameError> {
        if bytes.len() < HEADER_SIZE {
            return Err(FrameError::Truncated {
                have: bytes.len(),
                need: HEADER_SIZE,
            });
        }

        let header: [u8; HEADER_SIZE] = bytes[..HEADER_SIZE]
            .try_into()
            .expect("invariant: slice is exactly HEADER_SIZE bytes after the length check");

        if header[OFF_MAGIC..OFF_MAGIC + 4] != MAGIC {
            return Err(FrameError::BadMagic);
        }
        if header[OFF_VERSION] != WIRE_VERSION {
            return Err(FrameError::BadVersion {
                got: header[OFF_VERSION],
                expected: WIRE_VERSION,
            });
        }
        if header[OFF_RESERVED_A] != 0 || header[OFF_RESERVED_B..HEADER_SIZE] != [0u8; 8] {
            return Err(FrameError::ReservedNonZero);
        }
        let flags = header[OFF_FLAGS];
        if flags & !FLAGS_DEFINED_MASK != 0 {
            return Err(FrameError::ReservedNonZero);
        }

        let stored_header_crc = u32::from_be_bytes([
            header[OFF_HEADER_CRC],
            header[OFF_HEADER_CRC + 1],
            header[OFF_HEADER_CRC + 2],
            header[OFF_HEADER_CRC + 3],
        ]);
        if stored_header_crc != compute_header_crc(&header) {
            return Err(FrameError::BadHeaderCrc);
        }

        let payload_len = u32::from_be_bytes([
            0,
            header[OFF_PAYLOAD_LEN],
            header[OFF_PAYLOAD_LEN + 1],
            header[OFF_PAYLOAD_LEN + 2],
        ]);
        // Reject an over-long claim before reserving any payload buffer —
        // a corrupt or hostile length must not drive a large allocation.
        #[allow(clippy::cast_possible_truncation)]
        if payload_len as usize > MAX_PAYLOAD_BYTES {
            return Err(FrameError::OversizePayload {
                len: payload_len,
                max: MAX_PAYLOAD_BYTES as u32,
            });
        }

        let need = HEADER_SIZE + payload_len as usize;
        if bytes.len() < need {
            return Err(FrameError::Truncated {
                have: bytes.len(),
                need,
            });
        }
        let payload_slice = &bytes[HEADER_SIZE..need];

        let stored_payload_crc = u32::from_be_bytes([
            header[OFF_PAYLOAD_CRC],
            header[OFF_PAYLOAD_CRC + 1],
            header[OFF_PAYLOAD_CRC + 2],
            header[OFF_PAYLOAD_CRC + 3],
        ]);
        if stored_payload_crc != crc32c::crc32c(payload_slice) {
            return Err(FrameError::BadPayloadCrc);
        }

        let frame = Frame {
            opcode: u16::from_be_bytes([header[OFF_OPCODE], header[OFF_OPCODE + 1]]),
            flags,
            stream_id: u32::from_be_bytes([
                header[OFF_STREAM_ID],
                header[OFF_STREAM_ID + 1],
                header[OFF_STREAM_ID + 2],
                header[OFF_STREAM_ID + 3],
            ]),
            payload: payload_slice.to_vec(),
        };
        Ok((frame, &bytes[need..]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Frame {
        Frame::new(0x0021, FLAG_EOS, 7, b"hello brain".to_vec())
    }

    #[test]
    fn encode_decode_round_trip() {
        let original = sample();
        let bytes = original.encode();
        assert_eq!(bytes.len(), HEADER_SIZE + original.payload.len());
        let (decoded, rest) = Frame::decode(&bytes).expect("decode");
        assert!(rest.is_empty());
        assert_eq!(decoded, original);
    }

    #[test]
    fn empty_payload_has_zero_payload_crc() {
        let frame = Frame::new(0x0010, 0, 0, Vec::new());
        let bytes = frame.encode();
        assert_eq!(bytes.len(), HEADER_SIZE);
        assert_eq!(&bytes[OFF_PAYLOAD_CRC..OFF_PAYLOAD_CRC + 4], &[0u8; 4]);
        let (decoded, rest) = Frame::decode(&bytes).expect("decode empty");
        assert!(rest.is_empty());
        assert!(decoded.payload.is_empty());
    }

    #[test]
    fn decode_returns_unconsumed_tail() {
        let mut bytes = sample().encode();
        bytes.extend_from_slice(b"TAIL");
        let (_frame, rest) = Frame::decode(&bytes).expect("decode");
        assert_eq!(rest, b"TAIL");
    }

    #[test]
    fn rejects_bad_magic() {
        let mut bytes = sample().encode();
        bytes[0] = b'X';
        assert_eq!(Frame::decode(&bytes), Err(FrameError::BadMagic));
    }

    #[test]
    fn rejects_bad_version() {
        let mut bytes = sample().encode();
        bytes[OFF_VERSION] = 99;
        assert_eq!(
            Frame::decode(&bytes),
            Err(FrameError::BadVersion {
                got: 99,
                expected: 1
            })
        );
    }

    #[test]
    fn rejects_bad_header_crc() {
        let mut bytes = sample().encode();
        bytes[OFF_HEADER_CRC] ^= 0xFF;
        assert_eq!(Frame::decode(&bytes), Err(FrameError::BadHeaderCrc));
    }

    #[test]
    fn rejects_bad_payload_crc() {
        let mut bytes = sample().encode();
        bytes[HEADER_SIZE] ^= 0xFF;
        assert_eq!(Frame::decode(&bytes), Err(FrameError::BadPayloadCrc));
    }

    #[test]
    fn rejects_reserved_a_nonzero() {
        let mut bytes = sample().encode();
        bytes[OFF_RESERVED_A] = 1;
        // Re-seal the header CRC so the reserved check (not the CRC
        // check) is the one that fires.
        let mut header: [u8; HEADER_SIZE] = bytes[..HEADER_SIZE].try_into().unwrap();
        let crc = compute_header_crc(&{
            let mut h = header;
            h[OFF_HEADER_CRC..OFF_HEADER_CRC + 4].copy_from_slice(&[0; 4]);
            h
        });
        header[OFF_HEADER_CRC..OFF_HEADER_CRC + 4].copy_from_slice(&crc.to_be_bytes());
        bytes[..HEADER_SIZE].copy_from_slice(&header);
        assert_eq!(Frame::decode(&bytes), Err(FrameError::ReservedNonZero));
    }

    #[test]
    fn rejects_reserved_flag_bit() {
        // 0x01 is a reserved flag bit. Build the frame raw so the header
        // CRC covers the bad flag, isolating the reserved-flag check.
        let frame = Frame::new(0x0010, 0x01, 0, Vec::new());
        let bytes = frame.encode();
        assert_eq!(Frame::decode(&bytes), Err(FrameError::ReservedNonZero));
    }

    #[test]
    fn rejects_truncated_header() {
        let bytes = sample().encode();
        let truncated = &bytes[..10];
        assert_eq!(
            Frame::decode(truncated),
            Err(FrameError::Truncated {
                have: 10,
                need: HEADER_SIZE
            })
        );
    }

    #[test]
    fn rejects_truncated_payload() {
        let bytes = sample().encode();
        let truncated = &bytes[..bytes.len() - 3];
        assert!(matches!(
            Frame::decode(truncated),
            Err(FrameError::Truncated { .. })
        ));
    }

    /// Standard CRC32C check vector pins the polynomial choice.
    #[test]
    fn crc32c_check_vector() {
        assert_eq!(crc32c::crc32c(b"123456789"), 0xE306_9283);
    }
}
