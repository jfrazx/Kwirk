
import { AnyNet } from '../netfactory';

export class Channel implements IChannel {

  protected _in_channel: boolean = false;

  constructor( public network: AnyNet, public name: string ) {

    if ( !this.name || !this.name.trim().length )
      throw new Error( 'you must supply a channel name' );
  }

  public toString(): string {
    return this.name;
  }
}

export interface IChannel extends IChannelOptions {
  network: AnyNet;
  toString(): string;
}

export interface IChannelOptions {
  name: string;
}