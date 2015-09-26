
import { Bot } from '../../bot';
import { Connection } from '../base/connection';

import { Socket } from 'net';
import { IrcServer } from './irc_server';
import { IRC } from './irc';
import * as tls  from 'tls';
import * as _ from 'lodash';
import { ITimer } from '../../utilities/timer';
import * as Hook from '../../utilities/hook';
import { Transform } from 'stream';

export class IrcConnection extends Connection {

  public reconnect_attempts = 0;
  public request_disconnect = false;

  private use_write_buffer = false;
  private buffer = new Transform();
  private pong_timer: ITimer;
  private reconnect_timer: ITimer;
  private held_data: any;
  private hold_last: boolean;
  private registered = false;

  constructor( public network: IRC, public server: IrcServer ) {
    super( network, server );
  }

  public connect(): void {
    if ( this.connected() ) {
      this.network.bot.emit( 'already connected', this.network, this.server );
      return;
    }


    Hook.pre( 'connect', this );

    var socket_connect_event = 'connect';

    if ( this.server.ssl ){

      // socket does nothing when this is called
      // this.socket = new tls.TLSSocket( this.socket, {
      //   isServer: false,
      //   rejectUnauthorized: this.network.reject_invalid_certs
      // });

      this.socket = tls.connect( {
        rejectUnauthorized: this.network.reject_invalid_certs,
        host: this.server.host,
        port: this.server.port
      } );

      socket_connect_event = 'secureConnect';
    } else {
      this.socket = new Socket();
      this.socket.connect( this.server.port, this.server.host );
    }

    this.socket.on( socket_connect_event, this.connectionSetup.bind( this ) )
      .on( 'error', this.onError.bind( this ) );
  }

  private connectionSetup(): void {
    this.pipeSetup();
    this.bot.emit( 'connect::' + this.network.name, this.network, this.server );

    // this.socket.setEncoding( this.network.encoding );

    this._connected = true;

    this.send_cap_ls();
    this.send_cap_end();
    this.send_login();

    if ( !this.pong_timer ) {

      this.pong_timer = this.network.Timer(
        {
          interval: 120000,
          autoStart: true,
          blocking: false,
          ignoreErrors: false,
          immediate: true,
          emitLevel: 0,
          reference: 'pong::' + this.network.name,
          stopOn: 'disconnect::' + this.network.name,
          restartOn: 'registered::' + this.network.name
      }, this.pong.bind( this ) );
    }

    this.socket.on( 'data', this.onData.bind( this ) );
    // this.socket.on( 'data', this.parseMessage.bind( this ) );
    this.socket.on( 'end', this.onEnd.bind( this ) );
    this.socket.on( 'close', this.onClose.bind( this ) );

    Hook.post( 'connect', this );

    this.bot.emit( 'registered::' + this.network.name , this.network, this.server );
  }

  private pipeSetup(): void {
    var self = this;
    this.buffer.pipe( this.socket );
    this.buffer.on( 'pause', () => {
      self.buffer.once( 'drain', () => {
        self.buffer.resume();
      });
    });
  }

  /**
  * Disconnect from the network
  * @param <string> message: The quit message to send
  * @return <void>
  */
  public disconnect( message: string = this.network.quit_message ): void {
    if ( !this.connected() && !this.socket ) { return; }

    if ( this.pong_timer ) { this.pong_timer.stop(); }

    this.request_disconnect = true;

    this.send( 'QUIT : ' + message );

    process.nextTick( this.end.bind( this ) );
  }

  public dispose( message?: string ): void {
    if ( this.connected() )
      this.disconnect( message );

    if ( this.reconnect_timer )
      this.reconnect_timer.stop();

    if ( this.socket )
      this.disposeSocket();
  }

  private disposeSocket(): void {
    if ( this.socket ) {
      this.socket.end();
      this.socket.removeAllListeners();
      this.socket = null;
    }
  }

  /**
  * Called when the socket receives data
  * @param <Buffer> data: The data received from the socket
  * @return <void>
  */
  private onData( data: Buffer ) {
    var data_pos: number,               // Current position within the data Buffer
        line_start = 0,
        lines: Buffer[] = [],
        max_buffer_size = 1024; // 1024 bytes is the maximum length of two RFC1459 IRC messages.
                                // May need tweaking when IRCv3 message tags are more widespread

    // Split data chunk into individual lines
    for ( data_pos = 0; data_pos < data.length; data_pos++ ) {
        if ( data[ data_pos ] === 0x0A ) { // Check if byte is a line feed
            lines.push( data.slice( line_start, data_pos ) );
            line_start = data_pos + 1;
        }
    }

    // No complete lines of data? Check to see if buffering the data would exceed the max buffer size
    if ( !lines[ 0 ] ) {
        if ( ( this.held_data ? this.held_data.length : 0 ) + data.length > max_buffer_size ) {
            // Buffering this data would exeed our max buffer size
            this.bot.emit( 'error', 'Message buffer too large' );
            this.socket.destroy();

        } else {

            // Append the incomplete line to our held_data and wait for more
            if ( this.held_data ) {
                this.held_data = Buffer.concat( [ this.held_data, data ], this.held_data.length + data.length );
            } else {
                this.held_data = data;
            }
        }

        // No complete lines to process..
        return;
    }

    // If we have an incomplete line held from the previous chunk of data
    // merge it with the first line from this chunk of data
    if ( this.hold_last && this.held_data !== null ) {
        lines[ 0 ] = Buffer.concat( [ this.held_data, lines[ 0 ] ], this.held_data.length + lines[ 0 ].length );
        this.hold_last = false;
        this.held_data = null;
    }

    // If the last line of data in this chunk is not complete, hold it so
    // it can be merged with the first line from the next chunk
    if ( line_start < data_pos ) {
        if ( ( data.length - line_start ) > max_buffer_size ) {
            // Buffering this data would exeed our max buffer size
            this.bot.emit( 'error', 'Message buffer too large' );
            this.socket.destroy();
            return;
        }

        this.hold_last = true;
        this.held_data = new Buffer( data.length - line_start );
        data.copy( this.held_data, 0, line_start );
    }

    // Process our data line by line
    for ( let i = 0; i < lines.length; i++ ) {
      this.parseMessage( lines[ i ].toString( this.network.encoding ) );
    }
  }

  public end(): void {
    this.disposeSocket();
    this.network.clearTimers();
    this.buffer.unpipe( this.socket );
  }

  // more on this later...
  // TODO utilize buffer
  public send( data: string ): void {
    if ( this.connected() && this.socket )
      // this.socket.write( data + '\r\n' );
      this.buffer.push( data + '\r\n' );
  }

  /**
  * Called when the socket connection is closed
  * @param <boolean> error: Did the socket connection close because of an error?
  * @return <void>
  */
  private onClose( error: boolean ): void {
    this.socket.end();
    this._connected = false;

    if ( this.pong_timer )
      this.pong_timer.stop();

    if ( !this.request_disconnect )
      this.reconnect();
  }


  /**
  * Called if the socket has an error
  * @param <any> e: The Error type objct that gets passed
  * @return <void>
  */
  private onError( e: any ): void {
    console.log( 'onError', e );

    switch ( e.code ) {
      case 'EPIPE':
        if ( this.pong_timer )
          this.pong_timer.stop();

        if ( !this.request_disconnect )
          return this.reconnect();

        break;
      case 'ENETUNREACH':
        return this.server.disable();

      case 'ETIMEDOUT':
        if ( this.reconnect_attempts < this.network.connection_attempts )
          return this.server.disable();

        this.reconnect_attempts++;
        this.reconnect();
        break;
      default: {
        this.bot.Logger.error( 'an unswitched error occurred', e );
      }
    }
  }

  /**
  * Setup the reconnect timer to delay reconnection to the current server
  * @return <void>
  */
  private reconnect(): void {
    this.reconnect_delay = this.reconnect_delay * this.reconnect_attempts || this.reconnect_delay;

    this.bot.Logger.info( 'setting timer to delay ' + this.server.host + ' reconnection for ' + ( this.reconnect_delay / 1000 ).toString() + ' seconds on network ' + this.network.name );

    if ( this.reconnect_timer )

      this.reconnect_timer.interval = this.reconnect_delay;

    else
      this.reconnect_timer = this.network.Timer( {
        infinite: false,
        interval: this.reconnect_delay,
        reference: 'reconnect timer ' + this.network.name,
      }, this.connect.bind( this ) );

    this.reconnect_timer.start();
  }

  private onEnd(): void {
    this._connected = false;

    if ( this.request_disconnect ) {
      // do things to end connection
    } else {
      // do things to reconnect ( should we assume or have a reconnect: boolean setting ?)
    }
  }

  /**
  * Sends a PONG message to the IRC server
  * @param <string> message: the message to include
  * @param <Function> done: The callback to invoke
  * @return <void>
  */
  private pong( message: string ): void;
  private pong( done: Function ): void;
  private pong( message: string, done?: Function ): void;
  private pong( message?: any, done?: Function ): void {
    if ( this.socket.destroyed )
      return this.disconnect();

    if ( typeof message === 'function' ) {
      done = message;
      message = null;
    }

    this.send( 'PONG '+ ( message ? message : this.server.host ) );

    if ( done )
      done();
  }

  /**
  * Send a CAP LIST to the IRC server
  * @return <void>
  */
  private send_cap_ls(): void {
    this.send( 'CAP LS ' );
  }

  // TODO: get network capabilities
  private send_cap_req(): void {
    this.send( 'CAP REQ :' );
  }

  /**
  * End the CAP negotiations
  * @return <void>
  */
  private send_cap_end(): void {
    this.send( 'CAP END' );
  }

  /**
  * Send login information to the IRC server
  * @return <void>
  */
  private send_login(): void {
    var password = this.server.password || this.network.password;
    if ( password )
      this.send( "PASS " + password );

    this.send( 'NICK ' + this.network.generate_nick() );
    this.send( 'USER ' + this.network.user + ' ' + ( _.include( this.network.modes, 'i' ) ? '8' : '0' ) + " * :" + this.network.realname  );
  }

  private flushWriteBuffer(): void {

    // if disconnected, reset buffer
    // if ( this.disconnected() ) {
    //   return this.bufferReset();
    // }


    // buffer is empty
    // if ( !this.write_buffer.length ) {
    //   return this.bufferReset();
    // }

  }

  /**
  * Reset the write Buffer
  * @return <void>
  */
  // private bufferReset(): void {
  //   this.write_buffer   = [];
  //   this.writing_buffer = false;
  // }

  /**
  * Parse the data received from the server
  * @param <string> line: The line to parse
  * @return <void>
  */
  private parseMessage( line: string ): void {
    var tags: any[] = [];

    if ( !line )
      return;

    line = line.trim();

    var parse_regex = /^(?:(?:(?:@([^ ]+) )?):(?:([^\s!]+)|([^\s!]+)!([^\s@]+)@?([^\s]+)?) )?(\S+)(?: (?!:)(.+?))?(?: :(.*))?$/i;

    var message = parse_regex.exec( line.replace( /^\r+|\r+$/, '' ) );

    if ( !message ) {
      this.bot.Logger.warn( 'Malformed IRC line: %s', line.replace( /^\r+|\r+$/, '' ) );
      return;
    }

    // Extract any tags (message[1])
    if ( message[ 1 ] ) {
        tags = message[ 1 ].split( ';' );

        for ( let i = 0; i < tags.length; i++ ) {
            let tag = tags[ i ].split( '=' );
            tags[ i ] = { tag: tag[ 0 ], value: tag[ 1 ] };
        }
    }

    var msg_obj = {
        tags:       tags,
        prefix:     message[ 2 ],
        nick:       message[ 3 ] || message[ 2 ],  // Nick will be in the prefix slot if a full user mask is not used
        ident:      message[ 4 ] || '',
        hostname:   message[ 5 ] || '',
        command:    message[ 6 ],
        params:     message[ 7 ] ? message[ 7 ].split( / +/ ) : []
    };

    if ( message[ 8 ] ) {
        msg_obj.params.push( message[ 8 ].replace( /\s+$/, '' ) );
    }
  }
}