import { parentPort, workerData } from 'worker_threads';
import * as web3 from '@solana/web3.js';
import * as common from './common.js';

const config = workerData as common.WorkerConfig;
let mint_meta: common.MintMeta;
const keypair = web3.Keypair.fromSecretKey(new Uint8Array(config.secret));
parentPort?.postMessage(`[Worker ${workerData.id}] Started...`);

// A function to simulate a non-blocking delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

parentPort?.on('message', async (msg) => {
    if (msg.command === 'buy') {
        parentPort?.postMessage(`[Worker ${workerData.id}] Started buying the token`);
        await delay(1000000);
        parentPort?.postMessage(`[Worker ${workerData.id}] Finished`);
        process.exit(0);
    }
    if (msg.command === 'stop') {
        parentPort?.postMessage(`[Worker ${workerData.id}] Started selling the token`);
        process.exit(0);
    }
    if (msg.command === 'mint') {
        parentPort?.postMessage(`[Worker ${workerData.id}] Updated mint metadata`);
        mint_meta = msg.data;
    }
});
