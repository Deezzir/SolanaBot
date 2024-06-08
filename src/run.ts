import inquirer from 'inquirer';
import { Worker } from 'worker_threads';
import io from "socket.io-client";
import bs58 from 'bs58';
import { PartiallyDecodedInstruction, PublicKey } from '@solana/web3.js';
import { CreateMetadataAccountV3InstructionData, getCreateMetadataAccountV3InstructionDataSerializer } from '@metaplex-foundation/mpl-token-metadata';
import * as common from './common.js';
import * as trade from './trade.js';

const METAPLEX_PROGRAM_ID = new PublicKey(process.env.METAPLEX_PROGRAM_ID || 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const WORKER_PATH = process.env.WORKER_PATH || './dist/worker.js';
const FETCH_MINT_API_URL = process.env.FETCH_MINT_API_URL || '';
const TRADE_PROGRAM_ID = new PublicKey(process.env.TRADE_PROGRAM_ID || '');
var SUBSCRIPTION_ID: number | undefined;
let LOGS_STOP_FUNCTION: (() => void) | null = null;
let FETCH_STOP_FUNCTION: (() => void) | null = null;

export async function worker_post_message(workers: common.WorkerPromise[], message: string, data: any = {}): Promise<void> {
    if (message === 'stop') await wait_drop_unsub();
    workers.forEach(({ worker }) => worker.postMessage({ command: message, data }));
}

export async function get_config(keys_cnt: number): Promise<common.BotConfig> {
    let answers: common.BotConfig;
    do {
        answers = await inquirer.prompt<common.BotConfig>([
            {
                type: 'input',
                name: 'thread_cnt',
                message: `Enter the number of bots to run(${keys_cnt} accounts available):`,
                validate: value => common.validate_int(value, 1, keys_cnt) ? true : `Please enter a valid number greater than 0 and less or equal to ${keys_cnt}.`,
                filter: value => common.validate_int(value, 1, keys_cnt) ? parseInt(value, 10) : value
            },
            {
                type: 'input',
                name: 'buy_interval',
                message: 'Enter the interval between each buy in seconds:',
                validate: value => common.validate_int(value, 1) ? true : 'Please enter a valid number greater than 0.',
                filter: value => common.validate_int(value, 1) ? parseInt(value, 10) : value
            },
            {
                type: 'input',
                name: 'spend_limit',
                message: 'Enter the limit of Solana that each bot can spend:',
                validate: value => common.validate_float(value, 0.001) ? true : 'Please enter a valid number greater than 0.001.',
                filter: value => common.validate_float(value, 0.001) ? parseFloat(value) : value
            },
            {
                type: 'input',
                name: 'start_buy',
                message: 'Enter the start Solana amount that the bot will buy the token for:',
                validate: value => common.validate_float(value, 0.001) ? true : 'Please enter a valid number greater than 0.001.',
                filter: value => common.validate_float(value, 0.001) ? parseFloat(value) : value
            },
            {
                type: 'input',
                name: 'collect_address',
                message: 'Enter the public key for funds collection:',
                validate: input => common.is_valid_pubkey(input) || "Please enter a valid public key.",
                filter: input => new PublicKey(input)
            },
            {
                type: 'input',
                name: 'mcap_threshold',
                message: 'Enter the threshold market cap:',
                validate: value => common.validate_int(value, 5000) ? true : 'Please enter a valid number greater than 5000',
                filter: value => common.validate_int(value, 5000) ? parseInt(value, 10) : value
            },
            {
                type: 'list',
                name: 'action',
                message: 'Choose the action to perform after MCAP reached:',
                choices: common.ActionStrings,
                default: common.ActionStrings[0],
                filter: input => common.ActionStrings.indexOf(input) as common.Action
            },
        ]);

        const method = await inquirer.prompt([
            {
                type: 'list',
                name: 'type',
                message: 'Choose the type of the sniping:',
                choices: ['Wait for the token to drop', 'Snipe an existing token'],
                default: 0,
                filter: input => input.toLowerCase().includes(common.MethodStrings[common.Method.Wait].toLocaleLowerCase()) ? common.Method.Wait : common.Method.Snipe
            }
        ]);

        if (method.type === common.Method.Wait) {
            const token_meta = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'token_name',
                    message: 'Enter the token name:',
                },
                {
                    type: 'input',
                    name: 'token_ticker',
                    message: 'Enter the token ticker:',
                },
            ]);
            answers = { ...answers, ...token_meta };
        } else {
            const mint = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'mint',
                    message: 'Enter the mint public key:',
                    validate: async (input) => {
                        if (!common.is_valid_pubkey(input)) return "Please enter a valid public key.";
                        const meta = await trade.fetch_mint(input);
                        if (Object.keys(meta).length === 0) return "Failed fetching the mint data with the public key.";
                        return true;
                    },
                    filter: input => new PublicKey(input)
                }
            ]);
            answers = { ...answers, ...mint };
        }

        await common.clear_lines_up(Object.keys(answers).length + 1);
        console.table(common.BotConfigDisplay(answers));
        const prompt = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'proceed',
                message: 'Do you want to start the bot with the above configuration?',
            }
        ]);

        if (prompt.proceed) break;
        else await common.clear_lines_up(Object.keys(answers).length + 6);
    } while (true);

    return answers;
}

function decode_metaplex_instr(data: string): [CreateMetadataAccountV3InstructionData, number] {
    const serializer = getCreateMetadataAccountV3InstructionDataSerializer();
    const decoded = serializer.deserialize(bs58.decode(data));
    return decoded;
}

export async function wait_drop_sub(token_name: string, token_ticker: string, start_timestamp: number): Promise<PublicKey | null> {
    let name = token_name.toLowerCase();
    let ticker = token_ticker.toLowerCase();

    let search = [];

    search.push(new Promise<PublicKey | null>(async (resolve, reject) => {
        common.log('[Main Worker] Waiting for the new token drop using Websocket...');
        let lastCoins: common.TokenMeta[] = [];
        const socket = io(FETCH_MINT_API_URL, {
            path: "/socket.io/",
            query: { offset: 0, limit: 100, sort: "last_trade_timestamp", order: "DESC", includeNsfw: true },
            transports: ["websocket"]
        });
        LOGS_STOP_FUNCTION = () => { socket.disconnect(); reject(new Error('User stopped the process')) };
        socket.on("connect", () => { });
        socket.on("disconnect", () => { });

        socket.prependAny(async (_, ...obj) => {
            let currentDate = Date.now();
            let token = obj[0];
            let createdDate = (token.created_timestamp + 50000 + (Math.floor(Math.random() * 5)));

            if (createdDate >= currentDate) {
                lastCoins = lastCoins.sort((a, b) => b.created_timestamp - a.created_timestamp);
                if (!lastCoins.some(e => e.mint === token.mint)) {
                    lastCoins.push(token);
                    lastCoins = lastCoins.sort((a, b) => b.created_timestamp - a.created_timestamp);

                    if (token.name.toLowerCase() === token_name.toLowerCase() && token.symbol.toLowerCase() === ticker.toLocaleLowerCase()) {
                        LOGS_STOP_FUNCTION = null
                        await wait_drop_unsub();
                        common.log(`[Main Worker] Found the mint using Websocket`);
                        socket.disconnect();
                        resolve(new PublicKey(token.mint));
                    }
                }
            }
            if (lastCoins.length >= 20) {
                lastCoins.pop();
            }
        });
    }));

    search.push(new Promise<PublicKey | null>((resolve, reject) => {
        let mint: PublicKey;
        LOGS_STOP_FUNCTION = () => reject(new Error('User stopped the process'));
        common.log('[Main Worker] Waiting for the new token drop using Solana logs...');
        SUBSCRIPTION_ID = global.endpoint.connection.onLogs(TRADE_PROGRAM_ID, async ({ err, logs, signature }) => {
            if (err) return;
            if (logs && logs.includes('Program log: Create')) {
                try {
                    const tx = await global.endpoint.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
                    if (!tx || !tx.meta || !tx.transaction.message || !tx.meta.postTokenBalances) return;

                    const inner_instructions = tx.meta.innerInstructions;
                    if (!inner_instructions) return;

                    for (const inner of inner_instructions) {
                        for (const instruction of inner.instructions) {
                            if (!instruction.programId.equals(METAPLEX_PROGRAM_ID)) continue;

                            const partial = instruction as PartiallyDecodedInstruction;
                            const [meta, bytes_read] = decode_metaplex_instr(partial.data);
                            if (bytes_read <= 0) continue;
                            if (meta.data.name.toLowerCase() === name.toLowerCase() && meta.data.symbol.toLowerCase() === ticker.toLowerCase()) {
                                if (tx.meta.postTokenBalances[0].mint)
                                    mint = new PublicKey(tx.meta.postTokenBalances[0].mint);
                                else
                                    mint = partial.accounts[1];
                            }
                        }
                    }
                    const signers = tx.transaction.message.accountKeys.filter(key => key.signer);
                    if (signers.some(({ pubkey }) => mint !== undefined && pubkey.equals(mint))) {
                        LOGS_STOP_FUNCTION = null;
                        await wait_drop_unsub();
                        common.log(`[Main Worker] Found the mint using Solana logs`);
                        resolve(mint);
                    }
                } catch (err) {
                    common.error(`[ERROR] Failed fetching the parsed transaction: ${err}`);
                }
            }
        }, 'confirmed',);
        if (SUBSCRIPTION_ID === undefined)
            reject(new Error('Failed to subscribe to logs'));
    }));

    return Promise.race(search).then(result => {
        if (!result) return null;
        return result;
    }).catch(error => {
        common.error(`[ERROR] An error occurred: ${error}`);
        return null;
    });
}

export async function wait_drop_unsub(): Promise<void> {
    if (SUBSCRIPTION_ID !== undefined) {
        if (LOGS_STOP_FUNCTION) LOGS_STOP_FUNCTION();
        if (FETCH_STOP_FUNCTION) FETCH_STOP_FUNCTION();
        global.endpoint.connection.removeOnLogsListener(SUBSCRIPTION_ID)
            .then(() => SUBSCRIPTION_ID = undefined)
            .catch(err => common.error(`[ERROR] Failed to unsubscribe from logs: ${err}`));
    }
}

export async function start_workers(config: common.BotConfig, workers: common.WorkerPromise[], keys_dir: string): Promise<void> {
    const keys = await common.get_keys(config.thread_cnt + 1, keys_dir, 1);
    if (keys.length === 0) {
        common.error('[ERROR] No keys available.');
        global.rl.close();
    }
    if (!trade.check_has_balances(keys)) {
        common.error('[ERROR] First, topup the specified accounts.');
        global.rl.close();
    }
    common.log('[Main Worker] Starting the workers...');
    for (let i = 0; i < config.thread_cnt; i++) {
        const key = keys.at(i);
        if (!key) {
            common.error(`[ERROR] Failed to get the key at index ${i}`);
            global.rl.close();
        }
        const data: common.WorkerConfig = {
            secret: key ?? new Uint8Array(),
            id: i + 1,
            inputs: config
        };
        const worker = new Worker(WORKER_PATH, { workerData: data });
        const promise = new Promise<void>((resolve, reject) => {
            worker.on('message', (msg) => common.log(msg));
            worker.on('error', (err) => { common.error(`[Worker ${i}] encountered error: ${err}`); reject() });
            worker.on('exit', (code) => {
                if (code !== 0) reject(new Error(`[Worker ${i}] Stopped with exit code ${code}`));
                else resolve();
            }
            );
        });
        workers.push({ worker: worker, promise: promise });
    }
}

export async function wait_for_workers(workers: common.WorkerPromise[]): Promise<void> {
    let promises = workers.map(w => w.promise);
    try {
        await Promise.all(promises);
        common.log('[Main Worker] All workers have finished executing');
    } catch (err) {
        common.error(`[ERROR] One of the workers encountered an error`);
    }
}