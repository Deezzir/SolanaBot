import { parentPort, workerData } from 'worker_threads';
import { Keypair, LAMPORTS_PER_SOL, Connection } from '@solana/web3.js';
import * as common from './common.js';
import * as trade from './trade.js';

const SLIPPAGE = 0.3;

global.connection = new Connection(process.env.RPC || '', 'confirmed');
const config = workerData as common.WorkerConfig;

var keypair: Keypair;
var mint_meta: common.TokenMeta;
var finished = false;
var spent = 0;
var start_sell = false;

function sleep(seconds: number) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

const sell = async () => {
    parentPort?.postMessage(`[Worker ${workerData.id}] Started buying the token`);
    const balance = await trade.get_token_balance(keypair.publicKey, config.inputs.mint);
    if (balance.uiAmount === 0 || balance.uiAmount === null) {
        parentPort?.postMessage(`[Worker ${workerData.id}] No tokens to sell`);
        return;
    }
    let signature: String;
    if (mint_meta.raydium_pool === null) {
        signature = await trade.sell_token(balance.uiAmount, keypair, mint_meta, SLIPPAGE, true);
    } else {
        signature = "";
        // signature = swap_raydium(amount: number, seller: Signer, mint_from: PublicKey, mint_to: PublicKey, slippage: number = 0.05, priority: boolean = false)
    }
    parentPort?.postMessage(`[Worker ${workerData.id}] Sold ${balance.uiAmount} tokens. Signature: ${signature}`);
}

const control_loop = async () => new Promise(async (resolve) => {
    while (!finished) {
        if (mint_meta !== undefined || mint_meta !== null) {
            if (config.inputs.mcap_threshold >= mint_meta.usd_market_cap) {
                parentPort?.postMessage(`[Worker ${workerData.id}] Market cap threshold reached, starting to sell...`);
                start_sell = true;
                break;
            }
            if (spent < config.inputs.spend_limit * LAMPORTS_PER_SOL) {
                parentPort?.postMessage(`[Worker ${workerData.id}] Buying...`);
            }
        } else {
            parentPort?.postMessage(`[Worker ${workerData.id}] Mint metadata not available`);
        }

        const sleep_for = common.normal_random(config.inputs.buy_interval, 5);
        parentPort?.postMessage(`[Worker ${workerData.id}] Sleeping for ${sleep_for.toFixed(0)} seconds`);
        await sleep(sleep_for);
    }
    if (start_sell)
        await sell();
    resolve(0);
});

async function main() {
    parentPort?.postMessage(`[Worker ${workerData.id}] Started...`);

    keypair = Keypair.fromSecretKey(new Uint8Array(config.secret));
    const balance = await trade.get_balance(keypair.publicKey);
    let spend_limit = config.inputs.spend_limit * LAMPORTS_PER_SOL;

    if (balance < spend_limit)
        spend_limit = balance;

    parentPort?.on('message', async (msg) => {
        if (msg.command === 'buy') {
            parentPort?.postMessage(`[Worker ${workerData.id}] Started buying the token`);
            await control_loop();
            parentPort?.postMessage(`[Worker ${workerData.id}] Finished`);
            process.exit(0);
        }
        if (msg.command === 'sell') {
            parentPort?.postMessage(`[Worker ${workerData.id}] Received sell command from the main thread`);
            finished = true;
            start_sell = true;
        }
        if (msg.command === 'collect') {
            parentPort?.postMessage(`[Worker ${workerData.id}] Received collect command from the main thread`);
            finished = true;
        }
        if (msg.command === 'stop') {
            parentPort?.postMessage(`[Worker ${workerData.id}] Stopped by the main thread`);
            finished = true;
        }
        if (msg.command === 'mint') {
            // parentPort?.postMessage(`[Worker ${workerData.id}] Updated mint metadata`);
            mint_meta = msg.data;
        }
    });
}

main().catch(err => { throw err });