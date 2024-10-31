import { Connection, PublicKey } from '@solana/web3.js';
import { Moonshot } from '@wen-moon-ser/moonshot-sdk';
import { BotConfig, WorkerJob } from './common.js';
import type { Interface } from 'readline';
import { Solana } from '@quicknode/sdk';
import { Helius } from 'helius-sdk';

declare global {
    var RL: Interface;
    var CONNECTION: Connection;
    var HELIUS_CONNECTION: Helius;
    var MOONSHOT: Moonshot;
}

export { };
