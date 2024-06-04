import { parentPort, workerData } from 'worker_threads';
import { Keypair, LAMPORTS_PER_SOL, Connection, PublicKey } from '@solana/web3.js';
import * as common from './common.js';
import * as trade from './trade.js';

const SLIPPAGE = 1.5;
const MIN_BUY_THRESHOLD = 0.00001;
const MIN_BALANCE_THRESHOLD = 0.01;
const MIN_BUY = 0.05;
const TRADE_ITERATIONS = 1;
let JITOTIP = 0.1;

const WORKER_CONFIG = workerData as common.WorkerConfig;
const RPCS = process.env.RPCS?.split(',') || [];
global.connection = new Connection(RPCS[WORKER_CONFIG.id % RPCS?.length], 'confirmed');


var WORKER_KEYPAIR: Keypair;
var MINT_METADATA: common.TokenMeta;
var IS_DONE = false;
var CURRENT_SPENDINGS = 0;
var CURRENT_BUY_AMOUNT = 0;
var START_SELL = false;
var CANCEL_SLEEP: (() => void) | null = null;
var MESSAGE_BUFFER: string[] = [];

function sleep(seconds: number): { promise: Promise<void>, cancel: () => void } {
    let timeout_id: NodeJS.Timeout;
    let cancel: () => void = () => { };

    const promise = new Promise<void>(resolve => {
        timeout_id = setTimeout(resolve, seconds * 1000);
        cancel = () => {
            clearTimeout(timeout_id);
            resolve();
        };
    });

    return { promise, cancel };
}

const buy = async () => {
    MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Buying the token...`);
    const amount = CURRENT_BUY_AMOUNT > 0 ? CURRENT_BUY_AMOUNT : MIN_BUY; // parseFloat(common.normal_random(CURRENT_BUY_AMOUNT, 0.02).toFixed(2));
    parentPort?.postMessage(`[Worker ${workerData.id}] Buying ${amount} SOL of the token '${MINT_METADATA.symbol}'`);
    let bought: boolean = false;

    while (!IS_DONE && !bought) {
        try {

            let transactions = [];
            let count = TRADE_ITERATIONS;
            let lastValidHeight = 0;

            while (count > 0) {
                const context = await connection.getLatestBlockhashAndContext('finalized');
                const last = context.value.lastValidBlockHeight;

                if (lastValidHeight !== last) {
                    lastValidHeight = last;
                } else {
                    await common.sleep(500);
                    continue;
                }

                transactions.push(trade.buy_token(amount, WORKER_KEYPAIR, MINT_METADATA, context, JITOTIP, SLIPPAGE, true)
                    .then(async (sig) => {
                        try {
                            const balance_change = await trade.get_balance_change(sig.toString(), WORKER_KEYPAIR.publicKey);
                            CURRENT_SPENDINGS += balance_change;
                        } catch (error) {
                            MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Error getting balance change, retrying...`);
                        }
                        bought = true;
                        MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Bought ${amount} SOL of the token '${MINT_METADATA.symbol}'. Signature: ${sig}`);
                    })
                    .catch((e) => {
                        //parentPort?.postMessage(`[Worker ${workerData.id}] Error buying the token (${e}), retrying...`);
                        MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Error buying the token (${e}), retrying...`);
                    }));

                count--;
            }
            await Promise.allSettled(transactions);

            CURRENT_BUY_AMOUNT = (WORKER_CONFIG.inputs.spend_limit - CURRENT_SPENDINGS) * 0.95;
        } catch (e) {
            MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Error buying the token (${e}), retrying...`);
        }
    }
}

const sell = async () => {
    MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Started selling the token`);
    let sold: boolean = false;
    while (!sold) {
        try {
            const balance = await trade.get_token_balance(WORKER_KEYPAIR.publicKey, new PublicKey(MINT_METADATA.mint));
            if (balance.uiAmount === 0 || balance.uiAmount === null) {
                MESSAGE_BUFFER.push(`[Worker ${workerData.id}] No tokens to sell`);
                break;
            }

            let transactions = [];
            let count = TRADE_ITERATIONS;
            let lastValidHeight = 0;

            while (count > 0) {
                const context = await connection.getLatestBlockhashAndContext('finalized');
                const last = context.value.lastValidBlockHeight;

                if (lastValidHeight !== last) {
                    lastValidHeight = last;
                } else {
                    await common.sleep(500);
                    continue;
                }

                if (MINT_METADATA.raydium_pool === null) {
                    transactions.push(trade.sell_token(balance, WORKER_KEYPAIR, MINT_METADATA, context, JITOTIP, SLIPPAGE, true)
                        .then((sig) => {
                            sold = true;
                            const ui_amount = balance.uiAmount ? balance.uiAmount.toFixed(2) : 0;
                            MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Sold ${ui_amount} tokens. Signature: ${sig}`);
                        })
                        .catch((e) => {
                            MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Error selling the token, retrying...`);
                        }));
                } else {
                    const amm = new PublicKey(MINT_METADATA.raydium_pool);
                    transactions.push(trade.swap_raydium(balance, WORKER_KEYPAIR, amm, trade.SOL_MINT, context, SLIPPAGE, true)
                        .then((sig) => {
                            sold = true;
                            const ui_amount = balance.uiAmount ? balance.uiAmount.toFixed(2) : 0;
                            MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Sold ${ui_amount} tokens. Signature: ${sig}`);
                        })
                        .catch((e) => {
                            MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Error selling the token, retrying...`);
                        }));
                }

                count--;
            }
            await Promise.allSettled(transactions);
        } catch (e) {
            MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Error getting the balance, retrying...`);
        }
    }
}

const control_loop = async () => new Promise<void>(async (resolve) => {
    while (!IS_DONE) {
        if (MINT_METADATA !== undefined && MINT_METADATA !== null && Object.keys(MINT_METADATA).length !== 0) {
            if (WORKER_CONFIG.inputs.mcap_threshold <= MINT_METADATA.usd_market_cap) {
                MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Market cap threshold reached, starting to sell...`);
                START_SELL = true;
                break;
            }
            // if (MINT_METADATA.usd_market_cap >= 45000) {
            //     CURRENT_BUY_AMOUNT = MIN_BUY;
            //     JITOTIP = 0.05;
            // }
            if (MINT_METADATA.raydium_pool !== null) {
                MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Raydium pool detected, skipping...`);
                continue;
            }
            if (CURRENT_SPENDINGS < WORKER_CONFIG.inputs.spend_limit && CURRENT_BUY_AMOUNT > MIN_BUY_THRESHOLD) {
                await buy();
            } else {
                MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Spend limit reached...`);
            }
        } else {
            MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Mint metadata not available`);
        }

        const sleep_for = common.normal_random(WORKER_CONFIG.inputs.buy_interval, 5);
        MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Sleeping for ${sleep_for.toFixed(2)} seconds`);
        parentPort?.postMessage(MESSAGE_BUFFER.join('\n'));
        if (!IS_DONE) {
            const { promise, cancel } = sleep(sleep_for);
            CANCEL_SLEEP = cancel;
            await promise;
        }
        MESSAGE_BUFFER = [];
    }
    if (START_SELL)
        await sell();
    parentPort?.postMessage(MESSAGE_BUFFER.join('\n'));
    resolve();
});

async function main() {
    WORKER_KEYPAIR = Keypair.fromSecretKey(new Uint8Array(WORKER_CONFIG.secret));
    const balance = await trade.get_balance(WORKER_KEYPAIR.publicKey);
    let spend_limit = WORKER_CONFIG.inputs.spend_limit * LAMPORTS_PER_SOL;

    if (balance < spend_limit)
        spend_limit = balance;

    spend_limit -= MIN_BALANCE_THRESHOLD * LAMPORTS_PER_SOL;
    WORKER_CONFIG.inputs.spend_limit = spend_limit / LAMPORTS_PER_SOL;

    parentPort?.postMessage(`[Worker ${workerData.id}] Started with Public Key: ${WORKER_KEYPAIR.publicKey.toString()}`);

    parentPort?.on('message', async (msg) => {
        if (msg.command === 'buy') {
            const std = WORKER_CONFIG.inputs.start_buy * 0.05;
            CURRENT_BUY_AMOUNT = parseFloat(common.normal_random(WORKER_CONFIG.inputs.start_buy, std).toFixed(5));
            if (CURRENT_BUY_AMOUNT > WORKER_CONFIG.inputs.spend_limit) CURRENT_BUY_AMOUNT = WORKER_CONFIG.inputs.spend_limit;
            if (CURRENT_BUY_AMOUNT < MIN_BUY) CURRENT_BUY_AMOUNT = MIN_BUY;
            await control_loop();
            parentPort?.postMessage(`[Worker ${workerData.id}] Finished`);
            process.exit(0);
        }
        if (msg.command === 'sell') {
            if (!START_SELL) {
                parentPort?.postMessage(`[Worker ${workerData.id}] Received sell command from the main thread`);
                if (CANCEL_SLEEP !== null) CANCEL_SLEEP();
                IS_DONE = true;
                START_SELL = true;
            }
        }
        if (msg.command === 'collect') {
            if (!IS_DONE) {
                parentPort?.postMessage(`[Worker ${workerData.id}] Received collect command from the main thread`);
                IS_DONE = true;
                if (CANCEL_SLEEP !== null) CANCEL_SLEEP();
            }
        }
        if (msg.command === 'stop') {
            if (!IS_DONE) {
                parentPort?.postMessage(`[Worker ${workerData.id}] Stopped by the main thread`);
                IS_DONE = true;
                if (CANCEL_SLEEP !== null) CANCEL_SLEEP();
            }
        }
        if (msg.command === 'mint') {
            MINT_METADATA = msg.data;
        }
    });
}

main().catch(err => { throw err });