import { parentPort, workerData } from 'worker_threads';
import { Keypair, LAMPORTS_PER_SOL, Connection, PublicKey, TokenAmount } from '@solana/web3.js';
import * as common from './common.js';
import * as trade from './trade.js';
import { Helius } from 'helius-sdk';

const SLIPPAGE = 0.50;
const MIN_BUY_THRESHOLD = 0.00001;
const MIN_BALANCE_THRESHOLD = 0.01;
const MIN_BUY = 0.005;
const MAX_RETRIES = 5;
const TRADE_ITERATIONS = 1;

const WORKER_CONF: common.WorkerConfig = workerData as common.WorkerConfig;
const WORKER_KEYPAIR: Keypair = Keypair.fromSecretKey(new Uint8Array(WORKER_CONF.secret));
const IS_BUMP: boolean = WORKER_CONF.inputs.is_bump;
const RPC = process.env.RPC || '';
global.CONNECTION = new Connection(RPC, 'confirmed');
global.HELIUS_CONNECTION = new Helius(process.env.HELIUS_API_KEY || '');

var MINT_METADATA: common.TokenMeta;
var IS_DONE = false;
var CURRENT_SPENDINGS = 0;
var CURRENT_BUY_AMOUNT = 0;
var START_SELL = false;
var CANCEL_SLEEP: (() => void) | null = null;
var MESSAGE_BUFFER: string[] = [];

function control_sleep(seconds: number): { promise: Promise<void>, cancel: () => void } {
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
    } catch (error: any) {
        // parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Error buying the token (${e}), retrying...`);
        if (error instanceof Error && error.message.includes('Simulation failed')) {
            await common.sleep(0.5 * 1000);
            MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Simulation failed, retrying...`);
            return false;
        }
        MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Failed to buy the token (${error}), retrying...`);
        return false;
    }
}

const buy = async () => {
    MESSAGE_BUFFER.push(`[Worker ${workerData.id}] Buying the token...`);

    const amount = parseFloat((CURRENT_BUY_AMOUNT > 0 ? CURRENT_BUY_AMOUNT : MIN_BUY).toFixed(5));
    parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Buying ${amount} SOL of the token '${MINT_METADATA.symbol}'`);
    let bought = false;

    while (!IS_DONE && !bought) {
        let transactions = [];
        let count = TRADE_ITERATIONS;
        while (count > 0) {
            if (MINT_METADATA.raydium_pool === null) {
                const buy_promise = trade.buy_token(amount, WORKER_KEYPAIR, MINT_METADATA, SLIPPAGE, common.PriorityLevel.HIGH)
                transactions.push(
                    process_buy_tx(buy_promise, amount).then(result => {
                        if (result) bought = true;
                    })
                );
            } else {
                const amm = new PublicKey(MINT_METADATA.raydium_pool);
                const mint = new PublicKey(MINT_METADATA.mint);
                const sol_amount = trade.get_sol_token_amount(amount);
                const buy_promise = trade.swap_raydium(sol_amount, WORKER_KEYPAIR, amm, mint, SLIPPAGE, common.PriorityLevel.HIGH)
                transactions.push(
                    process_buy_tx(buy_promise, amount).then(result => {
                        if (result) bought = true;
                    })
                );
            }
            count--;
            await common.sleep(1 * 1000);
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
        MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Error selling the token, ${e} retrying...`);
        return false;
    }
}

const sell = async () => {
    MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Started selling the token`);
    let sold = false;
    while (!sold) {
        try {
            let get_balance_retry = 0;
            let balance: TokenAmount | undefined = undefined;

            while (get_balance_retry < MAX_RETRIES) {
                balance = await trade.get_token_balance(WORKER_KEYPAIR.publicKey, new PublicKey(MINT_METADATA.mint));
                if (balance.uiAmount !== null && balance.uiAmount !== 0) break;
                get_balance_retry++;
                if (get_balance_retry < MAX_RETRIES) MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Retrying to get the balance...`);
                if (get_balance_retry === MAX_RETRIES) {
                    MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] No tokens to sell, exiting...`);
                    sold = true;
                }
                await common.sleep(5 * 1000);
            }

            if (sold) break;

            let transactions = [];
            let count = TRADE_ITERATIONS;

            while (count > 0 && balance !== undefined) {
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
                await common.sleep(1 * 1000);
            }
            await Promise.allSettled(transactions);
        } catch (e) {
            MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Error getting the balance, retrying...`);
        }
    }
}

const control_loop = async () => new Promise<void>(async (resolve) => {
    const should_sell = () => MINT_METADATA.usd_market_cap >= WORKER_CONF.inputs.mcap_threshold;
    const should_buy = () => CURRENT_SPENDINGS < WORKER_CONF.inputs.spend_limit && CURRENT_BUY_AMOUNT > MIN_BUY_THRESHOLD;
    const process = async () => {
        if (should_sell()) {
            MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Market cap threshold reached, starting to sell...`);
            START_SELL = true;
            return true;
        }

        if (should_buy()) {
            await buy();
            if (WORKER_CONF.inputs.is_buy_once) CURRENT_SPENDINGS = WORKER_CONF.inputs.spend_limit;
        } else {
            MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Spend limit reached...`);
        }

        if (IS_BUMP) {
            await common.sleep(2 * 1000);
            await sell();
        }

        return false;
    };

    while (!IS_DONE) {
        if (MINT_METADATA && Object.keys(MINT_METADATA).length !== 0) {
            if (await process()) break;
        } else {
            MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Mint metadata not available`);
        }

        const sleep_for = common.normal_random(WORKER_CONF.inputs.buy_interval, 0.5 * WORKER_CONF.inputs.buy_interval);
        MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Sleeping for ${sleep_for.toFixed(2)} seconds`);
        parentPort?.postMessage(MESSAGE_BUFFER.join('\n'));

        if (!IS_DONE) {
            const { promise, cancel } = control_sleep(sleep_for);
            CANCEL_SLEEP = cancel;
            await promise;
        }
        MESSAGE_BUFFER = [];
    }

    if (START_SELL) await sell();

    parentPort?.postMessage(MESSAGE_BUFFER.join('\n'));
    resolve();
});

async function main() {
    const balance = await trade.get_balance(WORKER_KEYPAIR.publicKey) / LAMPORTS_PER_SOL;
    const adjusted_spend_limit = Math.min(balance, WORKER_CONF.inputs.spend_limit) - MIN_BALANCE_THRESHOLD;
    WORKER_CONF.inputs.spend_limit = adjusted_spend_limit;

    parentPort?.postMessage({ command: "started", data: `[Worker ${WORKER_CONF.id}] Started with Public Key: ${WORKER_KEYPAIR.publicKey.toString()}` });

    parentPort?.on('message', async (msg) => {
        switch (msg.command) {
            case `buy${WORKER_CONF.id}`:
                const std = WORKER_CONF.inputs.start_buy * 0.05;
                CURRENT_BUY_AMOUNT = common.normal_random(WORKER_CONF.inputs.start_buy, std);

                if (CURRENT_BUY_AMOUNT > WORKER_CONF.inputs.spend_limit) CURRENT_BUY_AMOUNT = WORKER_CONF.inputs.spend_limit;
                if (CURRENT_BUY_AMOUNT < MIN_BUY) CURRENT_BUY_AMOUNT = MIN_BUY;
                if (IS_BUMP) CURRENT_BUY_AMOUNT = MIN_BUY;

                await control_loop();

                parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Finished`);
                process.exit(0)
            case 'sell':
                if (!START_SELL) {
                    parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Received sell command from the main thread`);
                    if (CANCEL_SLEEP !== null) CANCEL_SLEEP();
                    IS_DONE = true;
                    START_SELL = true;
                }
                break;
            case 'collect':
                if (!IS_DONE) {
                    parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Received collect command from the main thread`);
                    IS_DONE = true;
                    if (CANCEL_SLEEP !== null) CANCEL_SLEEP();
                }
                break;
            case 'stop':
                if (!IS_DONE) {
                    parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Stopped by the main thread`);
                    IS_DONE = true;
                    if (CANCEL_SLEEP !== null) CANCEL_SLEEP();
                }
                break;
            case 'mint':
                MINT_METADATA = msg.data;
                break;
            default:
                parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Unknown command from the main thread: ${msg.command}`);
                break;
        }
    });
}

main().catch(err => { throw err });