import figlet from 'figlet';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { readdir } from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv'
import { Worker } from 'worker_threads';
import bs58 from 'bs58';
import * as web3 from '@solana/web3.js';
import { getCreateMetadataAccountV3InstructionDataSerializer } from '@metaplex-foundation/mpl-token-metadata';
import { readFileSync } from 'fs';
import { exit } from 'process';
import type { BotConfig, WorkerConfig } from './types.ts';

interface WorkerPromise {
    worker: Worker;
    promise: Promise<void>;
}

// bot setup
dotenv.config();
const keysDir = './keys';
const workerPath = './dist/worker.js';
let workers = new Array<WorkerPromise>();

// web3 setup
const connection = new web3.Connection(process.env.RPC || '', 'confirmed');
const programID = new web3.PublicKey(process.env.PROGRAM_ID || '');
const metaplexProgramID = new web3.PublicKey(process.env.METAPLEX_PROGRAM_ID || '');
let subscriptionID: number | undefined;
let mint: web3.PublicKey | undefined;

// bot setuo
let config: BotConfig;

function filter_keys(files: string[]): string[] {
    return files.filter(file => path.extname(file) === '.json' && /key[0-9]+/.test(path.basename(file)));
}

async function count_keys(): Promise<number> {
    try {
        const files = await readdir(keysDir);
        return filter_keys(files).length;
    } catch (err) {
        console.error('Error reading keys directory:', err);
        return 0;
    }
}

async function get_keys(): Promise<Uint8Array[]> {
    try {
        const files = await readdir(keysDir);
        return filter_keys(files).map(file => {
            const content = readFileSync(path.join(keysDir, file), 'utf8');
            return new Uint8Array(JSON.parse(content));
        });
    } catch (err) {
        console.error('Error reading keys directory:', err);
        return [];
    }
}

async function clear_lines_up(lines: number): Promise<void> {
    process.stdout.moveCursor(0, -lines);
    process.stdout.clearScreenDown();
}

function validate_number(input: string, min: number = -Infinity, max: number = Infinity): boolean {
    const num = parseInt(input);
    if (isNaN(num) || num <= min || num > max) return false;
    return true;
}

async function get_config(): Promise<BotConfig> {
    let answers: BotConfig;
    const keys_cnt = await count_keys();
    do {
        answers = await inquirer.prompt<BotConfig>([
            {
                type: 'input',
                name: 'thread_cnt',
                message: `Enter the number of bots to run(${keys_cnt} accounts available):`,
                validate: value => validate_number(value, 0, keys_cnt) ? true : `Please enter a valid number greater than 0 and less or equal to ${keys_cnt}.`,
                filter: value => validate_number(value, 0, keys_cnt) ? parseInt(value, 10) : value
            },
            {
                type: 'input',
                name: 'buy_interval',
                message: 'Enter the interval between each buy in seconds:',
                validate: value => validate_number(value, 0) ? true : 'Please enter a valid number greater than 0.',
                filter: value => validate_number(value, 0) ? parseInt(value, 10) : value
            },
            {
                type: 'input',
                name: 'spend_limit',
                message: 'Enter the limit of Solana that each bot can spend:',
                validate: value => validate_number(value, 0) ? true : 'Please enter a valid number greater than 0.',
                filter: value => validate_number(value, 0) ? parseInt(value, 10) : value
            },
            {
                type: 'input',
                name: 'return_pubkey',
                message: 'Enter the return public key:',
                validate: input => /[a-zA-Z0-9]{43,44}/.test(input) || "Please enter a valid public key."
            },
            {
                type: 'input',
                name: 'mcap_threshold',
                message: 'Enter the threshold market cap:',
                validate: value => validate_number(value, 0) ? true : 'Please enter a valid number greater than 0.',
                filter: value => validate_number(value, 0) ? parseInt(value, 10) : value
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
            // {
            //     type: 'confirm',
            //     name: 'wait_drop',
            //     message: 'Should the bot wait for the new token drop?',
            // },
        ]);

        await clear_lines_up(Object.keys(answers).length);
        console.table(answers);
        const confirm = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'confirmation',
                message: 'Do you want to start the bot with the above configuration?',
            }
        ]);

        if (confirm.confirmation) break;
        else await clear_lines_up(Object.keys(answers).length + 5);
    } while (true);

    return answers;
}

function decode_metaplex_instr(data: string) {
    const serializer = getCreateMetadataAccountV3InstructionDataSerializer();
    const decoded = serializer.deserialize(bs58.decode(data));
    return decoded;
}

function wait_drop_sub() {
    console.log('Waiting for the new token drop...');
    subscriptionID = connection.onLogs(programID, async ({ err, logs, signature }) => {
        if (err) return;
        if (logs && logs.includes('Program log: Instruction: MintTo')) {
            try {
                const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
                if (!tx || !tx.meta || !tx.transaction.message || !tx.meta.postTokenBalances) return;

                const inner_instructions = tx.meta.innerInstructions;
                if (!inner_instructions) return;

                for (const inner of inner_instructions) {
                    for (const instruction of inner.instructions) {
                        if (!instruction.programId.equals(metaplexProgramID)) continue;

                        const partial = instruction as web3.PartiallyDecodedInstruction;
                        const [meta, bytes_read] = decode_metaplex_instr(partial.data);
                        if (bytes_read <= 0) continue;
                        if (meta.data.name === config.token_name && meta.data.symbol.includes(config.token_ticker)) {
                            if (tx.meta.postTokenBalances[0].mint) {
                                mint = new web3.PublicKey(tx.meta.postTokenBalances[0].mint);
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
                console.error('Error fetching the parsed transaction:', err);
            }
        }
    }, 'confirmed',);
    if (subscriptionID === undefined) {
        console.error('Error subscribing to logs.');
        exit(1);
    }
}

async function wait_drop_unsub() {
    if (subscriptionID !== undefined) {
        connection.removeOnLogsListener(subscriptionID)
            .then(() => subscriptionID = undefined)
            .catch(err => console.error('Error unsubscribing from logs:', err));
    }
}

async function start_workers() {
    const secrets = await get_keys();
    if (secrets.length === 0) {
        console.error('No keys available.');
        exit(1);
    }
    console.log('Starting the workers...');
    for (let i = 0; i < config.thread_cnt; i++) {
        const data: WorkerConfig = {
            secret: secrets[i],
            id: i + 1,
            config: config
        };
        const worker = new Worker(workerPath, { workerData: data });
        const promise = new Promise<void>((resolve, reject) => {
            worker.on('message', (msg) => console.log('Message from worker:', msg));
            worker.on('error', (err) => { console.error('Worker error:', err); reject() });
            worker.on('exit', (code) => {
                if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
                else resolve();
            }
            );
        });
        workers.push({ worker: worker, promise: promise });
    }
}

async function wait_for_workers() {
    let promises = workers.map(w => w.promise);
    try {
        await Promise.all(promises);
        console.log('All workers have finished executing.');
    } catch (error) {
        console.error('One of the workers encountered an error:', error);
    }
}

async function start() {
    // const config = await get_config();
    // clear_lines_up(1);
    // if (!config) return;

    config = {
        thread_cnt: 1,
        buy_interval: 30,
        spend_limit: 1,
        return_pubkey: '5oZvi4JNC85mJcB93vzotq3UTLR2Emroz87XtAUhP1Ng',
        mcap_threshold: 50000,
        token_name: 'TESasfasTagasg2345678910',
        token_ticker: 'SBVAABBAA'
    };

    console.log('Starting the bot...');
    await start_workers();
    // wait_drop_sub();
    // if (mint) console.log('Token detected:', mint.toString());
    setTimeout(() => {
        workers.forEach(({ worker }) => worker.postMessage({ command: 'buy', mint: mint }));
    }, 3000);
    await wait_for_workers();
}


//------------------------------------------------------------
// main
const program = new Command();
console.log(figlet.textSync('Solana Buy Bot', { horizontalLayout: 'full' }));
program
    .version('1.0.0')
    .description('Solana Buy Bot CLI');
program
    .command('start')
    .alias('s')
    .description('Start the bot')
    .action(start);
program.parse(process.argv);
if (!process.argv.slice(2).length) {
    program.outputHelp();
}