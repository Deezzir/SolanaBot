import { parentPort, workerData } from 'worker_threads';
import { Keypair, LAMPORTS_PER_SOL, Connection } from '@solana/web3.js';
import * as common from './common.js';

global.connection = new Connection(process.env.RPC || '', 'confirmed');
const config = workerData as common.WorkerConfig;
let mint_meta: common.TokenMeta;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    parentPort?.postMessage(`[Worker ${workerData.id}] Started...`);

    const keypair = Keypair.fromSecretKey(new Uint8Array(config.secret));
    const balance = await common.get_balance(keypair.publicKey);
    let spend_limit = config.inputs.spend_limit * LAMPORTS_PER_SOL;

    if (balance < spend_limit)
        spend_limit = balance;

    parentPort?.on('message', async (msg) => {
        if (msg.command === 'buy') {
            parentPort?.postMessage(`[Worker ${workerData.id}] Started buying the token`);
            await delay(1000000);
            parentPort?.postMessage(`[Worker ${workerData.id}] Finished`);
            process.exit(0);
        }
        if (msg.command === 'sell') {
            parentPort?.postMessage(`[Worker ${workerData.id}] Started selling the token`);
            process.exit(0);
        }
        if (msg.command === 'collect') {
            parentPort?.postMessage(`[Worker ${workerData.id}] Started collecting the token`);
            process.exit(0);
        }
        if (msg.command === 'stop') {
            parentPort?.postMessage(`[Worker ${workerData.id}] Stopped by the main thread`);
            process.exit(0);
        }
        if (msg.command === 'mint') {
            parentPort?.postMessage(`[Worker ${workerData.id}] Updated mint metadata`);
            mint_meta = msg.data;
        }
    });
}

main().catch(err => { throw err });