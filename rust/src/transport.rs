//! Async frame transport: read and write whole BRN0 frames over a byte
//! stream.
//!
//! This is the seam between the byte stream (a TCP socket, or any
//! `AsyncRead + AsyncWrite`) and the frame codec in [`crate::wire::frame`].
//! Writing is a single buffered call. Reading is incremental: a frame can
//! straddle socket reads, so [`read_frame`] keeps a caller-owned buffer,
//! pulls more bytes whenever the codec reports the buffer is short, and
//! drains exactly the frame's bytes once one decodes — leaving any trailing
//! bytes (the start of the next frame) in the buffer.

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::{BrainError, Result};
use crate::wire::frame::{Frame, FrameError};

/// Bytes pulled from the stream per read syscall when the buffer is short.
const READ_CHUNK: usize = 16 * 1024;

/// Serialize `frame` and write all its bytes to `stream`.
///
/// One `write_all` per frame; the OS coalesces. Packet coalescing across
/// many queued frames is a connection-layer concern for a later phase.
pub async fn write_frame<W>(stream: &mut W, frame: &Frame) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    let bytes = frame.encode()?;
    stream.write_all(&bytes).await?;
    Ok(())
}

/// Read exactly one frame from `stream`, using `buf` to hold bytes that
/// span reads. On return `buf` holds only the bytes after the decoded
/// frame, ready for the next call.
///
/// A [`FrameError::Truncated`] from the codec means "need more bytes" and
/// drives another read; any other codec error is fatal for the connection
/// (a corrupt frame desynchronizes the stream) and surfaces to the caller.
/// A zero-length read with a non-empty buffer is a truncated frame mid-flight
/// and maps to [`BrainError::Closed`].
pub async fn read_frame<R>(stream: &mut R, buf: &mut Vec<u8>) -> Result<Frame>
where
    R: AsyncRead + Unpin,
{
    loop {
        match Frame::decode(buf) {
            Ok((frame, rest)) => {
                // Drain exactly the frame's bytes, keeping any tail (the
                // start of the next frame) for the following call.
                let consumed = buf.len() - rest.len();
                buf.drain(..consumed);
                return Ok(frame);
            }
            // Need more bytes before a frame is complete; read and retry.
            Err(FrameError::Truncated { .. }) => {}
            // Any other codec error desynchronizes the stream — fatal.
            Err(e) => return Err(BrainError::Frame(e)),
        }

        let start = buf.len();
        buf.resize(start + READ_CHUNK, 0);
        let n = stream.read(&mut buf[start..]).await?;
        buf.truncate(start + n);
        if n == 0 {
            return Err(BrainError::Closed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::frame::FLAG_EOS;

    #[tokio::test]
    async fn round_trips_a_frame_through_a_duplex_pipe() {
        let (mut client, mut server) = tokio::io::duplex(1024);
        let frame = Frame::new(0x0020, FLAG_EOS, 7, b"payload bytes".to_vec());

        write_frame(&mut client, &frame).await.expect("write");

        let mut buf = Vec::new();
        let got = read_frame(&mut server, &mut buf).await.expect("read");
        assert_eq!(got, frame);
        assert!(buf.is_empty(), "no bytes should remain after one frame");
    }

    #[tokio::test]
    async fn reads_a_frame_split_across_two_writes() {
        let (mut client, mut server) = tokio::io::duplex(1024);
        let frame = Frame::new(0x0021, FLAG_EOS, 1, b"hello brain".to_vec());
        let bytes = frame.encode().expect("frame fits");
        let (head, tail) = bytes.split_at(20);

        let reader = tokio::spawn(async move {
            let mut buf = Vec::new();
            read_frame(&mut server, &mut buf).await.map(|f| (f, buf))
        });

        client.write_all(head).await.expect("write head");
        // Yield so the reader observes a partial buffer before the rest.
        tokio::task::yield_now().await;
        client.write_all(tail).await.expect("write tail");

        let (got, leftover) = reader.await.expect("join").expect("read");
        assert_eq!(got, frame);
        assert!(leftover.is_empty());
    }

    #[tokio::test]
    async fn leaves_trailing_bytes_for_the_next_frame() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let first = Frame::new(0x0020, FLAG_EOS, 1, b"first".to_vec());
        let second = Frame::new(0x0021, FLAG_EOS, 2, b"second".to_vec());
        let mut both = first.encode().expect("frame fits");
        both.extend_from_slice(&second.encode().expect("frame fits"));
        client.write_all(&both).await.expect("write both");

        let mut buf = Vec::new();
        let a = read_frame(&mut server, &mut buf).await.expect("read first");
        let b = read_frame(&mut server, &mut buf)
            .await
            .expect("read second");
        assert_eq!(a, first);
        assert_eq!(b, second);
    }

    #[tokio::test]
    async fn closed_stream_maps_to_closed_error() {
        let (client, mut server) = tokio::io::duplex(64);
        drop(client);
        let mut buf = Vec::new();
        let err = read_frame(&mut server, &mut buf).await.unwrap_err();
        assert!(matches!(err, BrainError::Closed));
    }
}
