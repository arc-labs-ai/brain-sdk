//! Wire-protocol opcodes (u16, big-endian on the wire).
//!
//! High byte is the namespace (`0x00` substrate / connection / admin,
//! `0x01` typed-graph). Within a namespace the low byte's high bit
//! selects direction: `< 0x80` server-bound request, `>= 0x80`
//! client-bound response. Phase 1 covers the handshake, the three v1
//! verbs, BYE, and ERROR; the rest arrive as later phases need them.

/// Wire-protocol opcode.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
#[repr(u16)]
pub enum Opcode {
    // Connection management.
    Hello = 0x0001,
    Welcome = 0x0081,
    Auth = 0x0002,
    AuthOk = 0x0082,
    Bye = 0x001F,

    // Keepalive. PING/PONG are client-initiated RTT probes; SERVER_PING is
    // the server's idle-timer heartbeat that the client MUST answer with
    // CLIENT_PONG or the server closes the connection.
    Ping = 0x0010,
    Pong = 0x0090,
    ClientPong = 0x0011,
    ServerPing = 0x0091,

    // v1 cognitive verbs.
    EncodeReq = 0x0020,
    EncodeResp = 0x00A0,
    RecallReq = 0x0021,
    RecallResp = 0x00A1,
    PlanReq = 0x0022,
    PlanResp = 0x00A2,
    ReasonReq = 0x0023,
    ReasonResp = 0x00A3,
    ForgetReq = 0x0024,
    ForgetResp = 0x00A4,
    LinkReq = 0x0025,
    LinkResp = 0x00A5,
    UnlinkReq = 0x0026,
    UnlinkResp = 0x00A6,
    EncodeVectorDirectReq = 0x002A,
    EncodeVectorDirectResp = 0x00AA,

    // Subscriptions (server push).
    SubscribeReq = 0x0030,
    SubscribeEvent = 0x00B0,
    UnsubscribeReq = 0x0031,
    UnsubscribeResp = 0x00B1,

    // Transactions.
    TxnBegin = 0x0040,
    TxnBeginResp = 0x00C0,
    TxnCommit = 0x0041,
    TxnCommitResp = 0x00C1,
    TxnAbort = 0x0042,
    TxnAbortResp = 0x00C2,

    // Error.
    Error = 0x00FF,

    // Capability introspection.
    GetCapabilitiesReq = 0x0032,
    GetCapabilitiesResp = 0x00B2,

    // Typed-graph ops exercised by the corpus.
    SchemaUploadReq = 0x0120,
    SchemaUploadResp = 0x01A0,
    SchemaGetReq = 0x0121,
    SchemaGetResp = 0x01A1,
    SchemaListReq = 0x0122,
    SchemaListResp = 0x01A2,
    SchemaValidateReq = 0x0123,
    SchemaValidateResp = 0x01A3,
    EntityCreateReq = 0x0130,
    EntityCreateResp = 0x01B0,
    EntityGetReq = 0x0131,
    EntityGetResp = 0x01B1,
    EntityResolveReq = 0x0136,
    EntityResolveResp = 0x01B6,
    EntityListReq = 0x0137,
    EntityListResp = 0x01B7,
    StatementCreateReq = 0x0140,
    StatementCreateResp = 0x01C0,
    StatementGetReq = 0x0141,
    StatementGetResp = 0x01C1,
    StatementListReq = 0x0146,
    StatementListResp = 0x01C6,
    RelationCreateReq = 0x0150,
    RelationCreateResp = 0x01D0,
    RelationListFromReq = 0x0154,
    RelationListFromResp = 0x01D4,
    RelationListToReq = 0x0155,
    RelationListToResp = 0x01D5,
    QueryReq = 0x0160,
    QueryResp = 0x01E0,
    MaterializeProceduralReq = 0x0164,
    MaterializeProceduralResp = 0x01E4,
}

impl Opcode {
    /// Numeric value as it appears in the frame header.
    #[inline]
    #[must_use]
    pub fn as_u16(self) -> u16 {
        self as u16
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_pinned_values() {
        assert_eq!(Opcode::Hello.as_u16(), 0x0001);
        assert_eq!(Opcode::Welcome.as_u16(), 0x0081);
        assert_eq!(Opcode::Auth.as_u16(), 0x0002);
        assert_eq!(Opcode::AuthOk.as_u16(), 0x0082);
        assert_eq!(Opcode::Bye.as_u16(), 0x001F);
        assert_eq!(Opcode::Ping.as_u16(), 0x0010);
        assert_eq!(Opcode::Pong.as_u16(), 0x0090);
        assert_eq!(Opcode::ClientPong.as_u16(), 0x0011);
        assert_eq!(Opcode::ServerPing.as_u16(), 0x0091);
        assert_eq!(Opcode::EncodeReq.as_u16(), 0x0020);
        assert_eq!(Opcode::EncodeResp.as_u16(), 0x00A0);
        assert_eq!(Opcode::RecallReq.as_u16(), 0x0021);
        assert_eq!(Opcode::RecallResp.as_u16(), 0x00A1);
        assert_eq!(Opcode::PlanReq.as_u16(), 0x0022);
        assert_eq!(Opcode::PlanResp.as_u16(), 0x00A2);
        assert_eq!(Opcode::ReasonReq.as_u16(), 0x0023);
        assert_eq!(Opcode::ReasonResp.as_u16(), 0x00A3);
        assert_eq!(Opcode::ForgetReq.as_u16(), 0x0024);
        assert_eq!(Opcode::ForgetResp.as_u16(), 0x00A4);
        assert_eq!(Opcode::LinkReq.as_u16(), 0x0025);
        assert_eq!(Opcode::LinkResp.as_u16(), 0x00A5);
        assert_eq!(Opcode::UnlinkReq.as_u16(), 0x0026);
        assert_eq!(Opcode::UnlinkResp.as_u16(), 0x00A6);
        assert_eq!(Opcode::EncodeVectorDirectReq.as_u16(), 0x002A);
        assert_eq!(Opcode::Error.as_u16(), 0x00FF);
        assert_eq!(Opcode::MaterializeProceduralReq.as_u16(), 0x0164);

        // Subscriptions.
        assert_eq!(Opcode::SubscribeReq.as_u16(), 0x0030);
        assert_eq!(Opcode::SubscribeEvent.as_u16(), 0x00B0);
        assert_eq!(Opcode::UnsubscribeReq.as_u16(), 0x0031);
        assert_eq!(Opcode::UnsubscribeResp.as_u16(), 0x00B1);

        // Transactions.
        assert_eq!(Opcode::TxnBegin.as_u16(), 0x0040);
        assert_eq!(Opcode::TxnBeginResp.as_u16(), 0x00C0);
        assert_eq!(Opcode::TxnCommit.as_u16(), 0x0041);
        assert_eq!(Opcode::TxnCommitResp.as_u16(), 0x00C1);
        assert_eq!(Opcode::TxnAbort.as_u16(), 0x0042);
        assert_eq!(Opcode::TxnAbortResp.as_u16(), 0x00C2);

        // Read-side typed-graph + capability ops.
        assert_eq!(Opcode::GetCapabilitiesReq.as_u16(), 0x0032);
        assert_eq!(Opcode::GetCapabilitiesResp.as_u16(), 0x00B2);
        assert_eq!(Opcode::SchemaGetReq.as_u16(), 0x0121);
        assert_eq!(Opcode::SchemaGetResp.as_u16(), 0x01A1);
        assert_eq!(Opcode::SchemaListReq.as_u16(), 0x0122);
        assert_eq!(Opcode::SchemaListResp.as_u16(), 0x01A2);
        assert_eq!(Opcode::SchemaValidateReq.as_u16(), 0x0123);
        assert_eq!(Opcode::SchemaValidateResp.as_u16(), 0x01A3);
        assert_eq!(Opcode::EntityGetReq.as_u16(), 0x0131);
        assert_eq!(Opcode::EntityGetResp.as_u16(), 0x01B1);
        assert_eq!(Opcode::EntityResolveReq.as_u16(), 0x0136);
        assert_eq!(Opcode::EntityResolveResp.as_u16(), 0x01B6);
        assert_eq!(Opcode::EntityListReq.as_u16(), 0x0137);
        assert_eq!(Opcode::EntityListResp.as_u16(), 0x01B7);
        assert_eq!(Opcode::StatementGetReq.as_u16(), 0x0141);
        assert_eq!(Opcode::StatementGetResp.as_u16(), 0x01C1);
        assert_eq!(Opcode::StatementListReq.as_u16(), 0x0146);
        assert_eq!(Opcode::StatementListResp.as_u16(), 0x01C6);
        assert_eq!(Opcode::RelationListFromReq.as_u16(), 0x0154);
        assert_eq!(Opcode::RelationListFromResp.as_u16(), 0x01D4);
        assert_eq!(Opcode::RelationListToReq.as_u16(), 0x0155);
        assert_eq!(Opcode::RelationListToResp.as_u16(), 0x01D5);
    }
}
