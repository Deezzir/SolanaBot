import { Connection, PublicKey } from '@solana/web3.js';
import { BotConfig, WorkerPromise } from './common.js';
import type { Interface } from 'readline';

declare global {
    var rl: Interface;
    var connection: Connection;
    var START_COLLECT: boolean;
}

export { };