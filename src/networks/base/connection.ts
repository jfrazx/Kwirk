'use strict';

import { Network } from './network';
import { Transform } from 'stream';
import { Server } from './server';
import { TLSSocket } from 'tls';
import { Bot } from '../../bot';
import { Socket } from 'net';

export abstract class Connection<N extends Network> implements IConnection<N> {
  public socket: Socket | TLSSocket;
  public server: Server<N>;
  public nick: string;

  protected _connected = false;
  protected reconnectDelay = 5000;
  protected writeBuffer: string[] = [];
  protected buffer = new Transform();

  constructor(public network: N) {}

  public isConnected(): boolean {
    return this._connected;
  }

  public disconnected(): boolean {
    return !this._connected;
  }

  /**
   * Connect on with this connection
   * @return <void>
   */
  public abstract connect(): void;

  public abstract dispose(): void;

  public abstract end(): void;

  /**
   * End socket connection and listeners
   * @return <void>
   * @protected
   */
  protected disposeSocket(): void {
    if (this.socket) {
      this.socket.end();
      this.socket.removeAllListeners();
      this.socket = null;
    }
  }
}

export interface IConnection<N extends Network> extends IConnectionOptions {
  network: N;
  server: Server<N>;
  socket: Socket | TLSSocket;

  connect(): void;
  isConnected(): boolean;
  disconnected(): boolean;
  dispose(message?: string): void;
}

export interface IConnectionOptions {}
