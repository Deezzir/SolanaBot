import { parentPort, workerData } from 'worker_threads'
import * as web3 from '@solana/web3.js';
import * as common from './common.js';

const config = workerData as common.WorkerConfig;
const keypair = web3.Keypair.fromSecretKey(config.secret);
parentPort?.postMessage(`[Worker ${workerData.id}] Started, adress: ${keypair.publicKey.toString()}`);

parentPort?.on('message', async (msg) => {
    if (msg.command === 'buy') {
        parentPort?.postMessage(`[Worker ${workerData.id}] Started buying the token with mint: ${msg.mint}`);
        setTimeout(() => {
            parentPort?.postMessage(`[Worker ${workerData.id}] Finished`);
            process.exit(0);
        }, 3000);
    }
    if (msg.command === 'stop') {
        parentPort?.postMessage(`[Worker ${workerData.id}] Started selling the token with mint: ${msg.mint}`);
        process.exit(0);
    }
});
