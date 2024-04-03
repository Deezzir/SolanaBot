import figlet from 'figlet';
import { Command, InvalidArgumentError } from 'commander';
import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { readdir } from 'fs/promises';
import * as common from './common.js';
import { start_workers, wait_for_workers, wait_drop_sub } from './buy.js';
import dotenv from 'dotenv'
import { readFileSync } from 'fs';
import * as readline from 'readline';

dotenv.config();
global.keysDir = process.env.KEYS_DIR || './keys';
global.workerPath = './dist/worker.js';
global.connection = new Connection(process.env.RPC || '', 'confirmed');
global.programID = new PublicKey(process.env.PROGRAM_ID || '');
global.metaplexProgramID = new PublicKey(process.env.METAPLEX_PROGRAM_ID || '');

let workers = new Array<common.WorkerPromise>();
let config: common.BotConfig;

async function balance() {
    common.log('Getting the balance of the keys...');
    const keys_cnt = await common.count_keys();
    if (keys_cnt === 0) {
        common.log_error('[ERROR] No keys available.');
        return;
    }
    const files = common.natural_sort(await readdir(global.keysDir));
    for (const file of files) {
        const key = common.get_key(file);
        if (!key) continue;
        const keypair = Keypair.fromSecretKey(key);
        const balance = await connection.getBalance(keypair.publicKey) / LAMPORTS_PER_SOL;
        common.log(`File: ${file.padEnd(10, ' ')} | Address: ${keypair.publicKey.toString().padEnd(44, ' ')} | Balance: ${balance.toFixed(9)} SOL`);
    }
}

async function warmup() {
    common.log('TODO: Warmup the accounts with the tokens');
}

async function collect(address: string) {
    common.log('Collecting all the funds from the accounts...');
    const receiver = new PublicKey(address);
    common.log(`Receiver address: ${receiver.toString()}\n`);

    let transactions = [];
    const files = common.natural_sort(await readdir(global.keysDir));
    for (const file of files) {
        const key = common.get_key(file);
        if (!key) continue;
        const payer = Keypair.fromSecretKey(key);
        const amount = await connection.getBalance(payer.publicKey);
        if (amount === 0) continue;

        common.log(`Collecting ${amount / LAMPORTS_PER_SOL} SOL from ${payer.publicKey.toString().padEnd(44, ' ')} (${file})...`);
        transactions.push(common.send_lamports_to(amount, payer, receiver, true)
            .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
            .catch(error => common.log_error(`Transaction failed for ${file}, error: ${error.message}`)));
    }

    await Promise.allSettled(transactions);
}

async function topup(amount: number, keypair_path: string) {
    common.log('Topping up the accounts with SOL...');
    const keys_cnt = await common.count_keys();
    if (keys_cnt === 0) {
        common.log_error('[ERROR] No keys available.');
        return;
    }

    let payer: Keypair;
    try {
        payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypair_path, 'utf8'))));
        const balance = await connection.getBalance(payer.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Payer address: ${payer.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`);
        if (balance < amount * keys_cnt) {
            common.log_error(`[ERROR] Payer balance is not enough to topup ${amount} SOL to ${keys_cnt} keys`);
            return;
        }
    } catch (err) {
        common.log_error('[ERROR] Failed to process keypair file');
        return;
    }

    let transactions = [];
    const files = common.natural_sort(await readdir(global.keysDir));
    let cnt = 0;
    for (const file of files) {
        cnt++;
        if (cnt > 5) break;

        const key = common.get_key(file);
        if (!key) continue;
        const receiver = Keypair.fromSecretKey(key);

        common.log(`Sending ${amount} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')} (${file})...`);
        transactions.push(common.send_lamports_to(amount * LAMPORTS_PER_SOL, payer, receiver.publicKey)
            .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
            .catch(error => common.log_error(`Transaction failed for ${file}, error: ${error.message}`)));
    }
    await Promise.allSettled(transactions);
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

    common.log('[Main Worker] Starting the bot...');
    await start_workers(config, workers);
    let mint = new PublicKey('8dtMxtXB7XSeyKdVYUZbwrVtFWL6ySN2ANqG6nJm4Fx4');
    // wait_drop_sub(config.token_name, config.token_ticker, mint);
    // if (mint) log('Token detected:', mint.toString());
    setTimeout(() => {
        workers.forEach(({ worker }) => worker.postMessage({ command: 'buy', mint: mint }));
    }, 3000);
    // await wait_for_workers(workers);
    await wait_for_workers(workers);
}


//------------------------------------------------------------
// main
const program = new Command();

common.log(figlet.textSync('Solana Buy Bot', { horizontalLayout: 'full' }));

program
    .version('1.0.0')
    .description('Solana Buy Bot CLI');

program
    .command('start')
    .alias('s')
    .description('Start the bot')
    .action(() => {
        global.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.setPrompt('Command (stop/config)> ');
        rl.prompt(true);

        rl.on('line', async (line) => {
            readline.moveCursor(process.stdout, 0, -1);
            readline.clearLine(process.stdout, 0);
            switch (line.trim()) {
                case 'stop':
                    rl.close();
                case 'config':
                    if (config !== undefined)
                        console.table(config);
                    break;
                default:
                    common.log('Unknown command');
                    break;
            }
            rl.prompt(true);
        }).on('close', () => {
            common.log('[Main Worker] Stopping the bot...');
            readline.cursorTo(process.stdout, 0);
            readline.clearLine(process.stdout, 0);
            process.exit(0);
        });
        start()
    });

program
    .command('balance')
    .alias('b')
    .description('Get the balance of the keys')
    .action(balance);

program
    .command('warmup')
    .alias('w')
    .description('Warmup the accounts with the tokens')
    .action(warmup);

program
    .command('collect')
    .alias('c')
    .argument('<address>', 'Public address of the receiver', (value) => {
        if (!common.is_valid_pubkey(value))
            throw new InvalidArgumentError('Not an address.');
        return value;
    })
    .description('Collect all the funds from the accounts to the provided address')
    .action(collect);

program
    .command('topup')
    .argument('<amount>', 'Amount of SOL to topup', (value) => {
        const parsedValue = parseFloat(value);
        if (isNaN(parsedValue))
            throw new InvalidArgumentError('Not a number.');
        return parsedValue;
    })
    .argument('<keypair_path>', 'Path to the keypair file')
    .alias('t')
    .description('Topup the accounts with SOL using the provided keypair')
    .action((amount, keypair_path) => topup(amount, keypair_path));

program.parse(process.argv);
if (!process.argv.slice(2).length) {
    program.outputHelp();
}