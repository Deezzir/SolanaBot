import inquirer from 'inquirer';
import { Worker } from 'worker_threads';
import io from "socket.io-client";
import bs58 from 'bs58';
import { Keypair, PartiallyDecodedInstruction, PublicKey } from '@solana/web3.js';
import { CreateMetadataAccountV3InstructionData, getCreateMetadataAccountV3InstructionDataSerializer } from '@metaplex-foundation/mpl-token-metadata';
import * as common from './common.js';
import { clearLine, cursorTo, moveCursor } from 'readline';
import * as trade from './trade.js';

const METAPLEX_PROGRAM_ID = new PublicKey(process.env.METAPLEX_PROGRAM_ID || 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const WORKER_PATH = process.env.WORKER_PATH || './dist/worker.js';
const FETCH_MINT_API_URL = process.env.FETCH_MINT_API_URL || '';
const TRADE_PROGRAM_ID = new PublicKey(process.env.TRADE_PROGRAM_ID || '');
var SUBSCRIPTION_ID: number | undefined;
let LOGS_STOP_FUNCTION: (() => void) | null = null;
let FETCH_STOP_FUNCTION: (() => void) | null = null;

export async function worker_post_message(workers: common.WorkerJob[], message: string, data: any = {}, interval_seconds: number = 0): Promise<void> {
    if (message === 'stop') await wait_drop_unsub();
    if (message === 'buy') {
        for (const worker of workers) {
            common.log(`[Main Worker] Sending the buy command to worker ${worker.index}`);
            worker.worker.postMessage({ command: `buy${worker.index}`, data });
            if (interval_seconds > 0) {
                const min_interval = interval_seconds * 1000;
                const max_interval = interval_seconds * 1.5 * 1000;
                await common.sleep(Math.floor(Math.random() * (max_interval - min_interval)) + min_interval);
            }
        }
        return;
    }
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
                type: 'confirm',
                name: 'is_bump',
                message: 'Do you want to use the Bump Orders?',
                default: false
            },
            {
                type: 'confirm',
                name: 'is_buy_once',
                message: 'Do you want to buy only once?',
                default: false
            },
            {
                type: 'number',
                name: 'start_interval',
                message: 'Enter the start interval in seconds:',
                default: 0,
                validate: value => common.validate_int(value, 0) ? true : 'Please enter a valid number greater than or equal to 0.',
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
                        const meta = await common.fetch_mint(input);
                        if (Object.keys(meta).length === 0) return "Failed fetching the mint data with the public key.";
                        return true;
                    },
                    filter: input => new PublicKey(input)
                }
            ]);
            answers = { ...answers, ...mint };
        }

        await common.clear_lines_up(Object.keys(answers).length + 1);
        console.table(common.bot_conf_display(answers));
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

export async function wait_drop_sub(token_name: string, token_ticker: string): Promise<PublicKey | null> {
    let name = token_name.toLowerCase();
    let ticker = token_ticker.toLowerCase();

    let search = [];

    search.push(new Promise<PublicKey | null>(async (resolve, reject) => {
        common.log('[Main Worker] Waiting for the new token drop using Websocket...');
        const socket = io(FETCH_MINT_API_URL, {
            path: "/socket.io/",
            query: { offset: 0, limit: 100, sort: "last_trade_timestamp", order: "DESC", includeNsfw: true },
            transports: ["websocket"]
        });
        LOGS_STOP_FUNCTION = () => { socket.disconnect(); reject(new Error('User stopped the process')) };
        socket.on("connect", () => { });
        socket.on("disconnect", () => { });

        socket.prependAny(async (_, ...obj) => {
            let token = obj[0] as common.TokenMeta;
            if (token.name.toLowerCase() === token_name.toLowerCase() && token.symbol.toLowerCase() === ticker.toLocaleLowerCase()) {
                LOGS_STOP_FUNCTION = null
                await wait_drop_unsub();
                common.log(`[Main Worker] Found the mint using Websocket`);
                socket.disconnect();
                resolve(new PublicKey(token.mint));
            }
        });
    }));

    search.push(new Promise<PublicKey | null>((resolve, reject) => {
        let mint: PublicKey;
        LOGS_STOP_FUNCTION = () => reject(new Error('User stopped the process'));
        common.log('[Main Worker] Waiting for the new token drop using Solana logs...');
        SUBSCRIPTION_ID = global.CONNECTION.onLogs(TRADE_PROGRAM_ID, async ({ err, logs, signature }) => {
            if (err) return;
            if (logs && logs.includes('Program log: Instruction: Create')) {
                try {
                    const tx = await global.CONNECTION.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
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
        global.CONNECTION.removeOnLogsListener(SUBSCRIPTION_ID)
            .then(() => SUBSCRIPTION_ID = undefined)
            .catch(err => common.error(`[ERROR] Failed to unsubscribe from logs: ${err}`));
    }
}

export async function start_workers(keys: common.Key[], config: common.BotConfig, workers: common.WorkerJob[]): Promise<boolean> {
    keys = keys.filter((key) => !key.is_reserve).slice(0, config.thread_cnt);

    if (keys.length === 0 || keys.length < config.thread_cnt) {
        common.error(`[ERROR] The number of keys doesn't match the number of threads`);
        global.RL.close();
        return false;
    }

    const all_has_balances = await trade.check_has_balances(keys);
    if (!all_has_balances) {
        common.error('[ERROR] First, topup the specified accounts.');
        global.RL.close();
        return false;
    }

    common.log('[Main Worker] Starting the workers...');
    const started_promises: Promise<void>[] = [];

    for (const key of keys) {
        const data: common.WorkerConfig = {
            secret: key.keypair.secretKey,
            id: key.index,
            inputs: config
        };

        const worker = new Worker(WORKER_PATH, { workerData: data });

        let started: () => void;
        const started_promise = new Promise<void>(resolve => started = resolve);

        const job = new Promise<void>((resolve, reject) => {
            worker.on('message', (msg) => {
                if (msg.command === 'started') {
                    started()
                    common.log(msg.data);
                    return;
                }
                common.log(msg);
            });
            worker.on('error', (err) => { common.error(`[Worker ${key.index}] Encountered error: ${err}`); reject() });
            worker.on('exit', (code) => {
                if (code !== 0) reject(new Error(`[Worker ${key.index}]Stopped with exit code ${code} `));
                else resolve();
            }
            );
        });

        started_promises.push(started_promise);
        workers.push({ worker: worker, index: key.index, job: job });
    }

    await Promise.all(started_promises);
    common.log('[Main Worker] All workers have started');

    return true;
}

export async function wait_for_workers(workers: common.WorkerJob[]): Promise<void> {
    let promises = workers.map(w => w.job);
    try {
        await Promise.all(promises);
        common.log('[Main Worker] All workers have finished executing');
    } catch (err) {
        common.error(`[ERROR] One of the workers encountered an error`);
    }
}

export function setup_cmd_interface(workers: common.WorkerJob[], bot_config: common.BotConfig) {
    if (global.RL === undefined) common.setup_readline();
    global.RL.setPrompt('Command (stop/config/collect/sell/set)> ');
    global.RL.prompt(true);

    let selling = false;
    let stopping = false;

    global.RL.on('line', async (line) => {
        moveCursor(process.stdout, 0, -1);
        clearLine(process.stdout, 0);
        switch (line.trim().split(' ')[0]) {
            case 'stop':
                if (!stopping) {
                    if (workers.length > 0) {
                        worker_post_message(workers, 'stop');
                        stopping = true;
                    }
                } else {
                    common.log('[Main Worker] Stopping is already in progress...');
                }
                break;
            case 'config':
                if (bot_config !== undefined)
                    console.table(common.bot_conf_display(bot_config));
                break;
            case 'collect':
                if (!global.START_COLLECT) {
                    worker_post_message(workers, 'collect');
                    global.START_COLLECT = true;
                } else {
                    common.log('[Main Worker] Collecting is already in progress...');
                }
                break;
            case 'sell':
                if (!selling) {
                    if (workers.length > 0) {
                        worker_post_message(workers, 'sell');
                        selling = true;
                    }
                } else {
                    common.log('[Main Worker] Selling is already in progress...');
                }
                break;
            case 'set':
                const args = line.trim().split(' ');
                if (args.length < 3) {
                    common.log('Invalid command. Example: set action buy');
                    break;
                }
                const [, key, value] = args;
                common.update_bot_config(bot_config, key, value);
                break;
            default:
                common.log(`Unknown command: ${line.trim()} `);
                break;
        }
        global.RL.prompt(true);
    }).on('close', () => {
        common.log('[Main Worker] Stopping the bot...');
        cursorTo(process.stdout, 0);
        clearLine(process.stdout, 0);
        process.exit(0);
    });
}

export async function setup_config(config: common.BotConfig, keys_cnt: number): Promise<common.BotConfig | undefined> {
    if (config) {
        if (config.mint) {
            common.log('Sniping existing mint...');
        } else if (config.token_name && config.token_ticker) {
            common.log('Sniping token by name and ticker...');
        } else {
            console.error('Invalid config file.');
            process.exit(1);
        }
        console.table(common.bot_conf_display(config));
        common.setup_readline();
        await new Promise<void>(resolve => global.RL.question('Press ENTER to start the bot...', () => resolve()));
    } else {
        config = await get_config(keys_cnt - 1);
        common.clear_lines_up(1);
        if (!config) return;
    }
    return config;
}