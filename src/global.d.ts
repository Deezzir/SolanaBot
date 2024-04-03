import { Connection, PublicKey } from '@solana/web3.js';
import { BotConfig, WorkerPromise } from './common.js';
import type { Interface } from 'readline';

declare global {
    var keysDir: string;
    var workerPath: string;
    var featchMintApiURL: string;
    var rl: Interface;

    var connection: Connection;
    var programID: PublicKey;
    var metaplexProgramID: PublicKey;
    var subscriptionID: number | undefined;
}

export { };