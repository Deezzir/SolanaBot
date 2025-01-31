import { parentPort, workerData } from 'worker_threads';
import { Keypair, LAMPORTS_PER_SOL, Connection, PublicKey, TokenAmount } from '@solana/web3.js';
import * as common from '../common/common.js';
import * as snipe from '../common/snipe_common.js';
import * as trade from '../common/trade_common.js';
import * as pump from './trade_pump.js';
import { Helius } from 'helius-sdk';

const BUY_SLIPPAGE = 0.85;
const SELL_SLIPPAGE = 0.5;
const MIN_BUY_THRESHOLD = 0.00001;
const MIN_BALANCE_THRESHOLD = 0.01;
const MIN_BUY = 0.005;
const MAX_RETRIES = 5;
const TRADE_ITERATIONS = 1;

const WORKER_CONF: snipe.WorkerConfig = workerData as snipe.WorkerConfig;
const WORKER_KEYPAIR: Keypair = Keypair.fromSecretKey(new Uint8Array(WORKER_CONF.secret));
global.CONNECTION = new Connection(process.env.RPC || '', 'confirmed');
global.HELIUS_CONNECTION = new Helius(process.env.HELIUS_API_KEY || '');

var MINT_METADATA: pump.PumpMintMeta;
var IS_DONE = false;
var START_BUY = false;
var START_SELL = false;
var CURRENT_SPENDINGS = 0;
var CURRENT_BUY_AMOUNT = 0;
var CANCEL_SLEEP: (() => void) | null = null;
var MESSAGE_BUFFER: string[] = [];

function control_sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
    let timeout_id: NodeJS.Timeout;
    let cancel: () => void = () => { };

    const promise = new Promise<void>((resolve) => {
        timeout_id = setTimeout(resolve, ms);
        cancel = () => {
            clearTimeout(timeout_id);
            resolve();
        };
    });

    return { promise, cancel };
}

function send_messages(): void {
    if (MESSAGE_BUFFER.length > 0) parentPort?.postMessage(MESSAGE_BUFFER.join('\n'));
    MESSAGE_BUFFER = [];
}

async function process_buy(promise: Promise<String>, amount: number) {
    try {
        const sig = await promise;
        try {
            const balance_change = await trade.get_balance_change(sig.toString(), WORKER_KEYPAIR.publicKey);
            CURRENT_SPENDINGS += balance_change;
        } catch (error) {
            MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Error getting balance change, continuing...`);
        }
        MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Bought ${amount} SOL of the token, signature: ${sig}`);
        return true;
    } catch (error) {
        if (error instanceof Error) {
            if (error.message.includes('Simulation failed')) {
                await common.sleep(0.5 * 1000);
                MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Buy simulation failed, retrying...`);
            } else {
                MESSAGE_BUFFER.push(
                    `[Worker ${WORKER_CONF.id}] Failed to buy the token (${error.message}), retrying...`
                );
            }
        }
        return false;
    }
}

const buy = async () => {
    const amount = parseFloat((CURRENT_BUY_AMOUNT > 0 ? CURRENT_BUY_AMOUNT : MIN_BUY).toFixed(5));
    parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Buying ${amount} SOL of the token`);
    let bought = false;

    while (!IS_DONE && !bought) {
        let transactions = [];
        let count = TRADE_ITERATIONS;
        while (count > 0) {
            const buy_promise = pump.Trader.buy_token(
                amount,
                WORKER_KEYPAIR,
                MINT_METADATA,
                BUY_SLIPPAGE,
                trade.PriorityLevel.VERY_HIGH
            );
            transactions.push(
                process_buy(buy_promise, amount).then((result) => {
                    if (result) bought = true;
                })
            );

            count--;
            await common.sleep(0.5 * 1000);
        }
        await Promise.allSettled(transactions);

        CURRENT_BUY_AMOUNT = (WORKER_CONF.spend_limit - CURRENT_SPENDINGS) * 0.95;
    }
};

async function process_sell(promise: Promise<String>, balance: TokenAmount) {
    try {
        const sig = await promise;
        const ui_amount = balance.uiAmount ? balance.uiAmount.toFixed(2) : 0;
        MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Sold ${ui_amount} tokens, signature: ${sig}`);
        return true;
    } catch (error) {
        if (error instanceof Error) {
            if (error.message.includes('Simulation failed')) {
                await common.sleep(0.5 * 1000);
                MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Sell simulation failed, retrying...`);
            } else {
                MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Error selling the token, ${error.message} retrying...`);
            }
        }
        return false;
    }
}

const sell = async () => {
    let sold = false;

    while (!sold) {
        let get_balance_retry = 0;
        let balance: TokenAmount | undefined = undefined;

        while (get_balance_retry < MAX_RETRIES) {
            try {
                balance = await trade.get_token_balance(WORKER_KEYPAIR.publicKey, new PublicKey(MINT_METADATA.mint));
                if (balance.uiAmount !== null && balance.uiAmount !== 0) break;
                get_balance_retry++;

                if (get_balance_retry < MAX_RETRIES)
                    MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Retrying to get the balance...`);
                if (get_balance_retry === MAX_RETRIES) {
                    MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] No tokens to sell, exiting...`);
                    sold = true;
                }
                await common.sleep(5 * 1000);
            } catch (e) {
                MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Error getting the balance, retrying...`);
                get_balance_retry++;
            }
        }

        if (sold) break;

        let transactions = [];
        let count = TRADE_ITERATIONS;

        parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Selling ${balance?.uiAmount} tokens`);
        while (count > 0 && balance !== undefined) {
            const sell_promise = pump.Trader.sell_token(
                balance,
                WORKER_KEYPAIR,
                MINT_METADATA,
                SELL_SLIPPAGE,
                trade.PriorityLevel.HIGH
            );
            transactions.push(
                process_sell(sell_promise, balance).then((result) => {
                    if (result) sold = true;
                })
            );

            count--;
            await common.sleep(0.5 * 1000);
        }
        await Promise.allSettled(transactions);
    }
};

const control_loop = async () =>
    new Promise<void>(async (resolve) => {
        const should_sell = () => MINT_METADATA.usd_market_cap >= WORKER_CONF.mcap_threshold || START_SELL;
        const should_buy = () =>
            CURRENT_SPENDINGS < WORKER_CONF.spend_limit && CURRENT_BUY_AMOUNT > MIN_BUY_THRESHOLD && START_BUY;
        const process = async () => {
            if (!MINT_METADATA) {
                return;
            }

            if (should_sell()) {
                await sell();
                IS_DONE = true;
                return;
            }

            if (should_buy()) {
                await buy();
                if (WORKER_CONF.is_buy_once || !should_buy()) {
                    CURRENT_SPENDINGS = WORKER_CONF.spend_limit;
                    MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Spend limit reached...`);
                }
                return;
            }
        };

        while (!IS_DONE) {
            await process();
            if (!IS_DONE) {
                const ms = should_buy()
                    ? common.normal_random(WORKER_CONF.buy_interval, 0.5 * WORKER_CONF.buy_interval) * 1000
                    : 0.2 * 1000;

                if (!WORKER_CONF.is_buy_once && should_buy())
                    MESSAGE_BUFFER.push(`[Worker ${WORKER_CONF.id}] Sleeping for ${(ms / 1000).toFixed(2)} seconds`);

                const { promise, cancel } = control_sleep(ms);
                CANCEL_SLEEP = cancel;
                send_messages();
                await promise;
            }
        }

        send_messages();
        resolve();
    });

async function main() {
    const balance = (await trade.get_balance(WORKER_KEYPAIR.publicKey)) / LAMPORTS_PER_SOL;
    const adjusted_spend_limit = Math.min(balance, WORKER_CONF.spend_limit) - MIN_BALANCE_THRESHOLD;
    WORKER_CONF.spend_limit = adjusted_spend_limit;

    parentPort?.postMessage({
        command: 'started',
        data: `[Worker ${WORKER_CONF.id}] Started with Public Key: ${WORKER_KEYPAIR.publicKey.toString()}`
    });

    parentPort?.on('message', async (msg) => {
        switch (msg.command) {
            case `buy${WORKER_CONF.id}`:
                const std = WORKER_CONF.start_buy * 0.5;
                CURRENT_BUY_AMOUNT = common.normal_random(WORKER_CONF.start_buy, std);

                if (CURRENT_BUY_AMOUNT > WORKER_CONF.spend_limit) CURRENT_BUY_AMOUNT = WORKER_CONF.spend_limit;
                if (CURRENT_BUY_AMOUNT < MIN_BUY) CURRENT_BUY_AMOUNT = MIN_BUY;

                if (!START_BUY) {
                    parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Received buy command from the main thread`);
                    START_BUY = true;
                }
                break;
            case 'sell':
                if (!START_SELL) {
                    parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Received sell command from the main thread`);
                    START_SELL = true;
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
                parentPort?.postMessage(
                    `[Worker ${WORKER_CONF.id}] Unknown command from the main thread: ${msg.command}`
                );
                break;
        }
    });

    await control_loop();

    parentPort?.postMessage(`[Worker ${WORKER_CONF.id}] Finished`);
    process.exit(0);
}

main().catch((err) => {
    throw err;
});
