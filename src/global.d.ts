import { Connection, PublicKey } from '@solana/web3.js';
import { BotConfig, WorkerJob } from './common.js';
import type { Interface } from 'readline';
import { Solana } from "@quicknode/sdk";
import { Helius } from 'helius-sdk';

declare global {
    var RL: Interface;
    var CONNECTION: Connection;
    var HELIUS_CONNECTION: Helius;
    var START_COLLECT: boolean;
}

export { };