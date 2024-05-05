import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { readdir } from 'fs/promises';
import * as common from './common.js';
import * as trade from './trade.js';
import * as run from './run.js';
import dotenv from 'dotenv'
import { readFileSync } from 'fs';
import path from 'path';
import { exit } from 'process';
dotenv.config({ path: './.env' });

export async function promote(count: number, cid: string, keypair_path: string) {
    common.log(`Promoting ${count} accounts with CID ${cid}...\n`);

    let creator: Keypair;
    let meta: common.IPFSMetadata;
    try {
        creator = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypair_path, 'utf8'))));
        const balance = await trade.get_balance(creator.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Buyer address: ${creator.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL`);

        meta = await common.fetch_ipfs_json(cid) as common.IPFSMetadata;
        common.log(`Token name: ${meta.name} | Symbol: ${meta.symbol}\n`);
    } catch (err) {
        common.log_error('[ERROR] Failed to process: ' + err);
        return;
    }

    let transactions = [];
    for (let i = 0; i < count; i++) {
        transactions.push(trade.create_token(creator, meta, cid, true)
            .then(([sig, mint]) => common.log(`Signature: ${sig.toString().padEnd(88, ' ')} | Mint: ${mint}`))
            .catch(error => common.log_error(`Transaction failed, error: ${error.message}`)));
    }
    await Promise.allSettled(transactions);
}

export async function spl_balance(mint: PublicKey, keys_cnt: number) {
    try {
        common.log(`Getting the token balance of the keys by the mint ${mint.toString()}...`);
        const [token_name, token_symbol] = await trade.get_token_meta(mint);
        common.log(`Token name: ${token_name} | Symbol: ${token_symbol}\n`);

        if (keys_cnt === 0) {
            common.log_error('[ERROR] No keys available.');
            return;
        }
        let total = 0;
        const files = common.natural_sort(await readdir(trade.KEYS_DIR));
        for (const file of files) {
            const key_path = path.join(trade.KEYS_DIR, file)
            const key = common.get_key(key_path);
            if (!key) continue;

            const keypair = Keypair.fromSecretKey(key);
            const balance = await trade.get_token_balance(keypair.publicKey, mint);
            const ui_balance = balance.uiAmount || 0;
            total += ui_balance;
            common.log(`File: ${file.padEnd(10, ' ')} | Address: ${keypair.publicKey.toString().padEnd(44, ' ')} | Balance: ${ui_balance.toFixed(2)} ${token_symbol} ${key_path === trade.RESERVE_KEY_PATH ? '| (Reserve)' : ''}`);
        }
        const supply = parseInt((await trade.get_token_supply(mint)).toString());
        const allocation = (total / (supply / 1_000_000)) * 100;

        common.log(`\nTotal balance: ${total} ${token_symbol}`);
        common.log(`Total allocation: ${allocation.toFixed(2)}%`);
    } catch (error) {
        common.log_error(`[ERROR] ${error}`);
    }
}

export async function transfer_sol(amount: number, receiver: PublicKey, sender_path: string) {
    common.log(`Transferring ${amount} SOL from ${sender_path} to ${receiver.toString()}...`);
    const sender = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(sender_path, 'utf8'))));
    const balance = await trade.get_balance(sender.publicKey);
    if (balance < amount * LAMPORTS_PER_SOL) {
        common.log_error(`[ERROR] Sender balance is not enough to transfer ${amount} SOL`);
        return;
    }

    trade.send_lamports(amount * LAMPORTS_PER_SOL, sender, receiver, true)
        .then(signature => common.log(`Transaction completed, signature: ${signature}`))
        .catch(error => common.log_error(`Transaction failed, error: ${error.message}`));
}

export async function balance(keys_cnt: number) {
    common.log('Getting the balance of the keys...\n');
    if (keys_cnt === 0) {
        common.log_error('[ERROR] No keys available.');
        return;
    }
    let total = 0;
    const files = common.natural_sort(await readdir(trade.KEYS_DIR));
    for (const file of files) {
        const key_path = path.join(trade.KEYS_DIR, file)
        const key = common.get_key(key_path);
        if (!key) continue;

        const keypair = Keypair.fromSecretKey(key);
        const balance = await trade.get_balance(keypair.publicKey) / LAMPORTS_PER_SOL;
        total += balance;
        common.log(`File: ${file.padEnd(10, ' ')} | Address: ${keypair.publicKey.toString().padEnd(44, ' ')} | Balance: ${balance.toFixed(9)} SOL ${key_path === trade.RESERVE_KEY_PATH ? '| (Reserve)' : ''}`);
    }

    common.log(`\nTotal balance: ${total} SOL`);
}

export async function sell_token_once(mint: PublicKey, keypair_path: string) {
    common.log(`Selling all the tokens by the mint ${mint.toString()}...`);

    let seller: Keypair;
    try {
        seller = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypair_path, 'utf8'))));
        const balance = await trade.get_balance(seller.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Seller address: ${seller.publicKey.toString()} | Balance: ${balance.toFixed(2)} SOL`);
    } catch (err) {
        common.log_error('[ERROR] Failed to process seller file');
        return;
    }

    const mint_meta = await trade.fetch_mint(mint.toString());
    if (Object.keys(mint_meta).length === 0) {
        common.log_error('[ERROR] Mint metadata not found.');
        return;
    }
    const token_amount = await trade.get_token_balance(seller.publicKey, mint);
    if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) {
        common.log_error('[ERROR] No tokens to sell');
        return;
    }

    common.log(`Selling ${token_amount.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')}...`);
    trade.sell_token(token_amount, seller, mint_meta, 0.01, 0.5, true)
        .then(signature => common.log(`Transaction completed, signature: ${signature}`))
        .catch(error => common.log_error(`Transaction failed, error: ${error.message}`));
}

export async function buy_token_once(amount: number, mint: PublicKey, keypair_path: string) {
    common.log(`Buying ${amount} SOL of the token with mint ${mint.toString()}...`);

    let payer: Keypair;
    try {
        payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypair_path, 'utf8'))));
        const balance = await trade.get_balance(payer.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Buyer address: ${payer.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL`);
    } catch (err) {
        common.log_error('[ERROR] Failed to process payer file');
        return;
    }

    const mint_meta = await trade.fetch_mint(mint.toString());
    if (Object.keys(mint_meta).length === 0) {
        common.log_error('[ERROR] Mint metadata not found.');
        return;
    }
    const signature = await trade.buy_token(amount, payer, mint_meta, 0.001, 0.05, true);
    common.log(`Transaction completed, signature: ${signature}`);
}

export async function warmup(keys_cnt: number, from?: number, to?: number, list?: number[]) {
    if (keys_cnt === 0) {
        common.log_error('[ERROR] No keys available.');
        return;
    }

    const counts = Array.from({ length: keys_cnt }, () => Math.floor(Math.random() * (35 - 10) + 10));
    const acc_count = list ? list.length : (to ? to - (from || 0) : keys_cnt - (from || 0));

    common.log(`Warming up ${acc_count} accounts...`);

    let files = common.natural_sort(await readdir(trade.KEYS_DIR));
    files = list ? files.filter((_, index) => list.includes(index)) : files.slice(from, to)

    for (const [index, file] of files.entries()) {
        const key = common.get_key(path.join(trade.KEYS_DIR, file));
        if (!key) continue;
        const buyer = Keypair.fromSecretKey(key);
        const mints = (await trade.fetch_random_mints(counts[index])).filter(i => !i.market_id);

        common.log(`Warming up ${buyer.publicKey.toString().padEnd(44, ' ')} with ${counts[index]} tokens (${file})...`);
        for (const mint_meta of mints) {
            const amount = parseFloat(common.normal_random(0.01, 0.001).toFixed(4));
            common.log(`Buying ${amount} SOL of the token '${mint_meta.name}' with mint ${mint_meta.mint}...`);
            while (true) {
                try {
                    const signature = await trade.buy_token(amount, buyer, mint_meta, 0.001, 0.5, true);
                    common.log(`Transaction completed for ${file}, signature: ${signature}`);
                    break;
                } catch (e) {
                    // common.log(`Error buying the token, retrying...`);
                }
            }
            setTimeout(() => { }, 3000);
            let twice = false;
            while (true) {
                try {
                    const balance = await trade.get_token_balance(buyer.publicKey, new PublicKey(mint_meta.mint));
                    if (balance.uiAmount === 0 || balance.uiAmount === null) {
                        common.log(`No tokens to sell for ${file} and mint ${mint_meta.mint}`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        if (twice) break;
                        twice = true;
                        continue;
                    }
                    common.log(`Selling ${balance.uiAmount} '${mint_meta.name}' tokens (${file})...`);
                    const signature = await trade.sell_token(balance, buyer, mint_meta, 0.001, 0.5, true);
                    common.log(`Transaction completed for ${file}, signature: ${signature}`);
                    break;
                } catch (e) {
                    // common.log(`Error selling the token, retrying...`);
                }
            }
        }
    }
}

export async function collect(address: PublicKey, reserve: boolean) {
    common.log(`Collecting all the SOL from the accounts to ${address}...`);
    const receiver = new PublicKey(address);
    common.log(`Receiver address: ${receiver.toString()}\n`);

    let transactions = [];
    const files = common.natural_sort(await readdir(trade.KEYS_DIR));
    for (const file of files) {
        const file_path = path.join(trade.KEYS_DIR, file);
        const key = common.get_key(file_path);
        if (!key) continue;
        if (reserve && file_path === trade.RESERVE_KEY_PATH) continue;

        const sender = Keypair.fromSecretKey(key);
        const amount = await trade.get_balance(sender.publicKey);
        if (amount === 0 || address === sender.publicKey) continue;

        common.log(`Collecting ${amount / LAMPORTS_PER_SOL} SOL from ${sender.publicKey.toString().padEnd(44, ' ')} (${file})...`);
        transactions.push(trade.send_lamports(amount, sender, receiver, true)
            .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
            .catch(error => common.log_error(`Transaction failed for ${file}, error: ${error.message}`)));
    }

    await Promise.allSettled(transactions);
}

export async function collect_token(mint: PublicKey, receiver: PublicKey) {
    common.log(`Collecting all the tokens from the accounts to ${receiver}...`);
    const reserve = common.get_key(trade.RESERVE_KEY_PATH);
    if (!reserve) throw new Error('Unreachable');

    try {
        const reserve_keypair = Keypair.fromSecretKey(reserve);
        const receiver_assoc_addr = await trade.create_assoc_token_account(reserve_keypair, receiver, mint);

        let transactions = [];
        const files = common.natural_sort(await readdir(trade.KEYS_DIR));
        for (const file of files) {
            const key = common.get_key(path.join(trade.KEYS_DIR, file));
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

export async function sell_token(mint: PublicKey, list?: number[]) {
    common.log(`Selling all the tokens from the accounts by the mint ${mint.toString()}...\n`);

    const mint_meta = await trade.fetch_mint(mint.toString());
    if (Object.keys(mint_meta).length === 0) {
        common.log_error('[ERROR] Mint metadata not found.');
        return;
    }

    try {
        let transactions = [];
        let files = common.natural_sort(await readdir(trade.KEYS_DIR)).slice(1);
        files = list ? files.filter((_, index) => list.includes(index + 1)) : files;
        for (const file of files) {
            const key = common.get_key(path.join(trade.KEYS_DIR, file));
            if (!key) continue;

            const seller = Keypair.fromSecretKey(key);
            const token_amount = await trade.get_token_balance(seller.publicKey, mint);
            if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) continue;

            common.log(`Selling ${token_amount.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')} (${file})...`);
            if (mint_meta.raydium_pool === null) {
                transactions.push(trade.sell_token(token_amount, seller, mint_meta, 0.1, 0.5, true)
                    .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
                    .catch(error => common.log_error(`Transaction failed for ${file}, error: ${error.message}`)));
            } else {
                transactions.push(trade.swap_jupiter(token_amount, seller, mint_meta, 0.5, false)
                    .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
                    .catch(error => common.log_error(`Transaction failed for ${file}, error: ${error.message}`)));
            }
        }

        await Promise.allSettled(transactions);
    } catch (error) {
        common.log_error(`[ERROR] ${error}`);
    }
}

export async function topup(amount: number, keypair_path: string, keys_cnt: number, from?: number, to?: number, list?: number[]) {
    if (keys_cnt === 0) {
        common.log_error('[ERROR] No keys available.');
        return;
    }
    const acc_count = list ? list.length : (to ? to - (from || 0) : keys_cnt - (from || 0));
    common.log(`Topping up ${amount} SOL to ${acc_count} keys...`);

    let payer: Keypair;
    try {
        payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypair_path, 'utf8'))));
        const balance = await trade.get_balance(payer.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Payer address: ${payer.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`);
        if (balance < amount * acc_count) {
            common.log_error(`[ERROR] Payer balance is not enough to topup ${amount} SOL to ${keys_cnt} keys`);
            return;
        }
    } catch (err) {
        common.log_error(`[ERROR] Failed to process payer file: ${err}`);
        return;
    }

    let transactions = [];
    let files = common.natural_sort(await readdir(trade.KEYS_DIR));
    files = list ? files.filter((_, index) => list.includes(index)) : files.slice(from, to)

    for (const file of files) {
        const key = common.get_key(path.join(trade.KEYS_DIR, file));
        if (!key) continue;
        const receiver = Keypair.fromSecretKey(key);
        common.log(`Sending ${amount} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')} (${file})...`);
        transactions.push(trade.send_lamports(amount * LAMPORTS_PER_SOL, payer, receiver.publicKey, false, true)
            .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
            .catch(error => common.log_error(`Transaction failed for ${file}, error: ${error.message}`)));
    }
    await Promise.allSettled(transactions);
}

const META_UPDATE_INTERVAL = 1000;

export async function start(bot_config: common.BotConfig, workers: common.WorkerPromise[]) {
    const worker_update_mint = async (workers: common.WorkerPromise[], mint: PublicKey) => {
        const mint_meta = await trade.fetch_mint(mint.toString());
        mint_meta.total_supply = await trade.get_token_supply(mint);
        if (Object.keys(mint_meta).length !== 0) {
            common.log(`[Main Worker] Currecnt MCAP: $${mint_meta.usd_market_cap.toFixed(3)}`);
            run.worker_post_message(workers, 'mint', mint_meta);
        }
    }

    common.log('[Main Worker] Starting the bot...');
    await run.start_workers(bot_config, workers, trade.KEYS_DIR);

    try {
        const timestamp = Date.now();
        const mint = bot_config.mint ? bot_config.mint : await run.wait_drop_sub(bot_config.token_name, bot_config.token_ticker, timestamp);
        if (mint) {
            bot_config.mint = mint;
            common.log(`[Main Worker] Token detected: ${bot_config.mint.toString()}`);
            exit(0);

            // @ts-ignore
            await worker_update_mint(workers, bot_config.mint);
            const interval = setInterval(async () => { if (bot_config.mint) worker_update_mint(workers, bot_config.mint) }, META_UPDATE_INTERVAL);

            setTimeout(() => { run.worker_post_message(workers, 'buy') }, 500);
            await run.wait_for_workers(workers);
            clearInterval(interval);

            if (global.START_COLLECT)
                // @ts-ignore
                await collect_token(bot_config.mint, bot_config.collect_address);
        } else {
            common.log_error('[ERROR] Token not found. Exiting...');
            global.rl.close();
        }
    } catch (error) {
        common.log_error(`[ERROR] ${error}`);
        global.rl.close();
    }
}