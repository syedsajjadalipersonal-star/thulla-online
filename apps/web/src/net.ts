/**
 * A seat at an online Thulla table: signs in to Nakama, opens or joins a table by room code,
 * and passes the match handler's messages to callbacks. No DOM code, so Node scripts use it too.
 */
import { Client, type Session, type Socket } from '@heroiclabs/nakama-js';
import {
  OP_EVENT,
  OP_PLAY,
  OP_PROMPT,
  OP_REJECTED,
  OP_RELEASED,
  OP_RESYNC,
  OP_SEATS,
  OP_START,
  OP_TAKE_BACK,
  OP_VOTE,
  OP_WELCOME,
  type CreateTableResponse,
  type EventMessage,
  type JoinByCodeResponse,
  type PromptMessage,
  type RejectedMessage,
  type SeatsMessage,
  type WelcomeMessage,
} from '../../../packages/nakama/src/protocol';

export interface ServerAddress {
  host: string;
  port: string;
  ssl: boolean;
  serverKey: string;
}

export interface TableHandlers {
  welcome?(msg: WelcomeMessage): void;
  event?(msg: EventMessage): void;
  prompt?(msg: PromptMessage): void;
  rejected?(msg: RejectedMessage): void;
  seats?(msg: SeatsMessage): void;
  /** For bots: the seat is no longer theirs. */
  released?(): void;
  disconnected?(): void;
}

export class Table {
  private client: Client;
  private session: Session | null = null;
  private socket: Socket | null = null;
  matchId = '';
  code = '';

  constructor(
    private server: ServerAddress,
    private deviceId: string,
    public handlers: TableHandlers = {},
  ) {
    this.client = new Client(server.serverKey, server.host, server.port, server.ssl);
  }

  /** Signs in with this device id, creating the account on first use, and opens the socket. */
  async connect(): Promise<void> {
    this.socket?.disconnect(false);
    this.socket = null;
    this.session = await this.client.authenticateDevice(this.deviceId, true);
    const socket = this.client.createSocket(this.server.ssl, false);
    socket.onmatchdata = (m) => this.receive(m.op_code, new TextDecoder().decode(m.data));
    socket.ondisconnect = () => {
      if (this.socket === socket) this.handlers.disconnected?.();
    };
    await socket.connect(this.session, false);
    this.socket = socket;
  }

  async create(name: string): Promise<void> {
    const res = (await this.client.rpc(this.requireSession(), 'create_table', {})).payload as CreateTableResponse;
    await this.join(res.matchId, res.code, name);
  }

  async joinByCode(code: string, name: string): Promise<void> {
    const res = (await this.client.rpc(this.requireSession(), 'join_by_code', { code })).payload as JoinByCodeResponse;
    await this.join(res.matchId, res.code, name);
  }

  /** Joins a match directly, as when coming back to a table after a reload. */
  async join(matchId: string, code: string, name: string, extra: Record<string, string> = {}): Promise<void> {
    if (!this.socket) throw new Error('Not connected.');
    await this.socket.joinMatch(matchId, undefined, { ...extra, name });
    this.matchId = matchId;
    this.code = code;
  }

  /** Deals. With `bots`, empty seats get bots, once every other player agrees. */
  start(bots = false): void {
    this.send(OP_START, { bots });
  }

  vote(agree: boolean): void {
    this.send(OP_VOTE, { agree });
  }

  takeBack(): void {
    this.send(OP_TAKE_BACK, {});
  }

  play(card: number, seq: number): void {
    this.send(OP_PLAY, { card, seq });
  }

  resync(fromSeq: number): void {
    this.send(OP_RESYNC, { fromSeq });
  }

  async leave(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      if (this.matchId) await socket.leaveMatch(this.matchId);
    } catch {
      /* already gone */
    }
    socket.disconnect(false);
    this.matchId = '';
  }

  private send(opCode: number, body: object): void {
    if (this.socket && this.matchId) void this.socket.sendMatchState(this.matchId, opCode, JSON.stringify(body));
  }

  private receive(opCode: number, text: string): void {
    const body = JSON.parse(text);
    const h = this.handlers;
    if (opCode === OP_WELCOME) h.welcome?.(body);
    else if (opCode === OP_EVENT) h.event?.(body);
    else if (opCode === OP_PROMPT) h.prompt?.(body);
    else if (opCode === OP_REJECTED) h.rejected?.(body);
    else if (opCode === OP_SEATS) h.seats?.(body);
    else if (opCode === OP_RELEASED) h.released?.();
  }

  private requireSession(): Session {
    if (!this.session) throw new Error('Not signed in.');
    return this.session;
  }
}

/** Turns an error from the Nakama client (often a fetch Response) into a readable sentence. */
export async function errorText(error: unknown): Promise<string> {
  const e = error as { message?: string; json?: () => Promise<{ message?: string }> };
  if (e && typeof e.json === 'function') {
    try {
      const body = await e.json();
      if (body && body.message) return body.message;
    } catch {
      /* not JSON */
    }
  }
  return (e && e.message) || 'Could not reach the server.';
}
