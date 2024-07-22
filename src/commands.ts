import { Keypair, PublicKey, LAMPORTS_PER_SOL, TokenAmount } from '@solana/web3.js';
import * as common from './common.js';
import * as trade from './trade.js';
import * as run from './run.js';
import * as spider from './spider.js';
import dotenv from 'dotenv'
import { Wallet } from '@project-serum/anchor';
dotenv.config({ path: './.env' });

const META_UPDATE_INTERVAL = 1000;
const INTERVAL = 50;

export async function clean(keys: common.Key[]): Promise<void> {
    common.log('Cleaning all the accounts...\n');
    if (keys.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    let unsold_set: string[] = [];

    for (const key of keys) {
        const wallet = new Wallet(key.keypair);

        const balance = await trade.get_balance(wallet.publicKey);
        if (balance === 0) {
            common.error(`No balance for ${wallet.publicKey.toString().padEnd(44, ' ')} (${key.file_name}), skipping...`);
            continue;
        }

        common.log(`Cleaning ${wallet.publicKey.toString().padEnd(44, ' ')} (${key.file_name})...`);
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

export async function create_token(cid: string, creator: Keypair, dev_buy?: number, mint?: Keypair): Promise<void> {
    common.log('Creating a token...\n');

    let meta: common.IPFSMetadata;
    try {
        const balance = await trade.get_balance(creator.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Dev address: ${creator.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL`);

        if (dev_buy && dev_buy > balance) {
            common.error(`[ERROR] Creator balance is not enough to buy ${dev_buy} SOL`);
            return;
        }

        if (mint) common.log(`Custom Mint address: ${mint.publicKey.toString()}`);

        meta = await common.fetch_ipfs_json(cid) as common.IPFSMetadata;
        common.log(`Token name: ${meta.name} | Symbol: ${meta.symbol}`);
    } catch (err) {
        common.error('[ERROR] Failed to process: ' + err);
        return;
    }

    common.log(`Token Meta: ${JSON.stringify(meta, null, 2)}`);
    console.log(`Dev Buy: ${dev_buy || 0}\n`);

    try {
        const [sig, mint_addr] = await trade.create_token_with_buy(creator, meta, cid, mint, dev_buy);
        common.log(`Token created | Signature: ${sig}`);
        common.log(`Mint address: ${mint_addr}`);
    } catch (err) {
        common.error('[ERROR] Failed to create token: ' + err);
    }
}

export async function promote(times: number, cid: string, creator: Keypair): Promise<void> {
    common.log(`Promoting ${times} accounts with CID ${cid}...\n`);

    let meta: common.IPFSMetadata;
    try {
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
        transactions.push(trade.create_token(creator, meta, cid, common.PriorityLevel.LOW)
            .then(([sig, mint]) => common.log(`Signature: ${sig.toString().padEnd(88, ' ')} | Mint: ${mint}`))
            .catch(error => common.error(`Transaction failed: ${error.message}`)));

        count--;
        await common.sleep(INTERVAL);
    }

    await Promise.allSettled(transactions);
}

export async function spl_balance(keys: common.Key[], mint: PublicKey): Promise<void> {
    try {
        common.log(`Getting the token balance of the keys by the mint ${mint.toString()}...`);
        common.log(`Bot count: ${keys.length}\n`);

        const { token_name, token_symbol } = await trade.get_token_meta(mint);
        const supply = parseInt((await trade.get_token_supply(mint)).toString());
        common.log(`Token name: ${token_name} | Symbol: ${token_symbol}\n`);

        if (keys.length === 0) {
            common.error('[ERROR] No keys available.');
            return;
        }

        let total = 0;
        for (const key of keys) {
            const balance = await trade.get_token_balance(key.keypair.publicKey, mint);
            const ui_balance = balance.uiAmount || 0;
            if (ui_balance === 0) continue;

            const key_alloc = (ui_balance / (supply / 1_000_000)) * 100;
            total += ui_balance;
            common.log(`File: ${key.file_name.padEnd(10, ' ')} | Address: ${key.keypair.publicKey.toString().padEnd(44, ' ')} | Allocation: ${key_alloc.toFixed(2)}% | Balance: ${ui_balance.toFixed(2)} ${token_symbol}`);
        }
        const allocation = (total / (supply / 1_000_000)) * 100;

        common.log(`\nTotal balance: ${total} ${token_symbol}`);
        common.log(`Total allocation: ${allocation.toFixed(2)}%`);
    } catch (error) {
        common.error(`[ERROR] ${error}`);
    }
}

export async function transfer_sol(amount: number, receiver: PublicKey, sender: Keypair): Promise<void> {
    common.log(`Transferring ${amount} SOL from ${sender} to ${receiver.toString()}...`);
    const balance = await trade.get_balance(sender.publicKey);

    if (sender.publicKey.equals(receiver)) {
        common.error('[ERROR] Sender and receiver addresses are the same.');
        return;
    }

    if (balance < amount * LAMPORTS_PER_SOL) {
        common.error(`[ERROR] Sender balance is not enough to transfer ${amount} SOL`);
        return;
    }
    trade.send_lamports(amount * LAMPORTS_PER_SOL, sender, receiver, common.PriorityLevel.VERY_HIGH)
        .then(signature => common.log(`Transaction completed, signature: ${signature}`))
        .catch(error => common.error(`Transaction failed: ${error.message}`));
}

export async function balance(keys: common.Key[]): Promise<void> {
    common.log('Getting the balance of the keys...');
    common.log(`Bot count: ${keys.length}\n`);
    if (keys.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }
    let total = 0;
    for (const key of keys) {
        const balance = await trade.get_balance(key.keypair.publicKey) / LAMPORTS_PER_SOL;
        total += balance;
        common.log(`File: ${key.file_name.padEnd(10, ' ')} | Address: ${key.keypair.publicKey.toString().padEnd(44, ' ')} | Balance: ${balance.toFixed(9)} SOL ${key.is_reserve ? '| (Reserve)' : ''}`);
    }

    common.log(`\nTotal balance: ${total} SOL`);
}

export async function sell_token_once(mint: PublicKey, seller: Keypair, percent?: number): Promise<void> {
    const PERCENT = percent || 100.0;
    common.log(`Selling the token by the mint ${mint.toString()}...`);
    common.log(`Selling ${PERCENT}% of the tokens...`);

    try {
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
    const token_amount_to_sell = trade.get_token_amount_by_percent(token_amount, PERCENT);

    common.log(`Selling ${token_amount_to_sell.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')}...`);

    if (mint_meta.raydium_pool === null) {
        trade.sell_token(token_amount_to_sell, seller, mint_meta, 0.5)
            .then(signature => common.log(`Transaction completed, signature: ${signature}`))
            .catch(error => common.error(`Transaction failed: ${error.message}`));
    } else {
        let success = false;
        const amm = new PublicKey(mint_meta.raydium_pool);
        trade.swap_raydium(token_amount_to_sell, seller, amm, trade.SOL_MINT, 1.5)
            .then(signature => {
                common.log(`Raydium Transaction completed, signature: ${signature}`);
                success = true;
            })
            .catch(error => {
                common.error(`Raydium Transaction failed: ${error.message}`);
                return trade.swap_jupiter(token_amount_to_sell, seller, mint, trade.SOL_MINT, 0.5);
            })
            .then(signature => {
                if (!success) common.log(`Jupiter Transaction completed, signature: ${signature}`);
            })
            .catch(error => {
                if (!success) common.error(`Jupiter Transaction failed: ${error.message}`)
            })
    }
}

export async function buy_token_once(amount: number, mint: PublicKey, buyer: Keypair): Promise<void> {
    common.log(`Buying ${amount} SOL of the token with mint ${mint.toString()}...`);

    try {
        const balance = await trade.get_balance(buyer.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Buyer address: ${buyer.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`);
        if (balance < amount) {
            common.error(`[ERROR] Buyer balance is not enough to buy ${amount} SOL`);
            return;
        }
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
        const sol_amount = trade.get_sol_token_amount(amount);
        trade.swap_raydium(sol_amount, buyer, amm, mint, 1.5)
            .then(signature => {
                common.log(`Raydium Transaction completed, signature: ${signature}`);
                success = true;
            })
            .catch(error => {
                common.error(`Raydium Transaction failed: ${error.message}`);
                return trade.swap_jupiter(sol_amount, buyer, mint, trade.SOL_MINT, 0.5);
            })
            .then(signature => {
                if (!success) common.log(`Jupiter Transaction completed, signature: ${signature}`);
            })
            .catch(error => {
                if (!success) common.error(`Jupiter Transaction failed: ${error.message}`)
            })
    }
}

export async function warmup(keys: common.Key[], from?: number, to?: number, key_picks?: number[], min?: number, max?: number): Promise<void> {
    const MIN = min || 1;
    const MAX = max || 5;

    if (MAX < MIN) {
        common.error('[ERROR] Invalid min and max values.');
        return;
    }

    if (keys.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    keys = key_picks ? keys.filter((key) => key_picks.includes(key.index)) : keys.slice(from, to)
    const token_cnts = Array.from({ length: keys.length }, () => Math.floor(Math.random() * (MAX - MIN) + MIN));

    common.log(`Warming up ${keys.length} accounts...`);

    for (const [i, key] of keys.entries()) {
        const buyer = key.keypair
        let mints = [];

        const balance = await trade.get_balance(buyer.publicKey);
        if (balance === 0) {
            common.error(`No balance for ${buyer.publicKey.toString().padEnd(44, ' ')} (${key.file_name}), skipping...`);
            continue;
        }

        while (true) {
            mints = (await common.fetch_random_mints(token_cnts[i])).filter(i => !i.raydium_pool);
            if (mints.length === token_cnts[i]) break;
            await common.sleep(2000);
        }

        common.log(`Warming up ${buyer.publicKey.toString().padEnd(44, ' ')} with ${token_cnts[i]} tokens (${key.file_name})...`);
        for (const mint_meta of mints) {
            let amount = parseFloat(common.normal_random(0.001, 0.0001).toFixed(4));
            if (amount === 0) amount = 0.001;

            common.log(`Buying ${amount} SOL of the token '${mint_meta.name}' with mint ${mint_meta.mint}...`);

            let buy_attempts = 5;
            let bought = false;
            while (buy_attempts > 0 && !bought) {
                try {
                    const signature = await trade.buy_token(amount, buyer, mint_meta, 0.5);
                    common.log(`Transaction completed for ${key.file_name}, signature: ${signature}`);
                    bought = true;
                } catch (e) {
                    common.log(`Failed to buy the token, retrying... ${e}`);
                    buy_attempts--;
                    await common.sleep(1000);
                }
            }

            if (!bought) {
                common.error(`Failed to buy the token for ${key.file_name}, skipping...`);
                continue;
            }

            await common.sleep(3000);

            let attempts = 20;
            while (attempts > 0) {
                try {
                    const balance = await trade.get_token_balance(buyer.publicKey, new PublicKey(mint_meta.mint));
                    if (balance.uiAmount === 0 || balance.uiAmount === null) {
                        common.log(`No tokens yet to sell for ${key.file_name} and mint ${mint_meta.mint}, waiting...`);
                        attempts--;
                        await common.sleep(3000);
                        continue;
                    }
                    common.log(`Selling ${balance.uiAmount} '${mint_meta.name}' tokens (${key.file_name})...`);
                    const signature = await trade.sell_token(balance, buyer, mint_meta, 0.5);
                    common.log(`Transaction completed for ${key.file_name}, signature: ${signature}`);
                    break;
                } catch (e) {
                    await common.sleep(1000);
                    common.log(`Error selling the token, retrying... ${e}`);
                }
            }
        }
    }
}

export async function collect(keys: common.Key[], receiver: PublicKey, from?: number, to?: number, key_picks?: number[]): Promise<void> {
    common.log(`Collecting all the SOL from the accounts to ${receiver}...`);
    common.log(`Receiver address: ${receiver.toString()}\n`);

    if (keys.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    keys = key_picks ? keys.filter((key) => key_picks.includes(key.index)) : keys.slice(from, to);

    let transactions = [];

    for (const key of keys) {
        const sender = key.keypair;
        const amount = await trade.get_balance(sender.publicKey);
        if (amount === 0 || receiver.equals(sender.publicKey)) continue;

        common.log(`Collecting ${amount / LAMPORTS_PER_SOL} SOL from ${sender.publicKey.toString().padEnd(44, ' ')} (${key.file_name})...`);
        transactions.push(trade.send_lamports(amount, sender, receiver, common.PriorityLevel.VERY_HIGH)
            .then(signature => common.log(`Transaction completed for ${key.file_name}, signature: ${signature}`))
            .catch(error => common.error(`Transaction failed for ${key.file_name}: ${error.message}`)));

        await common.sleep(INTERVAL);
    }

    await Promise.allSettled(transactions);
}

export async function collect_token(keys: common.Key[], mint: PublicKey, receiver: PublicKey, from?: number, to?: number, key_picks?: number[]): Promise<void> {
    common.log(`Collecting all the tokens from the accounts to ${receiver}...`);
    const reserve_keypair = common.RESERVE_KEYPAIR
    if (!reserve_keypair) throw new Error('Unreachable');

    if (keys.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    keys = key_picks ? keys.filter((key) => key_picks.includes(key.index)) : keys.slice(from, to);

    try {
        const receiver_assoc_addr = await trade.create_assoc_token_account(reserve_keypair, receiver, mint);

        let transactions = [];

        for (const key of keys) {
            const sender = key.keypair;
            const token_amount = await trade.get_token_balance(sender.publicKey, mint);
            const token_amount_raw = parseInt(token_amount.amount);

            if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount || sender.publicKey.equals(receiver)) continue;
            const sender_assoc_addr = await trade.calc_assoc_token_addr(sender.publicKey, mint);

            common.log(`Collecting ${token_amount.uiAmount} tokens from ${sender.publicKey.toString().padEnd(44, ' ')} (${key.file_name})...`);
            transactions.push(trade.send_tokens(token_amount_raw, sender_assoc_addr, receiver_assoc_addr, sender)
                .then(signature => common.log(`Transaction completed for ${key.file_name}, signature: ${signature}`))
                .catch(error => common.error(`Transaction failed for ${key.file_name}: ${error.message}`)));

            await common.sleep(INTERVAL);
        }

        await Promise.allSettled(transactions);
    } catch (error) {
        common.error(`[ERROR] ${error}`);
    }
}

export async function buy_token(keys: common.Key[], amount: number, mint: PublicKey, from?: number, to?: number, key_picks?: number[]): Promise<void> {
    common.log(`Buying the tokens from the accounts by the mint ${mint.toString()}...`);
    common.log(`Buying ${amount} SOL of the token...\n`);

    if (keys.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    const mint_meta = await common.fetch_mint(mint.toString());
    if (Object.keys(mint_meta).length === 0) {
        common.error('[ERROR] Mint metadata not found.');
        return;
    }

    try {
        keys = key_picks ? keys.filter((key) => key_picks.includes(key.index)) : keys.slice(from, to);

        let transactions = [];

        for (const key of keys) {
            const buyer = key.keypair

            const balance = await trade.get_balance(buyer.publicKey) / LAMPORTS_PER_SOL;
            if (balance < amount) continue;

            if (mint_meta.raydium_pool === null) {
                transactions.push(trade.buy_token(amount, buyer, mint_meta, 0.5)
                    .then(signature => common.log(`Transaction completed for ${key.file_name}, signature: ${signature}`))
                    .catch(error => common.error(`Transaction failed for ${key.file_name}: ${error.message}`)));
            } else {
                const amm = new PublicKey(mint_meta.raydium_pool);
                const sol_amount = trade.get_sol_token_amount(amount);
                transactions.push(trade.swap_raydium(sol_amount, buyer, amm, mint, 1.5)
                    .then(signature => common.log(`Raydium Transaction completed for ${key.file_name}, signature: ${signature}`))
                    .catch(error => common.error(`Raydium Transaction failed for ${key.file_name}: ${error.message}`)));
            }
            await common.sleep(INTERVAL);
        }

        await Promise.allSettled(transactions);
    } catch (error) {
        common.error(`[ERROR] ${error}`);
    }
}

export async function sell_token(keys: common.Key[], mint: PublicKey, from?: number, to?: number, key_picks?: number[], percent?: number): Promise<void> {
    const PERCENT = percent || 100.0;
    common.log(`Selling all the tokens from the accounts by the mint ${mint.toString()}...`);
    common.log(`Selling ${PERCENT}% of the tokens...\n`);

    if (keys.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    const mint_meta = await common.fetch_mint(mint.toString());
    if (Object.keys(mint_meta).length === 0) {
        common.error('[ERROR] Mint metadata not found.');
        return;
    }

    try {
        keys = key_picks ? keys.filter((key) => key_picks.includes(key.index)) : keys.slice(from, to);

        let transactions = [];

        for (const key of keys) {
            const seller = key.keypair
            const token_amount = await trade.get_token_balance(seller.publicKey, mint);
            if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) continue;

            const token_amount_to_sell = trade.get_token_amount_by_percent(token_amount, PERCENT);

            common.log(`Selling ${token_amount_to_sell.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')} (${key.file_name})...`);
            if (mint_meta.raydium_pool === null) {
                transactions.push(trade.sell_token(token_amount_to_sell, seller, mint_meta, 1.5)
                    .then(signature => common.log(`Transaction completed for ${key.file_name}, signature: ${signature}`))
                    .catch(error => common.error(`Transaction failed for ${key.file_name}: ${error.message}`)));
            } else {
                const amm = new PublicKey(mint_meta.raydium_pool);
                transactions.push(trade.swap_raydium(token_amount_to_sell, seller, amm, trade.SOL_MINT, 1.5)
                    .then(signature => common.log(`Transaction completed for ${key.file_name}, signature: ${signature}`))
                    .catch(error => common.error(`Transaction failed for ${key.file_name}: ${error.message}`)));
            }
            // await common.sleep(INTERVAL);
        }

        await Promise.allSettled(transactions);
    } catch (error) {
        common.error(`[ERROR] ${error}`);
    }
}

export async function topup(keys: common.Key[], amount: number, payer: Keypair, is_spider: boolean, from?: number, to?: number, key_picks?: number[]): Promise<void> {
    if (keys.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    keys = key_picks ? keys.filter((key) => key_picks.includes(key.index)) : keys.slice(from, to);
    common.log(`Topping up ${amount} SOL to ${keys.length} keys...`);

    try {
        const balance = await trade.get_balance(payer.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Payer address: ${payer.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`);
        if (balance < amount * keys.length) {
            common.error(`[ERROR] Payer balance is not enough to topup ${amount} SOL to ${keys.length} keys`);
            return;
        }
    } catch (err) {
        common.error(`[ERROR] Failed to process payer file: ${err}`);
        return;
    }

    if (!is_spider) {
        let transactions = [];

        for (const key of keys) {
            const receiver = key.keypair
            if (receiver.publicKey.equals(payer.publicKey)) continue;

            common.log(`Sending ${amount} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')} (${key.file_name})...`);
            transactions.push(trade.send_lamports(amount * LAMPORTS_PER_SOL, payer, receiver.publicKey, common.PriorityLevel.VERY_HIGH)
                .then(signature => common.log(`Transaction completed for ${key.file_name}, signature: ${signature}`))
                .catch(error => common.error(`Transaction failed for ${key.file_name}: ${error.message}`)));

            await common.sleep(INTERVAL);
        }
        await Promise.allSettled(transactions);
    } else {
        await spider.run_spider_transfer(keys, amount, payer);
    }
}

export async function start(keys: common.Key[], bot_config: common.BotConfig, workers: common.WorkerJob[], from?: number, to?: number, key_picks?: number[]): Promise<void> {
    if (keys.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    keys = key_picks ? keys.filter((key) => key_picks.includes(key.index)) : keys.slice(from, to);

    const worker_update_mint = async (workers: common.WorkerJob[], mint: PublicKey) => {
        const mint_meta = await common.fetch_mint(mint.toString());
        mint_meta.total_supply = await trade.get_token_supply(mint);

        if (Object.keys(mint_meta).length !== 0 && mint_meta.usd_market_cap !== undefined) {
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

    common.log('[Main Worker] Starting the bot...');
    const ok = await run.start_workers(keys, bot_config, workers);
    if (!ok) {
        common.error('[ERROR] Failed to start the workers. Exiting...');
        global.RL.close();
        return;
    }

    common.log('[Main Worker] Bot started successfully, waiting for the token...');

    try {
        const mint = bot_config.token_name && bot_config.token_ticker ? await run.wait_drop_sub(bot_config.token_name, bot_config.token_ticker) : bot_config.mint;

        if (mint) {
            bot_config.mint = mint;
            common.log(`[Main Worker] Token detected: ${bot_config.mint.toString()}`);

            await worker_update_mint(workers, bot_config.mint);
            const interval = setInterval(async () => { if (bot_config.mint) worker_update_mint(workers, bot_config.mint) }, META_UPDATE_INTERVAL);

            setTimeout(() => { run.worker_post_message(workers, 'buy', {}, bot_config.start_interval || 0) }, 1000);
            await run.wait_for_workers(workers);
            clearInterval(interval);

            if (global.START_COLLECT)
                await collect_token(keys, bot_config.mint, bot_config.collect_address);

        } else {
            common.error('[ERROR] Token not found. Exiting...');
            global.RL.close();
        }
    } catch (error) {
        common.error(`[ERROR] ${error}`);
        global.RL.close();
    }
}