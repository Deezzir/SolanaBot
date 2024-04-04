import figlet from 'figlet';
import { Command, InvalidArgumentError, InvalidOptionArgumentError } from 'commander';
import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { readdir } from 'fs/promises';
import * as common from './common.js';
import { start_workers, wait_for_workers, worker_post_message, worker_update_mint } from './start.js';
import dotenv from 'dotenv'
import { existsSync, fstat, readFileSync } from 'fs';
import * as readline from 'readline';
import path from 'path';

dotenv.config();
const KEYS_DIR = process.env.KEYS_DIR || './keys';
const RESERVE_KEY_PATH = path.join(KEYS_DIR, process.env.RESERVE_KEY_PATH || 'key0.json');
var KEYS_CNT = 0;

let workers = new Array<common.WorkerPromise>();
let config: common.BotConfig;

async function balance() {
    common.log('Getting the balance of the keys...');
    if (KEYS_CNT === 0) {
        common.log_error('[ERROR] No keys available.');
        return;
    }
    const files = common.natural_sort(await readdir(KEYS_DIR));
    for (const file of files) {
        const key_path = path.join(KEYS_DIR, file)
        const key = common.get_key(key_path);
        if (!key) continue;

        const keypair = Keypair.fromSecretKey(key);
        const balance = await common.get_balance(keypair.publicKey) / LAMPORTS_PER_SOL;
        common.log(`File: ${file.padEnd(10, ' ')} | Address: ${keypair.publicKey.toString().padEnd(44, ' ')} | Balance: ${balance.toFixed(9)} SOL ${key_path === RESERVE_KEY_PATH ? '| (Reserve)' : ''}`);
    }
}

async function warmup() {
    common.log('TODO: Warmup the accounts with the tokens');
}

async function collect(address: PublicKey, reserve: boolean) {
    common.log(`Collecting all the funds from the accounts to ${address}...`);
    const receiver = new PublicKey(address);
    common.log(`Receiver address: ${receiver.toString()}\n`);

    let transactions = [];
    const files = common.natural_sort(await readdir(KEYS_DIR));
    for (const file of files) {
        const file_path = path.join(KEYS_DIR, file);
        const key = common.get_key(file_path);
        if (!key) continue;
        if (reserve && file_path === RESERVE_KEY_PATH) continue;

        const sender = Keypair.fromSecretKey(key);
        const amount = await common.get_balance(sender.publicKey);
        if (amount === 0) continue;

        common.log(`Collecting ${amount / LAMPORTS_PER_SOL} SOL from ${sender.publicKey.toString().padEnd(44, ' ')} (${file})...`);
        transactions.push(common.send_lamports(amount, sender, receiver, true)
            .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
            .catch(error => common.log_error(`Transaction failed for ${file}, error: ${error.message}`)));
    }

    await Promise.allSettled(transactions);
}

async function collect_token(mint: PublicKey, receiver: PublicKey) {
    common.log(`Collecting all the tokens from the accounts to ${receiver}...`);
    const reserve = common.get_key(RESERVE_KEY_PATH);
    if (!reserve) throw new Error('Unreachable');

    const reserve_keypair = Keypair.fromSecretKey(reserve);
    const receiver_assoc_addr = await common.create_assoc_token_account(reserve_keypair, receiver, mint);

    let transactions = [];
    const files = common.natural_sort(await readdir(KEYS_DIR));
    for (const file of files) {
        const key = common.get_key(path.join(KEYS_DIR, file));
        if (!key) continue;

        const sender = Keypair.fromSecretKey(key);
        const token_amount = await common.get_token_balance(sender.publicKey, mint);
        const token_amount_raw = parseInt(token_amount.amount);
        if (token_amount.uiAmount === 0) continue;

        common.log(`Collecting ${token_amount.uiAmount} tokens from ${sender.publicKey.toString().padEnd(44, ' ')} (${file})...`);
        transactions.push(common.send_tokens(token_amount_raw, sender, receiver_assoc_addr, receiver)
            .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
            .catch(error => common.log_error(`Transaction failed for ${file}, error: ${error.message}`)));
    }

    await Promise.allSettled(transactions);
}

async function topup(amount: number, keypair_path: string, from?: number, to?: number) {
    if (KEYS_CNT === 0) {
        common.log_error('[ERROR] No keys available.');
        return;
    }
    const cnt = to ? to - (from || 0) : KEYS_CNT - (from || 0);
    common.log(`Topping up ${amount} SOL to ${cnt} keys...`);

    let payer: Keypair;
    try {
        payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypair_path, 'utf8'))));
        const balance = await common.get_balance(payer.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Payer address: ${payer.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`);
        if (balance < amount * cnt) {
            common.log_error(`[ERROR] Payer balance is not enough to topup ${amount} SOL to ${KEYS_CNT} keys`);
            return;
        }
    } catch (err) {
        common.log_error('[ERROR] Failed to process payer file');
        return;
    }

    let transactions = [];
    let files = common.natural_sort(await readdir(KEYS_DIR));
    files = files.slice(from, to)

    for (const file of files) {
        const key = common.get_key(path.join(KEYS_DIR, file));
        if (!key) continue;
        const receiver = Keypair.fromSecretKey(key);
        common.log(`Sending ${amount} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')} (${file})...`);
        transactions.push(common.send_lamports(amount * LAMPORTS_PER_SOL, payer, receiver.publicKey)
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
        thread_cnt: 2,
        buy_interval: 15,
        spend_limit: 0.01,
        start_buy: 0.002,
        return_pubkey: new PublicKey('Br92m2KTeo4mUKGF4dkdPPRipzhM9rAtxZMbwGvKyNd1'),
        mcap_threshold: 50000,
        token_name: 'CAT TIME',
        token_ticker: 'CT',
        mint: new PublicKey('8wYD3muJov9EkE9TZssPQrGZggUWMP2GZ14RfjV1E37c')
    };

    common.log('[Main Worker] Starting the bot...');
    await start_workers(config, workers, KEYS_DIR);
    // wait_drop_sub(config.token_name, config.token_ticker, mint);
    if (config.mint) {
        common.log(`Token detected: ${config.mint.toString()}`);
        worker_update_mint(workers, config.mint.toString());
        setInterval(async () => { worker_update_mint(workers, config.mint.toString()) }, 5000);
        setTimeout(() => { worker_post_message(workers, 'buy') }, 3000);
        await wait_for_workers(workers);
    } else {
        common.log_error('[ERROR] Token not found. Exiting...');
        global.rl.close();
    }
}

//------------------------------------------------------------
// MAIN
// -----------------------------------------------------------


async function main() {
    if (!existsSync(RESERVE_KEY_PATH))
        throw new Error("No reserve key available. Please create the 'key0.json' first.");

    KEYS_CNT = await common.count_keys(KEYS_DIR) - 1;
    global.connection = new Connection(process.env.RPC || '', 'confirmed');
    const program = new Command();

    common.log(figlet.textSync('Solana Buy Bot', { horizontalLayout: 'full' }));

    program
        .version('1.0.0')
        .description('Solana Buy Bot CLI');

    program
        .command('start')
        .alias('s')
        .description('Start the bot')
        .action(async () => {
            global.rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            global.rl.setPrompt('Command (stop/config)> ');
            global.rl.prompt(true);

            global.rl.on('line', async (line) => {
                readline.moveCursor(process.stdout, 0, -1);
                readline.clearLine(process.stdout, 0);
                switch (line.trim()) {
                    case 'stop':
                        if (workers.length > 0)
                            worker_post_message(workers, 'stop');
                        break;
                    case 'config':
                        if (config !== undefined)
                            console.table(config);
                        break;
                    case 'collect':
                        worker_post_message(workers, 'collect');
                        collect_token(config.mint, config.return_pubkey);
                        break;
                    case 'sell':
                        worker_post_message(workers, 'sell');
                        break;
                    default:
                        common.log(`Unknown command: ${line.trim()}`);
                        break;
                }
                global.rl.prompt(true);
            }).on('close', () => {
                common.log('[Main Worker] Stopping the bot...');
                readline.cursorTo(process.stdout, 0);
                readline.clearLine(process.stdout, 0);
                process.exit(0);
            });
            await start()
            global.rl.close();
        });

    program
        .command('balance')
        .alias('b')
        .description('Get the balance of the accounts')
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
            return new PublicKey(value);
        })
        .option('-r, --reserve', 'Collect from the reserve account')
        .description('Collect all the SOL from the accounts to the provided address')
        .action(collect);

    program
        .command('spl-collect')
        .alias('ct')
        .argument('<address>', 'Public address of the receiver', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .description('Collect all the token by the mint from the accounts to the provided address')
        .action(collect_token);

    program
        .command('topup')
        .argument('<amount>', 'Amount of SOL to topup', (value) => {
            const parsedValue = parseFloat(value);
            if (isNaN(parsedValue))
                throw new InvalidArgumentError('Not a number.');
            return parsedValue;
        })
        .argument('<keypair_path>', 'Path to the keypair file')
        .option('-f, --from <value>', 'Topup starting from the provided index', (value) => {
            if (!common.validate_int(value, 1, KEYS_CNT))
                throw new InvalidOptionArgumentError(`Not a valid range (1-${KEYS_CNT}).`);
            return parseInt(value, 10);
        })
        .option('-t --to <value>', 'Topup ending at the provided index', (value) => {
            if (!common.validate_int(value, 1, KEYS_CNT))
                throw new InvalidOptionArgumentError(`Not a valid range (1-${KEYS_CNT}).`);
            return parseInt(value, 10);
        })
        .alias('t')
        .description('Topup the accounts with SOL using the provided keypair')
        .action((amount, keypair_path, options) => {
            const { from, to } = options;
            topup(amount, keypair_path, from - 1, to);
        });

    program.parse(process.argv);
    if (!process.argv.slice(2).length) {
        program.outputHelp();
    }

}

main().catch(console.error);