/**
 * A single connection: the handshake and one-at-a-time request/response over
 * a frame channel.
 *
 * This phase serves one request at a time (send, then read the response to
 * EOS). The concurrent stream multiplexer and pool are a later phase and will
 * reuse this type's frame plumbing. `streamId` 0 is reserved for the
 * handshake; request streams are numbered from 1 upward.
 */

import { BrainTimeout, ProtocolError, ServerError, VersionMismatch } from "./errors.js";
import { FrameChannel, withTimeout } from "./transport.js";
import { FLAG_EOS, type Frame } from "./wire/frame.js";
import { Opcode } from "./wire/opcode.js";
import {
  type AuthOkPayload,
  type AuthPayload,
  type HelloPayload,
  type WelcomePayload,
  decodeAuthOk,
  decodeError,
  decodeWelcome,
  encodeAuth,
  encodeHello,
} from "./wire/types.js";

/** The `streamId` carried by every handshake frame. */
const HANDSHAKE_STREAM_ID = 0;

/** What the server told us during the handshake. */
export interface HandshakeOutcome {
  welcome: WelcomePayload;
  authOk: AuthOkPayload;
}

/** One connection to a Brain server. */
export class Connection {
  private nextStreamId = 1;

  constructor(
    private readonly chan: FrameChannel,
    private readonly requestTimeoutMs?: number,
  ) {}

  /**
   * Run the client side of the handshake: HELLO -> WELCOME -> AUTH ->
   * AUTH_OK. Validates the chosen version was offered and that each reply
   * carries the expected opcode.
   */
  async handshake(hello: HelloPayload, auth: AuthPayload): Promise<HandshakeOutcome> {
    const offered = [...hello.supportedVersions];

    await this.send(Opcode.Hello, HANDSHAKE_STREAM_ID, encodeHello(hello));
    const welcomeFrame = await this.readReply(Opcode.Welcome);
    const welcome = decodeWelcome(welcomeFrame.payload);
    if (!offered.includes(welcome.chosenVersion)) {
      throw new VersionMismatch(welcome.chosenVersion, offered);
    }

    await this.send(Opcode.Auth, HANDSHAKE_STREAM_ID, encodeAuth(auth));
    const authOkFrame = await this.readReply(Opcode.AuthOk);
    const authOk = decodeAuthOk(authOkFrame.payload);

    return { welcome, authOk };
  }

  /**
   * Send one request and collect its response frames up to and including the
   * EOS frame. Single-shot verbs return one frame; streaming verbs return
   * several. An ERROR reply rejects with `ServerError`.
   */
  async request(opcode: number, payload: Uint8Array): Promise<Frame[]> {
    const streamId = this.takeStreamId();
    await this.send(opcode, streamId, payload);

    const frames: Frame[] = [];
    for (;;) {
      const frame = await this.readFrame();
      if (frame.opcode === Opcode.Error) {
        throw new ServerError(decodeError(frame.payload));
      }
      if (frame.streamId !== streamId) {
        throw new ProtocolError(
          `response on stream ${frame.streamId} but request used stream ${streamId}`,
        );
      }
      frames.push(frame);
      if ((frame.flags & FLAG_EOS) !== 0) return frames;
    }
  }

  /**
   * Send one request and require exactly one EOS response frame — the shape
   * every single-shot verb uses.
   */
  async requestOne(opcode: number, payload: Uint8Array): Promise<Frame> {
    const frames = await this.request(opcode, payload);
    if (frames.length !== 1) {
      throw new ProtocolError(`expected a single response frame, got ${frames.length}`);
    }
    return frames[0]!;
  }

  /** Send BYE to end the session cleanly. The server closes without a reply. */
  async sendBye(): Promise<void> {
    await this.send(Opcode.Bye, HANDSHAKE_STREAM_ID, new Uint8Array(0));
  }

  /** Destroy the underlying connection. */
  close(): void {
    this.chan.close();
  }

  // ---- internals ----

  private async send(opcode: number, streamId: number, payload: Uint8Array): Promise<void> {
    await this.chan.write({ opcode, flags: FLAG_EOS, streamId, payload });
  }

  private async readReply(expected: number): Promise<Frame> {
    const frame = await this.readFrame();
    if (frame.opcode === Opcode.Error) {
      throw new ServerError(decodeError(frame.payload));
    }
    if (frame.opcode !== expected) {
      throw new ProtocolError(
        `expected opcode 0x${expected.toString(16).padStart(4, "0")}, got ` +
          `0x${frame.opcode.toString(16).padStart(4, "0")}`,
      );
    }
    return frame;
  }

  private readFrame(): Promise<Frame> {
    return withTimeout(
      this.chan.read(),
      this.requestTimeoutMs,
      () => new BrainTimeout(this.requestTimeoutMs!),
    );
  }

  private takeStreamId(): number {
    const id = this.nextStreamId;
    // 32-bit wire field; wrap past the max back to 1 (0 stays reserved for
    // the handshake).
    this.nextStreamId = this.nextStreamId >= 0xffff_ffff ? 1 : this.nextStreamId + 1;
    return id;
  }
}
