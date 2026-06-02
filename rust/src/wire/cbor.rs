//! CBOR payload codec + trailing raw-vector section.
//!
//! A wire payload is a self-describing CBOR map carrying the structured
//! fields, optionally followed by a raw little-endian `f32` block for
//! embedding vectors. Vectors stay out of the CBOR so the floats keep
//! full precision (CBOR would tag each one and risk half-precision
//! rounding) and stay contiguous for a bulk copy.
//!
//! Encoding is reproducible: a given value always produces the same
//! bytes (fixed struct field order, shortest-form integers from
//! `ciborium`). That stability is what lets the conformance corpus pin
//! the format.

use serde::de::DeserializeOwned;
use serde::Serialize;

/// Failures decoding a CBOR payload.
#[derive(Debug, thiserror::Error)]
pub enum CborError {
    /// The CBOR item failed to decode (truncated, type mismatch, …).
    #[error("CBOR decode failed: {0}")]
    Decode(String),
    /// A complete CBOR item decoded but extra bytes followed it where
    /// none were expected (non-vector payloads have no trailing section).
    #[error("trailing bytes after CBOR payload")]
    TrailingBytes,
    /// A trailing raw-vector section was not a whole number of 4-byte
    /// floats.
    #[error("vector section is {0} bytes, not a multiple of 4")]
    RaggedVector(usize),
}

/// Serialize a value to a fresh CBOR byte vector. The only failure mode
/// for an owned in-memory value is allocation, so the unreachable error
/// path carries a descriptive panic message.
pub fn to_cbor_bytes<T: Serialize>(value: &T) -> Vec<u8> {
    let mut buf = Vec::new();
    ciborium::into_writer(value, &mut buf)
        .expect("invariant: CBOR encode of an owned value is infallible");
    buf
}

/// Decode a CBOR `T`, requiring the whole buffer to be consumed.
/// Trailing bytes after a complete item mean a malformed frame.
pub fn from_cbor_bytes<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, CborError> {
    let mut cursor = std::io::Cursor::new(bytes);
    let value: T =
        ciborium::from_reader(&mut cursor).map_err(|e| CborError::Decode(e.to_string()))?;
    if (cursor.position() as usize) != bytes.len() {
        return Err(CborError::TrailingBytes);
    }
    Ok(value)
}

/// Decode a CBOR `T` from the front of `bytes` and report how many bytes
/// the CBOR section consumed, so the caller can read a trailing raw
/// section from `bytes[consumed..]`.
pub fn from_cbor_prefix<T: DeserializeOwned>(bytes: &[u8]) -> Result<(T, usize), CborError> {
    let mut cursor = std::io::Cursor::new(bytes);
    let value: T =
        ciborium::from_reader(&mut cursor).map_err(|e| CborError::Decode(e.to_string()))?;
    Ok((value, cursor.position() as usize))
}

/// Pack an `f32` slice into a contiguous little-endian byte vector for
/// the trailing raw-vector section.
#[must_use]
pub fn f32_slice_to_le_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

/// Read a little-endian `f32` vector from the trailing raw section. The
/// byte length must be a whole number of 4-byte floats. Reads in 4-byte
/// chunks rather than casting, so it is alignment-safe over a socket
/// buffer.
pub fn le_bytes_to_f32_vec(bytes: &[u8]) -> Result<Vec<f32>, CborError> {
    if bytes.len() % 4 != 0 {
        return Err(CborError::RaggedVector(bytes.len()));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

/// Serde adapter for `Vec<[u8; 16]>` of UUID-shaped wire ids: each id
/// encodes as its own CBOR byte string (major type 2) inside an array.
///
/// `serde_bytes` flattens a single contiguous buffer, so a vector of
/// distinct 16-byte ids must keep each element framed separately. Use
/// via `#[serde(with = "vec_byte_array16")]`.
pub mod vec_byte_array16 {
    use serde::de::{Deserializer, SeqAccess, Visitor};
    use serde::ser::SerializeSeq;
    use std::fmt;

    pub fn serialize<S>(v: &[[u8; 16]], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        let mut seq = serializer.serialize_seq(Some(v.len()))?;
        for id in v {
            seq.serialize_element(serde_bytes::Bytes::new(id))?;
        }
        seq.end()
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<[u8; 16]>, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Vec<[u8; 16]>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a sequence of 16-byte byte strings")
            }
            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                // The size hint echoes the array length the *peer*
                // declared, so a small frame could claim a huge element
                // count and force an oversized up-front allocation.
                // Reserve a bounded floor and let `push` grow to the real
                // size as elements actually decode.
                const PREALLOC_FLOOR: usize = 64;
                let hint = seq.size_hint().unwrap_or(0).min(PREALLOC_FLOOR);
                let mut out = Vec::with_capacity(hint);
                while let Some(b) = seq.next_element::<serde_bytes::ByteBuf>()? {
                    let arr: [u8; 16] = b.as_ref().try_into().map_err(|_| {
                        serde::de::Error::invalid_length(b.len(), &"exactly 16 bytes")
                    })?;
                    out.push(arr);
                }
                Ok(out)
            }
        }
        deserializer.deserialize_seq(V)
    }
}

/// Serde adapter for `Option<Vec<[u8; 16]>>`, deferring to
/// [`vec_byte_array16`] for the `Some` case. Use via
/// `#[serde(with = "opt_vec_byte_array16")]`.
pub mod opt_vec_byte_array16 {
    use serde::de::Deserializer;

    pub fn serialize<S>(v: &Option<Vec<[u8; 16]>>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        match v {
            None => serializer.serialize_none(),
            Some(inner) => {
                #[derive(serde::Serialize)]
                struct W<'a>(#[serde(with = "super::vec_byte_array16")] &'a [[u8; 16]]);
                serializer.serialize_some(&W(inner))
            }
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Vec<[u8; 16]>>, D::Error>
    where
        D: Deserializer<'de>,
    {
        use serde::Deserialize as _;
        #[derive(serde::Deserialize)]
        struct W(#[serde(with = "super::vec_byte_array16")] Vec<[u8; 16]>);
        let opt: Option<W> = Option::deserialize(deserializer)?;
        Ok(opt.map(|w| w.0))
    }
}

/// Serde adapter for `Option<[u8; 16]>`, encoding the `Some` payload as a
/// CBOR byte string (major type 2) rather than an array of `u8`.
///
/// `serde_bytes` cannot reach through `Option`: applied to an
/// `Option<[u8; 16]>` field it serializes the inner array element-wise,
/// producing a CBOR array. Routing the inner array through
/// `serde_bytes::Bytes` keeps a present id a single 16-byte byte string,
/// so every wire id has one encoding regardless of how it is wrapped. Use
/// via `#[serde(with = "opt_byte_array16")]`.
pub(crate) mod opt_byte_array16 {
    use serde::de::Deserializer;

    pub(crate) fn serialize<S>(v: &Option<[u8; 16]>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        match v {
            None => serializer.serialize_none(),
            Some(id) => serializer.serialize_some(serde_bytes::Bytes::new(id)),
        }
    }

    pub(crate) fn deserialize<'de, D>(deserializer: D) -> Result<Option<[u8; 16]>, D::Error>
    where
        D: Deserializer<'de>,
    {
        use serde::Deserialize as _;
        let opt: Option<serde_bytes::ByteBuf> = Option::deserialize(deserializer)?;
        match opt {
            None => Ok(None),
            Some(b) => {
                let arr: [u8; 16] = b
                    .as_ref()
                    .try_into()
                    .map_err(|_| serde::de::Error::invalid_length(b.len(), &"exactly 16 bytes"))?;
                Ok(Some(arr))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
    struct Sample {
        a: u32,
        b: String,
    }

    #[test]
    fn round_trip_whole_buffer() {
        let s = Sample {
            a: 7,
            b: "hi".into(),
        };
        let bytes = to_cbor_bytes(&s);
        let back: Sample = from_cbor_bytes(&bytes).expect("decode");
        assert_eq!(s, back);
    }

    #[test]
    fn trailing_bytes_rejected() {
        let s = Sample {
            a: 1,
            b: "x".into(),
        };
        let mut bytes = to_cbor_bytes(&s);
        bytes.push(0xFF);
        assert!(matches!(
            from_cbor_bytes::<Sample>(&bytes),
            Err(CborError::TrailingBytes)
        ));
    }

    #[test]
    fn prefix_reports_consumed_and_vector_round_trips() {
        let s = Sample {
            a: 3,
            b: "v".into(),
        };
        let vec = vec![1.0f32, -2.5, 3.25];
        let mut payload = to_cbor_bytes(&s);
        let cbor_len = payload.len();
        payload.extend_from_slice(&f32_slice_to_le_bytes(&vec));

        let (back, consumed): (Sample, usize) = from_cbor_prefix(&payload).expect("prefix");
        assert_eq!(back, s);
        assert_eq!(consumed, cbor_len);
        let got = le_bytes_to_f32_vec(&payload[consumed..]).expect("vec");
        assert_eq!(got, vec);
    }

    #[test]
    fn ragged_vector_section_rejected() {
        assert!(matches!(
            le_bytes_to_f32_vec(&[0u8, 1, 2]),
            Err(CborError::RaggedVector(3))
        ));
    }
}
