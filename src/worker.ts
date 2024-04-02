import { parentPort, workerData } from 'worker_threads'
import * as web3 from '@solana/web3.js';
import type { WorkerConfig } from './types.ts';

const config = workerData as WorkerConfig;
const keypair = web3.Keypair.fromSecretKey(config.secret);
console.log(`Worker ${workerData.id} started, adress: ${keypair.publicKey.toString()}`);

parentPort?.once('message', async (msg) => {
    if (msg.command === 'buy') {
        console.log(`Worker ${workerData.id} started buying the token with mint: ${msg.mint}`);
        setTimeout(() => {
            parentPort?.postMessage(`Worker ${workerData.id} completed its task.`);
            process.exit(0);
        }, 1000000);
    }
    if (msg.command === 'stop') {
        console.log(`Worker ${workerData.id} started selling the token with mint: ${msg.mint}`);
        process.exit(0);
    }
});
