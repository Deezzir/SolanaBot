import figlet from 'figlet';
import { Command, InvalidArgumentError, InvalidOptionArgumentError } from 'commander';
import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { readdir } from 'fs/promises';
import * as common from './common.js';
import * as trade from './trade.js';
import * as run from './run.js';
import dotenv from 'dotenv'
import { existsSync, readFileSync } from 'fs';
import * as readline from 'readline';
import path from 'path';
dotenv.config();

const KEYS_DIR = process.env.KEYS_DIR || './keys';
const RESERVE_KEY_PATH = path.join(KEYS_DIR, process.env.RESERVE_KEY_PATH || 'key0.json');
const META_UPDATE_INTERVAL = 5000;

var KEYS_CNT = 0;
var WORKERS = new Array<common.WorkerPromise>();
var BOT_CONFIG: common.BotConfig
var START_COLLECT = false;

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
        const balance = await trade.get_balance(keypair.publicKey) / LAMPORTS_PER_SOL;
        common.log(`File: ${file.padEnd(10, ' ')} | Address: ${keypair.publicKey.toString().padEnd(44, ' ')} | Balance: ${balance.toFixed(9)} SOL ${key_path === RESERVE_KEY_PATH ? '| (Reserve)' : ''}`);
    }
}

async function buy_once(amount: number, mint: PublicKey, keypair_path: string) {
    common.log(`Buying ${amount} SOL of the token with mint ${mint.toString()}...`);

    let payer: Keypair;
    try {
        payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypair_path, 'utf8'))));
        const balance = await trade.get_balance(payer.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Payer address: ${payer.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`);
    } catch (err) {
        common.log_error('[ERROR] Failed to process payer file');
        return;
    }

    const mint_meta = await run.fetch_mint(mint.toString());
    if (Object.keys(mint_meta).length === 0) {
        common.log_error('[ERROR] Mint metadata not found.');
        return;
    }
    const signature = await trade.buy_token(amount, payer, mint_meta, 0.05, true);
    common.log(`Transaction completed, signature: ${signature}`);
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
        const amount = await trade.get_balance(sender.publicKey);
        if (amount === 0) continue;

        common.log(`Collecting ${amount / LAMPORTS_PER_SOL} SOL from ${sender.publicKey.toString().padEnd(44, ' ')} (${file})...`);
        transactions.push(trade.send_lamports(amount, sender, receiver, true)
            .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
            .catch(error => common.log_error(`Transaction failed for ${file}, error: ${error.message}`)));
    }

    await Promise.allSettled(transactions);
}

async function collect_token(mint: PublicKey, receiver: PublicKey) {
    common.log(`Collecting all the tokens from the accounts to ${receiver}...`);
    const reserve = common.get_key(RESERVE_KEY_PATH);
    if (!reserve) throw new Error('Unreachable');

    try {
        const reserve_keypair = Keypair.fromSecretKey(reserve);
        const receiver_assoc_addr = await trade.create_assoc_token_account(reserve_keypair, receiver, mint);

        let transactions = [];
        const files = common.natural_sort(await readdir(KEYS_DIR));
        for (const file of files) {
            const key = common.get_key(path.join(KEYS_DIR, file));
            if (!key) continue;

            const sender = Keypair.fromSecretKey(key);
            const token_amount = await trade.get_token_balance(sender.publicKey, mint);
            const token_amount_raw = parseInt(token_amount.amount);
            if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) continue;
            const sender_accoc_addr = await trade.calc_assoc_token_addr(sender.publicKey, mint);

            common.log(`Collecting ${token_amount.uiAmount} tokens from ${sender.publicKey.toString().padEnd(44, ' ')} (${file})...`);
            transactions.push(trade.send_tokens(token_amount_raw, sender_accoc_addr, receiver_assoc_addr, sender, true)
                .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
                .catch(error => common.log_error(`Transaction failed for ${file}, error: ${error.message}`)));
        }

        await Promise.allSettled(transactions);
    } catch (error) {
        common.log_error(`[ERROR] ${error}`);
    }
}

async function sell_token(mint: PublicKey) {
    common.log(`Selling all the tokens by the mint ${mint.toString()}...`);

    const mint_meta = await run.fetch_mint(mint.toString());
    if (Object.keys(mint_meta).length === 0) {
        common.log_error('[ERROR] Mint metadata not found.');
        return;
    }

    try {
        let transactions = [];
        const files = common.natural_sort(await readdir(KEYS_DIR));
        for (const file of files) {
            const key = common.get_key(path.join(KEYS_DIR, file));
            if (!key) continue;

            const seller = Keypair.fromSecretKey(key);
            const token_amount = await trade.get_token_balance(seller.publicKey, mint);
            if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) continue;

            common.log(`Selling ${token_amount.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')} (${file})...`);
            transactions.push(trade.sell_token(token_amount, seller, mint_meta, 0.5, true)
                .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
                .catch(error => common.log_error(`Transaction failed for ${file}, error: ${error.message}`)));
        }

        await Promise.allSettled(transactions);
    } catch (error) {
        common.log_error(`[ERROR] ${error}`);
    }
}

async function topup(amount: number, keypair_path: string, from?: number, to?: number) {
    if (KEYS_CNT === 0) {
        common.log_error('[ERROR] No keys available.');
        return;
    }
    const count = to ? to - (from || 0) : KEYS_CNT - (from || 0);
    common.log(`Topping up ${amount} SOL to ${count} keys...`);

    let payer: Keypair;
    try {
        payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypair_path, 'utf8'))));
        const balance = await trade.get_balance(payer.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Payer address: ${payer.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`);
        if (balance < amount * count) {
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
        transactions.push(trade.send_lamports(amount * LAMPORTS_PER_SOL, payer, receiver.publicKey, true)
            .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
            .catch(error => common.log_error(`Transaction failed for ${file}, error: ${error.message}`)));
    }
    await Promise.allSettled(transactions);
}

async function start() {
    const worker_update_mint = async (workers: common.WorkerPromise[], mint: string) => {
        const mint_meta = await run.fetch_mint(mint);
        if (Object.keys(mint_meta).length !== 0) {
            common.log(`[Main Worker] Currecnt MCAP: $${mint_meta.usd_market_cap.toFixed(3)}`);
            run.worker_post_message(workers, 'mint', mint_meta);
        }
    }

    common.log('[Main Worker] Starting the bot...');
    await run.start_workers(BOT_CONFIG, WORKERS, KEYS_DIR);

    try {
        const mint = BOT_CONFIG.mint ? BOT_CONFIG.mint : await run.wait_drop_sub(BOT_CONFIG.token_name, BOT_CONFIG.token_ticker);
        if (mint) {
            BOT_CONFIG.mint = mint;
            common.log(`[Main Worker] Token detected: ${BOT_CONFIG.mint.toString()}`);

            await worker_update_mint(WORKERS, BOT_CONFIG.mint.toString());
            const interval = setInterval(async () => { if (BOT_CONFIG.mint) worker_update_mint(WORKERS, BOT_CONFIG.mint.toString()) }, META_UPDATE_INTERVAL);

            setTimeout(() => { run.worker_post_message(WORKERS, 'buy') }, 3000);
            await run.wait_for_workers(WORKERS);
            clearInterval(interval);

            if (START_COLLECT)
                await collect_token(BOT_CONFIG.mint, BOT_CONFIG.collect_address);
        } else {
            common.log_error('[ERROR] Token not found. Exiting...');
            global.rl.close();
        }
    } catch (error) {
        common.log_error(`[ERROR] ${error}`);
        global.rl.close();
    }
}

function setup_readline() {
    global.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
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
    common.log('\n');

    program
        .version('1.0.0')
        .description('Solana Buy Bot CLI');

    program
        .command('start')
        .alias('s')
        .description('Start the bot')
        .option('-c, --config <path>', 'Path to the JSON config file', (value) => {
            if (!existsSync(value))
                throw new InvalidOptionArgumentError('Config file does not exist.');
            const json = common.read_json(value);
            if (!json) throw new InvalidOptionArgumentError('Invalid JSON format.');
            return json as common.BotConfig;
        })
        .action(async (options) => {
            let selling = false;
            let stopping = false;
            let { config } = options;

            if (config) {

                config.collect_address = new PublicKey(config.collect_address);
                config.mint = new PublicKey(config.mint);
                BOT_CONFIG = config;
                console.table(common.BotConfigDisplay(BOT_CONFIG));
                setup_readline();
                await new Promise<void>(resolve => global.rl.question('Press ENTER to start the bot...', () => resolve()));
            } else {
                BOT_CONFIG = await run.get_config(KEYS_CNT);
                common.clear_lines_up(1);
                if (!BOT_CONFIG) return;
            }

            if (global.rl === undefined) setup_readline();
            global.rl.setPrompt('Command (stop/config/collect/sell/set)> ');
            global.rl.prompt(true);

            global.rl.on('line', async (line) => {
                readline.moveCursor(process.stdout, 0, -1);
                readline.clearLine(process.stdout, 0);
                switch (line.trim().split(' ')[0]) {
                    case 'stop':
                        if (!stopping) {
                            if (WORKERS.length > 0) {
                                run.worker_post_message(WORKERS, 'stop');
                                stopping = true;
                            }
                        } else {
                            common.log('[Main Worker] Stopping is already in progress...');
                        }
                        break;
                    case 'config':
                        if (BOT_CONFIG !== undefined)
                            console.table(common.BotConfigDisplay(BOT_CONFIG));
                        break;
                    case 'collect':
                        if (!START_COLLECT) {
                            run.worker_post_message(WORKERS, 'collect');
                            START_COLLECT = true;
                        } else {
                            common.log('[Main Worker] Collecting is already in progress...');
                        }
                        break;
                    case 'sell':
                        if (!selling) {
                            if (WORKERS.length > 0) {
                                run.worker_post_message(WORKERS, 'sell');
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
                        common.update_bot_config(BOT_CONFIG, key, value);
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
        .option('-r, --reserve', 'Collect from the reserve account as well')
        .description('Collect all the SOL from the accounts to the provided address')
        .action(collect);

    program
        .command('spl-buy-once')
        .alias('bt')
        .argument('<amount>', 'Amount to buy in SOL', (value) => {
            const parsedValue = parseFloat(value);
            if (isNaN(parsedValue))
                throw new InvalidArgumentError('Not a number.');
            return parsedValue;
        })
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<keypair_path>', 'Path to the keypair file')
        .description('Buy the token once with the provided amount')
        .action(buy_once);

    program
        .command('spl-sell')
        .alias('ct')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .description('Sell all the token by the mint from the accounts to the market')
        .action(sell_token);

    program
        .command('spl-collect')
        .alias('ct')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<address>', 'Public address of the receiver', (value) => {
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