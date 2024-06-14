import { Connection, PublicKey } from '@solana/web3.js';
import { BotConfig, WorkerPromise } from './common.js';
import type { Interface } from 'readline';
import { Solana } from "@quicknode/sdk";
import { Helius } from 'helius-sdk';

declare global {
    var rl: Interface;
    var connection: Connection;
    var helius_connection: Helius;
    var START_COLLECT: boolean;
}

export { };