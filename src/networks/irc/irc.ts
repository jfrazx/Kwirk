
import { IrcServer, IIrcServerOptions } from './irc_server';
import { Network, INetwork, INetOptions, INetworkOptions } from '../base/network';
import { IrcChannel, IIrcChannel } from './irc_channel';
import { Bot } from '../../bot';
import { IrcConnection } from './irc_connection';
import { AnyNet } from '../netfactory';
import { ISasl } from './sasl/sasl';
import { Timer } from '../../utilities/timer';
import * as _ from 'lodash';

export class IRC extends Network implements IIRC {

  public servers: IrcServer[] = [];
  public channels: IrcChannel[] = [];
  public channel: { [ chan: string ]: IrcChannel } = {};
  public connection: IrcConnection = null;
  public connection_attempts: number;
  public active_server: IrcServer = null;
  public motd: string[];
  public name: string;
  public nick: string;
  public altnick: string;
  public quit_message: string;
  public encoding: string;
  public reject_invalid_certs: boolean;
  public password: string;
  public user: string;
  public realname: string;
  public modes: string[];
  public options: IIrcOptions;
  public sasl: ISasl;

  private _index = 0;
  private auto_disabled_timer: Timer;
  private auto_disable_interval = 180000;
  private auto_disable_times    = 0;

  /**
  * @param <Bot> bot: The bot!!!
  * @param <IIrcOptions> options: Options for configuring this network type
  */
  constructor( bot: Bot, options: IIrcOptions ) {
    super( bot, options.name );

    this.options = _.defaults( options, this.defaults() );
    this._enable = options.enable;

    _.merge( this, _.omit( this.options, [ 'enable', 'servers', 'channels', 'type' ] ) );

    _.each( this.options.servers, ( server: IIrcServerOptions ) => {
      this.addServer( server );
    });

    _.each( this.options.channels, ( channel: IIrcChannel ) => {
      this.addChannel( channel );
    });

    this.bot.on( 'registered::' + this.name , this.onRegistered.bind( this ) );

    this.bot.on( 'connect::'+ this.name, ( network: IRC, server: IrcServer ) => {
      this._connected = true;
    });

  }

  /**
  * Add a new IRC Server to servers array
  * @param <IServer> serve: The options for configuring the new server
  * @return <void>
  */
  public addServer( serve: IIrcServerOptions, callback?: Function ): void {
    var server = new IrcServer( this, serve );

    if ( this.serverExists( server.host ) ) {
      this.bot.emit( this.name + ' server exists', this, server );

      if ( callback )
        callback( new Error( 'network server hosts must be unique' ), server );

      return;
    }

    this.servers.push( server );

    if ( callback )
      callback( null, server );
  }

  /**
  * Does the server exist?
  * @param <string|Server> target: The host or Server to check for existence
  * @return <boolean>
  */
  public serverExists( host: IrcServer ): boolean;
  public serverExists( host: string ): boolean;
  public serverExists( host: any ): boolean {
    var instance = false;
    if ( host instanceof IrcServer )
      instance = true;

    return !( !_.find( this.servers, ( server )=> {
      return host === ( instance ? server : server.host );
    } ) );
  }

  /**
  * Add new channel to channels array
  * @param <IChannel> chan: The options for configuring a new channel
  * @return <void>
  */
  public addChannel( chan: IIrcChannel, callback?: Function ): void {
    var channel = new IrcChannel( this, chan );

    if ( this.channel[ channel.name ] ) {
      channel = this.channel[ channel.name ];

      this.bot.emit( 'channel exists', this, channel );
    }
    else {
      this.channel[ channel.name ] = channel;
    }

    if ( callback )
      callback( null, channel );
  }

  /**
  * Does this channel exist?
  * @param <String|IrcChannel> name: The name or Channel to check for existence
  * @return <boolean>
  */
  public channelExists( channel: IrcChannel ): boolean;
  public channelExists( name: string ): boolean;
  public channelExists( name: any ): boolean {
    var instance = false;

    if ( name instanceof IrcChannel )
      instance = true;

    return !( !_.find( this.channels, ( channel: IrcChannel )=> {
      return name === ( instance ? channel : channel.name );
    }));
  }

  /**
  * Are we in this channel?
  * @param <string> channel: The channel we may or may not be in
  * @return <boolean>
  */
  public inChannel( channel: string ): boolean {
    if ( this.channel[ channel ] )
      return this.channel[ channel ].inChannel();

    return false;
  }

  /**
  * Remove a server using a host
  * @param <String> host: The host to find and subsequently, remove
  * @return <void>
  */
  public removeServerByHost( host: string ): void {
    this.removeServer( _.find( this.servers, ( server )=> {
      return server.host === host;
    } ) );
  }

  /**
  * Remove a server from the servers array
  * @param <Server> server: The server to remove, assuming it exists
  * @return <void>
  */
  public removeServer( server: IrcServer ): void {
    if( this.servers.indexOf( server ) >= 0 ){

      this.servers.slice( this.servers.indexOf( server ), 1 );

      if( this.active_server == server ) {
        this.active_server = null;
        this.jump();
      }
    }
  }

  /**
  * Send a message to the server
  * @param <String> message: The message to send...
  * @return <void>
  */
  public send( message: string ): void {
    this.connection.send( message );
  }

  /**
  * Jump to the next available server
  * @return <void>
  */
  public jump(): void {
    if( this.connected() ) {
      this.disconnect( "jumping to next available server" );
    }

    this.connect();
  }

  public disconnect(): void;
  public disconnect( callback: Function ): void;
  public disconnect( message: string ): void;
  public disconnect( message: string, callback: Function ): void;
  public disconnect( message?: any, callback?: Function ): void {
    if ( typeof message === 'function' ) {
      callback = message;
      message = undefined;
    }

    if ( this.disconnected() ) {
        if ( callback )
          callback( null );
        return;
    }

    if ( !this.connection ) {
      this._connected = false;
      return;
    }

    this.connection.disconnect( message );

    if ( callback )
      callback( null );
  }

  /**
  * Connect to the IRC Server
  * @return <void>
  */
  public connect(): void {
    if ( !this.enabled() || this.connected() ) {
      if ( this.auto_disabled_timer )
        this.bot.Logger.info( 'network ' + this.name + ' has been autodisabled. ' + ( this.auto_disabled_timer.waitTime() / 1000 ).toString() + ' seconds left' );
      return;
    }
    if ( this.connection ) { this.connection.dispose(); }

    this.active_server =  this.next_server();

    if ( !this.active_server ) {
      this.bot.Logger.warn( 'unable to retrieve an active server for ' + this.name );
      return;
    }

    if ( !this.connection )
      this.connection = new IrcConnection( this, this.active_server );

    this.connection.connect();
  }


  /**
  * Generate a nickname from the main or alternate nicks
  * @param <String> nick: the nick to potentially modify
  * <> @default primary nick ( this.nick )
  * @param <boolean> force: Force the nick to alter if it has not changed
  * <> @default false
  * @return <String>
  */
  public generate_nick( nick: string = this.nick, force: boolean = false ): string {
    var newnick: string;

    var letters = nick.split('');

    while ( letters.indexOf( '?' ) >= 0 ) {
      letters[ letters.indexOf( '?' ) ] = String.fromCharCode( 97 + Math.floor( Math.random() * 26 ) );
    }

    newnick = letters.join( '' ).replace( /[^0-9a-zA-Z\-_.\/]/g, '' );

    if ( force && nick === newnick ) {
      if ( this.altnick && this.altnick.length && nick !== this.altnick ) {
        return this.generate_nick( this.altnick, true );
      }
      if ( newnick[ newnick.length-1 ] === "_" ) {
        return this.generate_nick( newnick + '?', true );
      }
      newnick = nick + "_";
    }

    return this.nick = newnick;
  }

  /**
  * Acquire the next server in the servers array
  * @param <number> index: optional index of server to utilize
  * @return <Server>
  * @api private
  */
  private next_server( index?: number ): IrcServer {
    var server: IrcServer;

    if( typeof index === "number" &&
             isFinite( index ) &&
             Math.floor( index ) === index
             && _.inRange( index, 0, this.servers.length ) ) {

      server = this.servers[ index ];

    } else {
      server = this.servers[ this._index ];
      this._index = ( this._index + 1 ) % this.servers.length || 0;
    }

    if ( server && server.disabled() ) {
      server = this.findEnabled();

      if ( !server ) {
        this.disable();
        this.auto_disable_times++;
        this.auto_disable_interval = this.auto_disable_interval * this.auto_disable_times || this.auto_disable_interval;

        this.bot.Logger.warn( 'no servers enabled, starting auto disabled timer for ' + Math.round( this.auto_disable_interval / 60 / 1000 ).toString() + ' minutes: ' + this.name );

        this.auto_disabled_timer = this.Timer(
          {
            autoStart: true,
            blocking: true,
            immediate: false,
            infinite: false,
            interval: this.auto_disable_interval,
            reference: 'auto disabled timer::'+ this.name,
          },
          this.disableCheck.bind( this )
        );
      }
    }

    return server;
  }

  /**
  * Check if servers are available after network is autodisabled
  * @param <Function> done: The function to call once the checking is complete
  * @api private
  */
    private disableCheck( done: Function ): void {
      this.bot.Logger.info( 'auto disabled timer invoked network server enabling: ' + this.name );

      this.enable();

      _.each( this.servers, ( server )=> {
        server.enable();
      });

      this.connect();

      done();

      this.auto_disabled_timer = null;
    }

  /**
  * Called when 'registered' is emitted
  * @param <AnyNet> network: The network that is now registered
  * @return <void>
  */
  private onRegistered( network: AnyNet ): void {
    this.auto_disable_times = 0;
    this.auto_disable_interval = 180000;

    this.connection_attempts = this.options.connection_attempts;
    // perform on registered events, but for now lets try to make the bot join a channel
    _.each( _.keys( this.channel ), ( name )=> {
      this.channel[ name ].join();
    });
  }

  /**
  * Find an enabled server
  * @return <Server|undefined>
  */
  private findEnabled(): IrcServer {
    return _.find( this.servers, ( server ) => {
      return server.enabled();
    });
  }

  /**
  * Default network options
  * @return <IIrcOptions>
  */
  private defaults(): IIrcOptions {
    return {
      connection_attempts: 10,
      encoding: 'utf8',
      enable: false,
      nick: 'kwirk',
      altnick: 'kw?rk',
      realname: "KwirK IRC Bot",
      user: 'KwirK',
      password: null,
      modes: [ 'i' ], // user modes, not channel modes
      owner: '',
      trigger: "!",
      quit_message: "KwirK, a sophisticated utility bot",
      reject_invalid_certs: false,
      sasl: null,
      servers: [],
      channels: [],
      name: null
    };
  }
}

export interface IIRC extends IRCOptions, INetwork {
  active_server: IrcServer;
  options: IIrcOptions;

  inChannel( channel: string ): boolean;
}

export interface IIrcOptions extends IRCOptions, INetOptions {}

interface IRCOptions extends INetworkOptions {
  altnick?: string;
  channels?: IrcChannel[];
  encoding?: string;
  modes?: string[];
  nick?: string;
  owner?: string;
  password?: string;
  quit_message?: string;
  realname?: string;
  reject_invalid_certs?: boolean;
  sasl?: ISasl;
  servers?: IrcServer[];
  trigger?: string;
  user?: string;
}
