import inquirer from 'inquirer';
import { Worker } from 'worker_threads';
import bs58 from 'bs58';
import { PartiallyDecodedInstruction, PublicKey } from '@solana/web3.js';
import { getCreateMetadataAccountV3InstructionDataSerializer } from '@metaplex-foundation/mpl-token-metadata';
import * as common from './common.js';

const METAPLEX_PROGRAM_ID = new PublicKey(process.env.METAPLEX_PROGRAM_ID || 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const FETCH_MINT_API_URL = process.env.FETCH_MINT_API_URL || '';
const WORKER_PATH = process.env.WORKER_PATH || './dist/worker.js';
const TRADE_PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || '');
var subscriptionID: number | undefined;

export async function fetch_mint(mint: string): Promise<Object> {
    return fetch(`${FETCH_MINT_API_URL}/${mint}`)
        .then(response => response.json())
        .then(data => {
            return data;
        })
        .catch(err => common.log_error(`[ERROR] Failed fetching the mint: ${err}`));
}

export function worker_post_message(workers: common.WorkerPromise[], message: string, data: any = {}) {
    workers.forEach(({ worker }) => worker.postMessage({ command: message, data }));
}

export async function worker_update_mint(workers: common.WorkerPromise[], mint: string) {
    const mint_meta = await fetch_mint(mint);
    if (mint_meta)
        worker_post_message(workers, 'mint', mint_meta);
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
                name: 'return_pubkey',
                message: 'Enter the return public key:',
                validate: input => common.is_valid_pubkey(input) || "Please enter a valid public key.",
                filter: input => new PublicKey(input)
            },
            {
                type: 'list',
                name: 'action',
                message: 'Choose the action to perform after MC reached:',
                choices: common.ActionStrings,
                default: common.ActionStrings[0],
                filter: input => common.ActionStrings.indexOf(input) as common.Action
            },
            {
                type: 'input',
                name: 'mcap_threshold',
                message: 'Enter the threshold market cap:',
                validate: value => common.validate_int(value, 5000) ? true : 'Please enter a valid number greater than 5000',
                filter: value => common.validate_int(value, 5000) ? parseInt(value, 10) : value
            },
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

        await common.clear_lines_up(Object.keys(answers).length);
        console.table(common.BotConfigDisplay(answers));
        const confirm = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'confirmation',
                message: 'Do you want to start the bot with the above configuration?',
            }
        ]);

        if (confirm.confirmation) break;
        else await common.clear_lines_up(Object.keys(answers).length + 5);
    } while (true);

    return answers;
}

function decode_metaplex_instr(data: string) {
    const serializer = getCreateMetadataAccountV3InstructionDataSerializer();
    const decoded = serializer.deserialize(bs58.decode(data));
    return decoded;
}

export function wait_drop_sub(token_name: string, token_ticker: string, mint: PublicKey | undefined) {
    common.log('[Main Worker] Waiting for the new token drop...');
    subscriptionID = connection.onLogs(TRADE_PROGRAM_ID, async ({ err, logs, signature }) => {
        if (err) return;
        if (logs && logs.includes('Program log: Instruction: MintTo')) {
            try {
                const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
                if (!tx || !tx.meta || !tx.transaction.message || !tx.meta.postTokenBalances) return;

                const inner_instructions = tx.meta.innerInstructions;
                if (!inner_instructions) return;

                for (const inner of inner_instructions) {
                    for (const instruction of inner.instructions) {
                        if (!instruction.programId.equals(METAPLEX_PROGRAM_ID)) continue;

                        const partial = instruction as PartiallyDecodedInstruction;
                        const [meta, bytes_read] = decode_metaplex_instr(partial.data);
                        if (bytes_read <= 0) continue;
                        if (meta.data.name === token_name && meta.data.symbol.includes(token_ticker)) {
                            if (tx.meta.postTokenBalances[0].mint) {
                                mint = new PublicKey(tx.meta.postTokenBalances[0].mint);
                            } else {
                                mint = partial.accounts[1];
                            }
                        }
                    }
                }
                const signers = tx.transaction.message.accountKeys.filter(key => key.signer);
                if (signers.some(({ pubkey }) => mint !== undefined && pubkey.equals(mint)))
                    await wait_drop_unsub();
            } catch (err) {
                common.log_error(`[ERROR] Failed fetching the parsed transaction: ${err}`);
            }
        }
    }, 'confirmed',);
    if (subscriptionID === undefined) {
        common.log_error('[ERROR] Failed to subscribe to logs.');
        global.rl.close();
    }
}

async function wait_drop_unsub() {
    if (subscriptionID !== undefined) {
        connection.removeOnLogsListener(subscriptionID)
            .then(() => subscriptionID = undefined)
            .catch(err => common.log_error(`[ERROR] Failed to unsubscribe from logs: ${err}`));
    }
}

export async function start_workers(config: common.BotConfig, workers: common.WorkerPromise[], keys_dir: string) {
    const secrets: Uint8Array[] = [];
    const ok = await common.get_keys(secrets, config.thread_cnt, keys_dir);
    if (secrets.length === 0) {
        common.log_error('[ERROR] No keys available.');
        global.rl.close();
    }
    if (!ok) {
        common.log_error('[ERROR] First, topup the specified accounts.');
        global.rl.close();
    }
    common.log('[Main Worker] Starting the workers...');
    for (let i = 1
        ; i < config.thread_cnt; i++) {
        const data: common.WorkerConfig = {
            secret: secrets[i],
            id: i + 1,
            inputs: config
        };
        const worker = new Worker(WORKER_PATH, { workerData: data });
        const promise = new Promise<void>((resolve, reject) => {
            worker.on('message', (msg) => common.log(msg));
            worker.on('error', (err) => { common.log_error(`[Worker ${i}] encountered error: ${err}`); reject() });
            worker.on('exit', (code) => {
                if (code !== 0) reject(new Error(`[Worker ${i}] Stopped with exit code ${code}`));
                else resolve();
            }
            );
        });
        workers.push({ worker: worker, promise: promise });
    }
}

export async function wait_for_workers(workers: common.WorkerPromise[]) {
    let promises = workers.map(w => w.promise);
    try {
        await Promise.all(promises);
        common.log('[Main Worker] All workers have finished executing');
    } catch (err) {
        common.log_error(`[ERROR] One of the workers encountered an error`);
    }
}