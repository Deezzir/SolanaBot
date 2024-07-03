import { Keypair, PublicKey, LAMPORTS_PER_SOL, TokenAmount } from '@solana/web3.js';
import { readdir } from 'fs/promises';
import * as common from './common.js';
import * as trade from './trade.js';
import * as run from './run.js';
import dotenv from 'dotenv'
import { readFileSync } from 'fs';
import path from 'path';
import { Wallet } from '@project-serum/anchor';
dotenv.config({ path: './.env' });

const META_UPDATE_INTERVAL = 1000;

export async function clean(keys_cnt: number): Promise<void> {
    common.log('Cleaning all the accounts...\n');
    if (keys_cnt === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    let files = common.natural_sort(await readdir(trade.KEYS_DIR));
    let unsold_set: string[] = []

    for (const file of files) {
        const key_path = path.join(trade.KEYS_DIR, file);
        const key = common.get_key(key_path);
        if (!key) continue;

        const wallet = new Wallet(Keypair.fromSecretKey(key));

        const balance = await trade.get_balance(wallet.publicKey);
        if (balance === 0) {
            common.error(`No balance for ${wallet.publicKey.toString().padEnd(44, ' ')} (${file}), skipping...`);
            continue;
        }

        common.log(`Cleaning ${wallet.publicKey.toString().padEnd(44, ' ')} (${file})...`);
        const unsold = await trade.close_accounts(wallet);
        if (unsold) unsold_set = [...new Set([...unsold_set, ...unsold.map(i => i.toString())])]
        common.log(`Cleaned`);
    }

    if (unsold_set.length > 0) {
        common.log(`\nUnsold Tokens:`);
        for (const item of unsold_set) {
            common.log(`Mint: ${item}`);
        }
    }
}

export async function create_token(cid: string, keypair_path: string, dev_buy?: number, mint_keypair_path?: string): Promise<void> {
    common.log('Creating a token...\n');

    let mint: Keypair | undefined = undefined;
    let creator: Keypair;
    let meta: common.IPFSMetadata;
    try {
        creator = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypair_path, 'utf8'))));
        const balance = await trade.get_balance(creator.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Dev address: ${creator.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL`);

        if (dev_buy && dev_buy > balance) {
            common.error(`[ERROR] Creator balance is not enough to buy ${dev_buy} SOL`);
            return;
        }

        if (mint_keypair_path) {
            mint = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(mint_keypair_path, 'utf8'))));
            common.log(`Custom Mint address: ${mint.publicKey.toString()}`);
        }

        meta = await common.fetch_ipfs_json(cid) as common.IPFSMetadata;
        common.log(`Token name: ${meta.name} | Symbol: ${meta.symbol}`);
    } catch (err) {
        common.error('[ERROR] Failed to process: ' + err);
        return;
    }

    common.log(`Token Meta: ${JSON.stringify(meta, null, 2)}`)
    console.log(`Dev Buy: ${dev_buy || 0}\n`);

    try {
        const [sig, mint_addr] = await trade.create_token_with_buy(creator, meta, cid, mint, dev_buy)
        common.log(`Token created | Signature: ${sig}`);
        common.log(`Mint address: ${mint_addr}`);
    } catch (err) {
        common.error('[ERROR] Failed to create token: ' + err);
    }
}

export async function promote(times: number, cid: string, keypair_path: string): Promise<void> {
    common.log(`Promoting ${times} accounts with CID ${cid}...\n`);

    let creator: Keypair;
    let meta: common.IPFSMetadata;
    try {
        creator = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypair_path, 'utf8'))));
        const balance = await trade.get_balance(creator.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Creator address: ${creator.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL`);

        meta = await common.fetch_ipfs_json(cid) as common.IPFSMetadata;
        common.log(`Token name: ${meta.name} | Symbol: ${meta.symbol}\n`);
    } catch (err) {
        common.error('[ERROR] Failed to process: ' + err);
        return;
    }

    let count = times;
    let transactions = [];

    while (count > 0) {
        transactions.push(trade.create_token(creator, meta, cid)
            .then(([sig, mint]) => common.log(`Signature: ${sig.toString().padEnd(88, ' ')} | Mint: ${mint}`))
            .catch(error => common.error(`Transaction failed: ${error.message}`)));

        count--;
        await common.sleep(100);
    }

    await Promise.allSettled(transactions);
}

export async function spl_balance(mint: PublicKey, keys_cnt: number): Promise<void> {
    try {
        common.log(`Getting the token balance of the keys by the mint ${mint.toString()}...`);
        const { token_name, token_symbol } = await trade.get_token_meta(mint);
        common.log(`Token name: ${token_name} | Symbol: ${token_symbol}\n`);

        if (keys_cnt === 0) {
            common.error('[ERROR] No keys available.');
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
        common.error(`[ERROR] ${error}`);
    }
}

export async function transfer_sol(amount: number, receiver: PublicKey, sender_path: string): Promise<void> {
    common.log(`Transferring ${amount} SOL from ${sender_path} to ${receiver.toString()}...`);
    const sender = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(sender_path, 'utf8'))));
    const balance = await trade.get_balance(sender.publicKey);
    if (balance < amount * LAMPORTS_PER_SOL) {
        common.error(`[ERROR] Sender balance is not enough to transfer ${amount} SOL`);
        return;
    }
    trade.send_lamports(amount * LAMPORTS_PER_SOL, sender, receiver, common.PriorityLevel.VERY_HIGH)
        .then(signature => common.log(`Transaction completed, signature: ${signature}`))
        .catch(error => common.error(`Transaction failed: ${error.message}`));
}

export async function balance(keys_cnt: number): Promise<void> {
    common.log('Getting the balance of the keys...\n');
    if (keys_cnt === 0) {
        common.error('[ERROR] No keys available.');
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

export async function sell_token_once(mint: PublicKey, keypair_path: string): Promise<void> {
    common.log(`Selling the token by the mint ${mint.toString()}...`);

    let seller: Keypair;
    try {
        seller = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypair_path, 'utf8'))));
        const balance = await trade.get_token_balance(seller.publicKey, mint);
        common.log(`Seller address: ${seller.publicKey.toString()} | Balance: ${balance.uiAmount || 0} tokens\n`);
    } catch (err) {
        common.error('[ERROR] Failed to process seller file');
        return;
    }

    const mint_meta = await common.fetch_mint(mint.toString());
    if (Object.keys(mint_meta).length === 0) {
        common.error('[ERROR] Mint metadata not found.');
        return;
    }
    const token_amount = await trade.get_token_balance(seller.publicKey, mint);
    if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) {
        common.error('[ERROR] No tokens to sell');
        return;
    }

    common.log(`Selling ${token_amount.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')}...`);

    if (mint_meta.raydium_pool === null) {
        trade.sell_token(token_amount, seller, mint_meta, 0.5)
            .then(signature => common.log(`Transaction completed, signature: ${signature}`))
            .catch(error => common.error(`Transaction failed: ${error.message}`));
    } else {
        let success = false;
        const amm = new PublicKey(mint_meta.raydium_pool);
        trade.swap_raydium(token_amount, seller, amm, trade.SOL_MINT, 1.5)
            .then(signature => {
                common.log(`Raydium Transaction completed, signature: ${signature}`);
                success = true;
            })
            .catch(error => {
                common.error(`Raydium Transaction failed: ${error.message}`);
                return trade.swap_jupiter(token_amount, seller, mint, trade.SOL_MINT, 0.5);
            })
            .then(signature => {
                if (!success) common.log(`Jupiter Transaction completed, signature: ${signature}`);
            })
            .catch(error => {
                if (!success) common.error(`Jupiter Transaction failed: ${error.message}`)
            })
    }
}

export async function buy_token_once(amount: number, mint: PublicKey, keypair_path: string): Promise<void> {
    common.log(`Buying ${amount} SOL of the token with mint ${mint.toString()}...`);

    let buyer: Keypair;
    try {
        buyer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypair_path, 'utf8'))));
        const balance = await trade.get_balance(buyer.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Buyer address: ${buyer.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`);
    } catch (err) {
        common.error('[ERROR] Failed to process payer file');
        return;
    }

    const mint_meta = await common.fetch_mint(mint.toString());
    if (Object.keys(mint_meta).length === 0) {
        common.error('[ERROR] Mint metadata not found.');
        return;
    }

    if (mint_meta.raydium_pool === null) {
        trade.buy_token(amount, buyer, mint_meta, 0.5)
            .then(signature => common.log(`Transaction completed, signature: ${signature}`))
            .catch(error => common.error(`Transaction failed: ${error.message}`));
    } else {
        let success = false;
        const amm = new PublicKey(mint_meta.raydium_pool);
        const token_amount: TokenAmount = {
            uiAmount: amount,
            amount: (amount * LAMPORTS_PER_SOL).toString(),
            decimals: 9,
        };
        trade.swap_raydium(token_amount, buyer, amm, mint, 1.5)
            .then(signature => {
                common.log(`Raydium Transaction completed, signature: ${signature}`);
                success = true;
            })
            .catch(error => {
                common.error(`Raydium Transaction failed: ${error.message}`);
                return trade.swap_jupiter(token_amount, buyer, mint, trade.SOL_MINT, 0.5);
            })
            .then(signature => {
                if (!success) common.log(`Jupiter Transaction completed, signature: ${signature}`);
            })
            .catch(error => {
                if (!success) common.error(`Jupiter Transaction failed: ${error.message}`)
            })

    }
}

export async function warmup(keys_cnt: number, from?: number, to?: number, list?: number[], min?: number, max?: number): Promise<void> {
    const MIN = min || 1;
    const MAX = max || 5;

    if (MAX < MIN) {
        common.error('[ERROR] Invalid min and max values.');
        return;
    }

    if (keys_cnt === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }
    keys_cnt++;

    const counts = Array.from({ length: keys_cnt }, () => Math.floor(Math.random() * (MAX - MIN) + MIN));
    const acc_count = list ? list.length : (to ? to - (from || 0) : keys_cnt - (from || 0));

    common.log(`Warming up ${acc_count} accounts...`);

    let files = common.natural_sort(await readdir(trade.KEYS_DIR));
    files = list ? files.filter((_, index) => list.includes(index)) : files.slice(from, to)

    for (const [index, file] of files.entries()) {
        const key = common.get_key(path.join(trade.KEYS_DIR, file));
        if (!key) continue;
        const buyer = Keypair.fromSecretKey(key);
        let mints = [];

        while (true) {
            mints = (await common.fetch_random_mints(counts[index])).filter(i => !i.raydium_pool);
            if (mints.length === counts[index]) break;
            await common.sleep(1000);
        }

        common.log(`Warming up ${buyer.publicKey.toString().padEnd(44, ' ')} with ${counts[index]} tokens (${file})...`);
        for (const mint_meta of mints) {
            let amount = parseFloat(common.normal_random(0.001, 0.0001).toFixed(4));
            if (amount === 0) amount = 0.001;

            common.log(`Buying ${amount} SOL of the token '${mint_meta.name}' with mint ${mint_meta.mint}...`);

            let buy_attempts = 5;
            let bought = false;
            while (buy_attempts > 0 && !bought) {
                try {
                    const signature = await trade.buy_token(amount, buyer, mint_meta, 0.5);
                    common.log(`Transaction completed for ${file}, signature: ${signature}`);
                    bought = true;
                } catch (e) {
                    common.log(`Failed to buy the token, retrying... ${e}`);
                    buy_attempts--;
                    await common.sleep(1000);
                }
            }

            if (!bought) {
                common.error(`Failed to buy the token for ${file}, skipping...`);
                continue;
            }
            await common.sleep(3000);
            let attempts = 20;
            while (attempts > 0) {
                try {
                    const balance = await trade.get_token_balance(buyer.publicKey, new PublicKey(mint_meta.mint));
                    if (balance.uiAmount === 0 || balance.uiAmount === null) {
                        common.log(`No tokens yet to sell for ${file} and mint ${mint_meta.mint}, waiting...`);
                        attempts--;
                        await common.sleep(3000);
                        continue;
                    }
                    common.log(`Selling ${balance.uiAmount} '${mint_meta.name}' tokens (${file})...`);
                    const signature = await trade.sell_token(balance, buyer, mint_meta, 0.5);
                    common.log(`Transaction completed for ${file}, signature: ${signature}`);
                    break;
                } catch (e) {
                    await common.sleep(1000);
                    common.log(`Error selling the token, retrying... ${e}`);
                }
            }
        }
    }
}

export async function collect(address: PublicKey, reserve: boolean): Promise<void> {
    common.log(`Collecting all the SOL from the accounts to ${address}...`);
    const receiver = new PublicKey(address);
    common.log(`Receiver address: ${receiver.toString()}\n`);

    const files = common.natural_sort(await readdir(trade.KEYS_DIR));

    let transactions = [];
    let count = files.length;

    while (count > 0) {
        const file = files[count - 1];
        const file_path = path.join(trade.KEYS_DIR, file);
        const key = common.get_key(file_path);
        if (!key) { count--; continue; }
        if (!reserve && file_path === trade.RESERVE_KEY_PATH) { count--; continue; }

        const sender = Keypair.fromSecretKey(key);
        const amount = await trade.get_balance(sender.publicKey);
        if (amount === 0 || address === sender.publicKey) { count--; continue; }

        common.log(`Collecting ${amount / LAMPORTS_PER_SOL} SOL from ${sender.publicKey.toString().padEnd(44, ' ')} (${file})...`);
        transactions.push(trade.send_lamports(amount, sender, receiver, common.PriorityLevel.VERY_HIGH)
            .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
            .catch(error => common.error(`Transaction failed for ${file}: ${error.message}`)));

        count--;
        await common.sleep(100);
    }

    await Promise.allSettled(transactions);
}

export async function collect_token(mint: PublicKey, receiver: PublicKey): Promise<void> {
    common.log(`Collecting all the tokens from the accounts to ${receiver}...`);
    const reserve = common.get_key(trade.RESERVE_KEY_PATH);
    if (!reserve) throw new Error('Unreachable');

    try {
        const reserve_keypair = Keypair.fromSecretKey(reserve);
        const receiver_assoc_addr = await trade.create_assoc_token_account(reserve_keypair, receiver, mint);

        const files = common.natural_sort(await readdir(trade.KEYS_DIR));

        let transactions = [];
        let count = files.length;

        while (count > 0) {
            const file = files[count - 1];
            const key = common.get_key(path.join(trade.KEYS_DIR, file));
            if (!key) { count--; continue; }

            const sender = Keypair.fromSecretKey(key);
            const token_amount = await trade.get_token_balance(sender.publicKey, mint);
            const token_amount_raw = parseInt(token_amount.amount);
            if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) { count--; continue };
            const sender_assoc_addr = await trade.calc_assoc_token_addr(sender.publicKey, mint);

            common.log(`Collecting ${token_amount.uiAmount} tokens from ${sender.publicKey.toString().padEnd(44, ' ')} (${file})...`);
            transactions.push(trade.send_tokens(token_amount_raw, sender_assoc_addr, receiver_assoc_addr, sender)
                .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
                .catch(error => common.error(`Transaction failed for ${file}: ${error.message}`)));

            count--;
            await common.sleep(100);
        }

        await Promise.allSettled(transactions);
    } catch (error) {
        common.error(`[ERROR] ${error}`);
    }
}

export async function sell_token(mint: PublicKey, list?: number[]): Promise<void> {
    common.log(`Selling all the tokens from the accounts by the mint ${mint.toString()}...\n`);

    const mint_meta = await common.fetch_mint(mint.toString());
    if (Object.keys(mint_meta).length === 0) {
        common.error('[ERROR] Mint metadata not found.');
        return;
    }

    try {
        let files = common.natural_sort(await readdir(trade.KEYS_DIR)).slice(1);
        files = list ? files.filter((_, index) => list.includes(index + 1)) : files;

        let transactions = [];
        let count = files.length;

        while (count > 0) {
            const file = files[count - 1];
            const key = common.get_key(path.join(trade.KEYS_DIR, file));
            if (!key) { count--; continue; }

            const seller = Keypair.fromSecretKey(key);
            const token_amount = await trade.get_token_balance(seller.publicKey, mint);
            if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) { count--; continue };

            common.log(`Selling ${token_amount.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')} (${file})...`);
            if (mint_meta.raydium_pool === null) {
                transactions.push(trade.sell_token(token_amount, seller, mint_meta, 1.5)
                    .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
                    .catch(error => common.error(`Transaction failed for ${file}: ${error.message}`)));
            } else {
                const amm = new PublicKey(mint_meta.raydium_pool);
                transactions.push(trade.swap_raydium(token_amount, seller, amm, trade.SOL_MINT, 1.5)
                    .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
                    .catch(error => common.error(`Transaction failed for ${file}: ${error.message}`)));
            }
            count--;
            await common.sleep(100);
        }

        await Promise.allSettled(transactions);
    } catch (error) {
        common.error(`[ERROR] ${error}`);
    }
}

export async function topup(amount: number, keypair_path: string, keys_cnt: number, from?: number, to?: number, list?: number[]): Promise<void> {
    if (keys_cnt === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }
    keys_cnt++;
    const acc_count = list ? list.length : (to ? to - (from || 0) : keys_cnt - (from || 0));
    common.log(`Topping up ${amount} SOL to ${acc_count} keys...`);

    let payer: Keypair;
    try {
        payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypair_path, 'utf8'))));
        const balance = await trade.get_balance(payer.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Payer address: ${payer.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`);
        if (balance < amount * acc_count) {
            common.error(`[ERROR] Payer balance is not enough to topup ${amount} SOL to ${acc_count} keys`);
            return;
        }
    } catch (err) {
        common.error(`[ERROR] Failed to process payer file: ${err}`);
        return;
    }

    let files = common.natural_sort(await readdir(trade.KEYS_DIR));
    files = list ? files.filter((_, index) => list.includes(index)) : files.slice(from, to)

    let transactions = [];
    let count = files.length;

    while (count > 0) {
        const file = files[count - 1];
        const key = common.get_key(path.join(trade.KEYS_DIR, file));
        if (!key) { count--; continue; }
        const receiver = Keypair.fromSecretKey(key);

        common.log(`Sending ${amount} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')} (${file})...`);
        transactions.push(trade.send_lamports(amount * LAMPORTS_PER_SOL, payer, receiver.publicKey, common.PriorityLevel.VERY_HIGH)
            .then(signature => common.log(`Transaction completed for ${file}, signature: ${signature}`))
            .catch(error => common.error(`Transaction failed for ${file}: ${error.message}`)));

        count--;
        await common.sleep(100);
    }
    await Promise.allSettled(transactions);
}

export async function start(bot_config: common.BotConfig, workers: common.WorkerPromise[]): Promise<void> {
    const worker_update_mint = async (workers: common.WorkerPromise[], mint: PublicKey) => {
        const mint_meta = await common.fetch_mint(mint.toString());
        mint_meta.total_supply = await trade.get_token_supply(mint);
        if (Object.keys(mint_meta).length !== 0) {
            if (mint_meta.usd_market_cap) {
                common.log(`[Main Worker] Currecnt MCAP: $${mint_meta.usd_market_cap.toFixed(3)}`);
                run.worker_post_message(workers, 'mint', mint_meta);
            } else {
                common.log(`[Main Worker] No MCAP data available, using the default values`);
                const [bonding] = trade.calc_token_bonding_curve(mint);
                const [assoc_bonding] = trade.calc_token_assoc_bonding_curve(mint, bonding);
                const default_mint_meta: Partial<common.TokenMeta> = {
                    mint: mint.toString(),
                    symbol: 'Unknown',
                    raydium_pool: null,
                    bonding_curve: bonding.toString(),
                    associated_bonding_curve: assoc_bonding.toString(),
                    market_cap: 27.95,
                    total_supply: BigInt(1000000000000000)
                };
                run.worker_post_message(workers, 'mint', default_mint_meta);
            }
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

            await worker_update_mint(workers, bot_config.mint);
            const interval = setInterval(async () => { if (bot_config.mint) worker_update_mint(workers, bot_config.mint) }, META_UPDATE_INTERVAL);

            setTimeout(() => { run.worker_post_message(workers, 'buy') }, 2000);
            await run.wait_for_workers(workers);
            clearInterval(interval);

            if (global.START_COLLECT)
                await collect_token(bot_config.mint, bot_config.collect_address);
        } else {
            common.error('[ERROR] Token not found. Exiting...');
            global.rl.close();
        }
    } catch (error) {
        common.error(`[ERROR] ${error}`);
        global.rl.close();
    }
}