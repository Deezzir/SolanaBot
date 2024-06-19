import { parentPort, workerData } from 'worker_threads';
import { Keypair, LAMPORTS_PER_SOL, Connection, PublicKey, TokenAmount } from '@solana/web3.js';
import * as common from './common.js';
import * as trade from './trade.js';
import { Helius } from 'helius-sdk';

const SLIPPAGE = 0.25;
const MIN_BUY_THRESHOLD = 0.00001;
const MIN_BALANCE_THRESHOLD = 0.01;
const MIN_BUY = 0.05;
let JITOTIP = 0.1;

const WORKER_CONF = workerData as common.WorkerConfig;
const RPC = process.env.RPC || '';
global.connection = new Connection(RPC, 'confirmed');
global.helius_connection = new Helius(process.env.HELIUS_API_KEY || '');

var TRADE_ITERATIONS = 3;
var WORKER_KEYPAIR: Keypair;
var MINT_METADATA: common.TokenMeta;
var IS_DONE = false;
var CURRENT_SPENDINGS = 0;
var CURRENT_BUY_AMOUNT = 0;
var START_SELL = false;
var CANCEL_SLEEP: (() => void) | null = null;
var MESSAGE_BUFFER: string[] = [];
var IS_BUMP = false;

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

async function process_buy_tx(promise: Promise<String>, amount: number) {
    try {
        const sig = await promise;
        try {
            const balance_change = await trade.get_balance_change(sig.toString(), WORKER_KEYPAIR.publicKey);
            CURRENT_SPENDINGS += balance_change;
        } catch (error) {
            MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Error getting balance change, continuing...`);
        }
        MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Bought ${amount} SOL of the token '${MINT_METADATA.symbol}'. Signature: ${sig}`);
        return true;
    } catch (error) {
        // parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Error buying the token (${e}), retrying...`);
        MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Failed to buy the token (${error}), retrying...`);
        return false;
    }
}

const buy = async () => {
    MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Buying the token...`);
    const amount = CURRENT_BUY_AMOUNT > 0 ? CURRENT_BUY_AMOUNT : MIN_BUY; // parseFloat(common.normal_random(CURRENT_BUY_AMOUNT, 0.02).toFixed(2));
    parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Buying ${amount} SOL of the token '${MINT_METADATA.symbol}'`);
    let bought: boolean = false;

    while (!IS_DONE && !bought) {
        let transactions = [];
        let count = TRADE_ITERATIONS;
        while (count > 0) {
            const buy_promise = trade.buy_token(amount, WORKER_KEYPAIR, MINT_METADATA, SLIPPAGE, common.PriorityLevel.HIGH)
            transactions.push(
                process_buy_tx(buy_promise, amount).then(result => {
                    if (result) bought = true;
                })
            );
            count--;
            await sleep(0.5).promise;
        }
        await Promise.allSettled(transactions);

        if (IS_BUMP) {
            CURRENT_SPENDINGS -= amount;
            CURRENT_BUY_AMOUNT = MIN_BUY;
        } else {
            CURRENT_BUY_AMOUNT = (WORKER_CONF.inputs.spend_limit - CURRENT_SPENDINGS) * 0.95;
        }
    }
}

async function process_sell_tx(promise: Promise<String>, balance: TokenAmount) {
    try {
        const sig = await promise;
        const ui_amount = balance.uiAmount ? balance.uiAmount.toFixed(2) : 0;
        MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Sold ${ui_amount} tokens. Signature: ${sig}`);
        return true;
    } catch (e) {
        MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Error selling the token, retrying...`);
        return false;
    }
}

const sell = async () => {
    MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Started selling the token`);
    let sold: boolean = false;
    while (!sold) {
        try {
            const balance = await trade.get_token_balance(WORKER_KEYPAIR.publicKey, new PublicKey(MINT_METADATA.mint));
            if (balance.uiAmount === 0 || balance.uiAmount === null) {
                MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] No tokens to sell`);
                break;
            }

            let transactions = [];
            let count = TRADE_ITERATIONS;

            while (count > 0) {
                if (MINT_METADATA.raydium_pool === null) {
                    const sell_promise = trade.sell_token(balance, WORKER_KEYPAIR, MINT_METADATA, SLIPPAGE, common.PriorityLevel.HIGH)
                    transactions.push(
                        process_sell_tx(sell_promise, balance).then(result => {
                            if (result) sold = true;
                        })
                    );
                } else {
                    const amm = new PublicKey(MINT_METADATA.raydium_pool);
                    const sell_promise = trade.swap_raydium(balance, WORKER_KEYPAIR, amm, trade.SOL_MINT, SLIPPAGE, common.PriorityLevel.HIGH)
                    transactions.push(
                        process_sell_tx(sell_promise, balance).then(result => {
                            if (result) sold = true;
                        })
                    );
                }
                count--;
                await sleep(0.5).promise;
            }
            await Promise.allSettled(transactions);
        } catch (e) {
            MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Error getting the balance, retrying...`);
        }
    }
}

const control_loop = async () => new Promise<void>(async (resolve) => {
    while (!IS_DONE) {
        if (MINT_METADATA !== undefined && MINT_METADATA !== null && Object.keys(MINT_METADATA).length !== 0) {
            if (WORKER_CONF.inputs.mcap_threshold <= MINT_METADATA.usd_market_cap) {
                MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Market cap threshold reached, starting to sell...`);
                START_SELL = true;
                break;
            }
            // if (MINT_METADATA.usd_market_cap >= 45000) {
            //     CURRENT_BUY_AMOUNT = MIN_BUY;
            //     JITOTIP = 0.05;
            // }
            if (MINT_METADATA.raydium_pool !== null) {
                MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Raydium pool detected, skipping...`);
                continue;
            }
            if (CURRENT_SPENDINGS < WORKER_CONF.inputs.spend_limit && CURRENT_BUY_AMOUNT > MIN_BUY_THRESHOLD) {
                await buy();
            } else {
                MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Spend limit reached...`);
            }

            if (IS_BUMP) {
                const { promise, cancel } = sleep(5);
                CANCEL_SLEEP = cancel;
                await promise;
                await sell();
            }
        } else {
            MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Mint metadata not available`);
        }

        const sleep_for = common.normal_random(WORKER_CONF.inputs.buy_interval, 5);
        MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Sleeping for ${sleep_for.toFixed(2)} seconds`);
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
    WORKER_KEYPAIR = Keypair.fromSecretKey(new Uint8Array(WORKER_CONF.secret));
    const balance = await trade.get_balance(WORKER_KEYPAIR.publicKey);
    let spend_limit = WORKER_CONF.inputs.spend_limit * LAMPORTS_PER_SOL;

    if (balance < spend_limit)
        spend_limit = balance;

    spend_limit -= MIN_BALANCE_THRESHOLD * LAMPORTS_PER_SOL;
    WORKER_CONF.inputs.spend_limit = spend_limit / LAMPORTS_PER_SOL;

    IS_BUMP = WORKER_CONF.inputs.is_bump;
    TRADE_ITERATIONS = IS_BUMP ? 1 : TRADE_ITERATIONS;

    parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Started with Public Key: ${WORKER_KEYPAIR.publicKey.toString()}`);

    parentPort?.on('message', async (msg) => {
        if (msg.command === 'buy') {
            const std = WORKER_CONF.inputs.start_buy * 0.05;
            CURRENT_BUY_AMOUNT = parseFloat(common.normal_random(WORKER_CONF.inputs.start_buy, std).toFixed(5));
            if (CURRENT_BUY_AMOUNT > WORKER_CONF.inputs.spend_limit) CURRENT_BUY_AMOUNT = WORKER_CONF.inputs.spend_limit;
            if (CURRENT_BUY_AMOUNT < MIN_BUY) CURRENT_BUY_AMOUNT = MIN_BUY;
            if (IS_BUMP) CURRENT_BUY_AMOUNT = MIN_BUY;
            await control_loop();
            parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Finished`);
            process.exit(0);
        }
        if (msg.command === 'sell') {
            if (!START_SELL) {
                parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Received sell command from the main thread`);
                if (CANCEL_SLEEP !== null) CANCEL_SLEEP();
                IS_DONE = true;
                START_SELL = true;
            }
        }
        if (msg.command === 'collect') {
            if (!IS_DONE) {
                parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Received collect command from the main thread`);
                IS_DONE = true;
                if (CANCEL_SLEEP !== null) CANCEL_SLEEP();
            }
        }
        if (msg.command === 'stop') {
            if (!IS_DONE) {
                parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Stopped by the main thread`);
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