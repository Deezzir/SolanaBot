import { Keypair, PublicKey, LAMPORTS_PER_SOL, Connection } from '@solana/web3.js';
import * as common from './common.js';
import * as trade_common from './trade_common.js';
import * as trade_pump from './trade_pump.js';
import * as trade_moon from './trade_moon.js';
import * as run from './pump_start.js';
import * as spider from './spider.js';
import dotenv from 'dotenv'
import { Wallet } from '@project-serum/anchor';
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { bs58 } from '@project-serum/anchor/dist/cjs/utils/bytes/index.js';
import pLimit from 'p-limit';
dotenv.config({ path: './.env' });

const META_UPDATE_INTERVAL = 200;
const INTERVAL = 50;
const SELL_SLIPPAGE = 0.5;
const BUY_SLIPPAGE = 0.1;

export async function clean(wallets: common.Wallet[]): Promise<void> {
    common.log('Cleaning all the accounts...\n');
    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    let unsold_set: string[] = [];

    for (const wallet of wallets) {
        const closer = new Wallet(wallet.keypair);

        const balance = await trade_common.get_balance(closer.publicKey);
        if (balance === 0) {
            common.error(`No balance for ${closer.publicKey.toString().padEnd(44, ' ')} (${wallet.name}), skipping...`);
            continue;
        }

        common.log(`Cleaning ${closer.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`);
        const unsold = await trade_common.close_accounts(closer);
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

export async function create_token(
    cid: string, creator: Keypair, program: common.Program = common.Program.Pump, dev_buy?: number, mint?: Keypair
): Promise<void> {
    common.log('Creating a token...\n');

    let meta: common.IPFSMetadata;
    try {
        const balance = await trade_common.get_balance(creator.publicKey) / LAMPORTS_PER_SOL;
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

    switch (program) {
        case common.Program.Pump: {
            try {
                const [sig, mint_addr] = await trade_pump.create_token_with_buy(creator, meta, cid, mint, dev_buy);
                common.log(`Token created | Signature: ${sig}`);
                common.log(`Mint address: ${mint_addr}`);
            } catch (err) {
                common.error('[ERROR] Failed to create token: ' + err);
            }
            break;
        }
        case common.Program.Moonshot: {
            common.error(`[ERROR] The '${program}' is not yet supported`);
            break;
        }
        default: {
            common.error(`[ERROR] Invalid program received: ${program}`);
            break;
        }
    }
}

export async function promote(times: number, cid: string, creator: Keypair, program: common.Program = common.Program.Pump): Promise<void> {
    common.log(`Promoting ${times} accounts with CID ${cid}...\n`);

    let meta: common.IPFSMetadata;
    try {
        const balance = await trade_common.get_balance(creator.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Creator address: ${creator.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL`);

        meta = await common.fetch_ipfs_json(cid) as common.IPFSMetadata;
        common.log(`Token name: ${meta.name} | Symbol: ${meta.symbol}\n`);
    } catch (err) {
        common.error('[ERROR] Failed to process: ' + err);
        return;
    }

    let count = times;
    const transactions = [];

    while (count > 0) {
        switch (program) {
            case common.Program.Pump: {
                transactions.push(trade_pump.create_token(creator, meta, cid, common.PriorityLevel.LOW)
                    .then(([sig, mint]) => common.log(`Signature: ${sig.toString().padEnd(88, ' ')} | Mint: ${mint}`))
                    .catch(error => common.error(`Transaction failed: ${error.message}`)));
                break;
            }
            case common.Program.Moonshot: {
                common.error(`[ERROR] The '${program}' is not yet supported`);
                return;
            }
            default: {
                common.error(`[ERROR] Invalid program received: ${program}`);
                return;
            }
        }

        count--;
        await common.sleep(INTERVAL);
    }

    await Promise.allSettled(transactions);
}

export async function spl_balance(wallets: common.Wallet[], mint: PublicKey): Promise<void> {
    try {
        common.log(`Getting the token balance of the keys by the mint ${mint.toString()}...`);
        common.log(`Bot count: ${wallets.length}\n`);

        const { token_name, token_symbol } = await trade_common.get_token_meta(mint);
        const { supply, decimals } = await trade_common.get_token_supply(mint);
        const supply_num = parseInt(supply.toString())
        common.log(`Token: '${token_name}' | Symbol: '$${token_symbol}'\n`);

        if (wallets.length === 0) {
            common.error('[ERROR] No keys available.');
            return;
        }

        common.log(`${'Id'.padEnd(4, ' ')} | ${'Name'.padEnd(11, ' ')} | ${'Public Key'.padEnd(44, ' ')} | ${'Allocation'.padEnd(16, ' ')} | Token Balance`);
        common.log(`${'-'.repeat(5)}|${'-'.repeat(13)}|${'-'.repeat(46)}|${'-'.repeat(18)}|${'-'.repeat(16)}`);

        let total = 0;
        for (const wallet of wallets) {
            const balance = await trade_common.get_token_balance(wallet.keypair.publicKey, mint, 'confirmed');
            const ui_balance = balance.uiAmount || 0;
            if (ui_balance === 0) continue;

            const key_alloc = (ui_balance / (supply_num / (10 ** decimals))) * 100;
            total += ui_balance;
            common.log(`${wallet.id.toString().padEnd(4, ' ')} | ${wallet.name.padEnd(11, ' ')} | ${wallet.keypair.publicKey.toString().padEnd(44, ' ')} | ${key_alloc.toFixed(2).padEnd(16, ' ')}% | ${ui_balance.toFixed(2)} ${token_symbol}`);
        }
        const allocation = (total / (supply_num / (10 ** decimals))) * 100;

        common.log(`\nTotal balance: ${total} ${token_symbol}`);
        common.log(`Total allocation: ${allocation.toFixed(2)}%`);
    } catch (error) {
        common.error(`[ERROR] ${error}`);
    }
}

export async function transfer_sol(amount: number, receiver: PublicKey, sender: Keypair): Promise<void> {
    common.log(`Transferring ${amount} SOL from ${sender} to ${receiver.toString()}...`);
    const balance = await trade_common.get_balance(sender.publicKey);

    if (sender.publicKey.equals(receiver)) {
        common.error('[ERROR] Sender and receiver addresses are the same.');
        return;
    }

    if (balance < amount * LAMPORTS_PER_SOL) {
        common.error(`[ERROR] Sender balance is not enough to transfer ${amount} SOL`);
        return;
    }
    trade_common.send_lamports(amount * LAMPORTS_PER_SOL, sender, receiver, common.PriorityLevel.VERY_HIGH)
        .then(signature => common.log(`Transaction completed, signature: ${signature}`))
        .catch(error => common.error(`Transaction failed: ${error.message}`));
}

export async function balance(wallets: common.Wallet[]): Promise<void> {
    common.log('Getting the balance of the keys...');
    common.log(`Bot count: ${wallets.length}\n`);
    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }
    let total = 0;
    common.log(`${'Id'.padEnd(4, ' ')} | ${'Name'.padEnd(11, ' ')} | ${'Public Key'.padEnd(44, ' ')} | SOL Balance`);
    common.log(`${'-'.repeat(5)}|${'-'.repeat(13)}|${'-'.repeat(46)}|${'-'.repeat(16)}`);
    for (const wallet of wallets) {
        const balance = await trade_common.get_balance(wallet.keypair.publicKey) / LAMPORTS_PER_SOL;
        total += balance;
        common.log(`${wallet.id.toString().padEnd(4, ' ')} | ${wallet.name.padEnd(11, ' ')} | ${wallet.keypair.publicKey.toString().padEnd(44, ' ')} | ${balance.toFixed(9)} SOL ${wallet.is_reserve ? '| (Reserve)' : ''}`);
    };

    common.log(`\nTotal balance: ${total} SOL`);
}

export async function sell_token_once(mint: PublicKey, seller: Keypair, percent?: number, program: common.Program = common.Program.Pump): Promise<void> {
    const PERCENT = percent || 100.0;
    common.log(`Selling the token by the mint ${mint.toString()}...`);
    common.log(`Selling ${PERCENT}% of the tokens...`);

    const token_amount = await trade_common.get_token_balance(seller.publicKey, mint);
    common.log(`Seller address: ${seller.publicKey.toString()} | Balance: ${token_amount.uiAmount || 0} tokens\n`);
    if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) {
        common.error('[ERROR] No tokens to sell');
        return;
    }
    const token_amount_to_sell = trade_common.get_token_amount_by_percent(token_amount, PERCENT);

    common.log(`Selling ${token_amount_to_sell.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')}...`);

    let amm: PublicKey | undefined;

    switch (program) {
        case common.Program.Pump: {
            const mint_meta = await trade_pump.fetch_mint(mint.toString());
            if (Object.keys(mint_meta).length === 0) {
                common.error(`[ERROR] Mint metadata not found for program: ${program}`);
                return;
            }
            if (mint_meta.raydium_pool !== null) {
                amm = new PublicKey(mint_meta.raydium_pool);
                break;
            }

            trade_pump.sell_token(token_amount, seller, mint_meta, SELL_SLIPPAGE)
                .then(signature => common.log(`Transaction completed, signature: ${signature}`))
                .catch(error => common.error(`Transaction failed: ${error.message}`));

            return;
        }
        case common.Program.Moonshot: {
            const mint_meta = await trade_moon.fetch_mint(mint.toString());
            if (Object.keys(mint_meta).length === 0) {
                common.error(`[ERROR] Mint metadata not found for program: ${program}`);
                return;
            }

            if (mint_meta.dexId === 'raydium') {
                amm = new PublicKey(mint_meta.pairAddress);
                break;
            }

            trade_moon.sell_token(token_amount, seller, mint_meta, SELL_SLIPPAGE)
                .then(signature => common.log(`Transaction completed, signature: ${signature}`))
                .catch(error => common.error(`Transaction failed: ${error.message}`));

            return;
        }
        default: {
            common.error(`[ERROR] Invalid program received: ${program}`);
            return;
        }
    }

    if (!amm) return;
    let success = false;
    trade_common.swap_raydium(token_amount_to_sell, seller, amm, trade_common.SOL_MINT, SELL_SLIPPAGE)
        .then(signature => {
            common.log(`Raydium Transaction completed, signature: ${signature}`);
            success = true;
        })
        .catch(error => {
            common.error(`Raydium Transaction failed: ${error.message}`);
            return trade_common.swap_jupiter(token_amount_to_sell, seller, mint, trade_common.SOL_MINT, 0.5);
        })
        .then(signature => {
            if (!success) common.log(`Jupiter Transaction completed, signature: ${signature}`);
        })
        .catch(error => {
            if (!success) common.error(`Jupiter Transaction failed: ${error.message}`)
        })
}

export async function buy_token_once(amount: number, mint: PublicKey, buyer: Keypair, program: common.Program = common.Program.Pump): Promise<void> {
    common.log(`Buying ${amount} SOL of the token with mint ${mint.toString()}...`);

    try {
        const balance = await trade_common.get_balance(buyer.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Buyer address: ${buyer.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`);
        if (balance < amount) {
            common.error(`[ERROR] Buyer balance is not enough to buy ${amount} SOL`);
            return;
        }
    } catch (err) {
        common.error('[ERROR] Failed to process payer file');
        return;
    }

    let amm: PublicKey | undefined;

    switch (program) {
        case common.Program.Pump: {
            const mint_meta = await trade_pump.fetch_mint(mint.toString());
            if (Object.keys(mint_meta).length === 0) {
                common.error(`[ERROR] Mint metadata not found for program: ${program}`);
                return;
            }
            if (mint_meta.raydium_pool !== null) {
                amm = new PublicKey(mint_meta.raydium_pool);
                break;
            }

            trade_pump.buy_token(amount, buyer, mint_meta, BUY_SLIPPAGE)
                .then(signature => common.log(`Transaction completed, signature: ${signature}`))
                .catch(error => common.error(`Transaction failed: ${error.message}`));

            return;
        }
        case common.Program.Moonshot: {
            const mint_meta = await trade_moon.fetch_mint(mint.toString());
            if (Object.keys(mint_meta).length === 0) {
                common.error(`[ERROR] Mint metadata not found for program: ${program}`);
                return;
            }

            if (mint_meta.dexId === 'raydium') {
                amm = new PublicKey(mint_meta.pairAddress);
                break;
            }

            trade_moon.buy_token(amount, buyer, mint_meta, BUY_SLIPPAGE)
                .then(signature => common.log(`Transaction completed, signature: ${signature}`))
                .catch(error => common.error(`Transaction failed: ${error.message}`));

            return;
        }
        default: {
            common.error(`[ERROR] Invalid program received: ${program}`);
            return;
        }
    }

    if (!amm) return;
    let success = false;
    const sol_amount = trade_common.get_sol_token_amount(amount);
    trade_common.swap_raydium(sol_amount, buyer, amm, mint, BUY_SLIPPAGE)
        .then(signature => {
            common.log(`Raydium Transaction completed, signature: ${signature}`);
            success = true;
        })
        .catch(error => {
            common.error(`Raydium Transaction failed: ${error.message}`);
            return trade_common.swap_jupiter(sol_amount, buyer, mint, trade_common.SOL_MINT, BUY_SLIPPAGE);
        })
        .then(signature => {
            if (!success) common.log(`Jupiter Transaction completed, signature: ${signature}`);
        })
        .catch(error => {
            if (!success) common.error(`Jupiter Transaction failed: ${error.message}`)
        })
}

export async function warmup(
    wallets: common.Wallet[], program: common.Program = common.Program.Pump, min?: number, max?: number): Promise<void> {
    const MIN = min || 1;
    const MAX = max || 5;

    if (program === common.Program.Moonshot) {
        common.error(`[ERROR] The '${program}' is not yet supported`);
        return;
    }

    if (MAX < MIN) {
        common.error('[ERROR] Invalid min and max values.');
        return;
    }

    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    const token_cnts = Array.from({ length: wallets.length }, () => Math.floor(Math.random() * (MAX - MIN) + MIN));

    common.log(`Warming up ${wallets.length} accounts...`);

    for (const [i, wallet] of wallets.entries()) {
        const buyer = wallet.keypair
        let mints = [];

        const balance = await trade_common.get_balance(buyer.publicKey);
        if (balance === 0) {
            common.error(`No balance for ${buyer.publicKey.toString().padEnd(44, ' ')} (${wallet.name}), skipping...`);
            continue;
        }

        while (true) {
            mints = (await trade_pump.fetch_random_mints(token_cnts[i])).filter(i => !i.raydium_pool);
            if (mints.length === token_cnts[i]) break;
            await common.sleep(2000);
        }

        common.log(`Warming up ${buyer.publicKey.toString().padEnd(44, ' ')} with ${token_cnts[i]} tokens (${wallet.name})...`);
        for (const mint_meta of mints) {
            let amount = parseFloat(common.normal_random(0.001, 0.0001).toFixed(4));
            if (amount === 0) amount = 0.001;

            common.log(`Buying ${amount} SOL of the token '${mint_meta.name}' with mint ${mint_meta.mint}...`);

            let buy_attempts = 5;
            let bought = false;
            while (buy_attempts > 0 && !bought) {
                try {
                    const signature = await trade_pump.buy_token(amount, buyer, mint_meta, 0.05);
                    common.log(`Transaction completed for ${wallet.name}, signature: ${signature}`);
                    bought = true;
                } catch (e) {
                    common.log(`Failed to buy the token, retrying... ${e}`);
                    buy_attempts--;
                    await common.sleep(1000);
                }
            }

            if (!bought) {
                common.error(`Failed to buy the token for ${wallet.name}, skipping...`);
                continue;
            }

            let sell_attempts = 20;
            while (sell_attempts > 0) {
                await common.sleep(3000);
                try {
                    const balance = await trade_common.get_token_balance(buyer.publicKey, new PublicKey(mint_meta.mint));
                    if (balance.uiAmount === 0 || balance.uiAmount === null) {
                        common.log(`No tokens yet to sell for ${wallet.name} and mint ${mint_meta.mint}, waiting...`);
                        sell_attempts--;
                        continue;
                    }
                    common.log(`Selling ${balance.uiAmount} '${mint_meta.name}' tokens (${wallet.name})...`);
                    const signature = await trade_pump.sell_token(balance, buyer, mint_meta, 0.05);
                    common.log(`Transaction completed for ${wallet.name}, signature: ${signature}`);
                    break;
                } catch (e) {
                    common.log(`Error selling the token, retrying... ${e}`);
                }
            }
        }
    }
}

export async function collect(wallets: common.Wallet[], receiver: PublicKey): Promise<void> {
    common.log(`Collecting all the SOL from the accounts to ${receiver}...`);
    common.log(`Receiver address: ${receiver.toString()}\n`);

    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    const transactions = [];

    for (const wallet of wallets) {
        const sender = wallet.keypair;
        const amount = await trade_common.get_balance(sender.publicKey);
        if (amount === 0 || receiver.equals(sender.publicKey)) continue;

        common.log(`Collecting ${amount / LAMPORTS_PER_SOL} SOL from ${sender.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`);
        transactions.push(trade_common.send_lamports(amount, sender, receiver, common.PriorityLevel.VERY_HIGH)
            .then(signature => common.log(`Transaction completed for ${wallet.name}, signature: ${signature}`))
            .catch(error => common.error(`Transaction failed for ${wallet.name}: ${error.message}`)));

        await common.sleep(INTERVAL);
    }

    await Promise.allSettled(transactions);
}

export async function collect_token(wallets: common.Wallet[], mint: PublicKey, receiver: PublicKey): Promise<void> {
    common.log(`Collecting all the tokens from the accounts to ${receiver}...`);

    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    try {
        const receiver_assoc_addr = await trade_common.create_assoc_token_account(wallets[0].keypair, receiver, mint);

        const transactions = [];

        for (const wallet of wallets) {
            const sender = wallet.keypair;
            const token_amount = await trade_common.get_token_balance(sender.publicKey, mint);
            const token_amount_raw = parseInt(token_amount.amount);

            if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount || sender.publicKey.equals(receiver)) continue;
            const sender_assoc_addr = await trade_common.calc_assoc_token_addr(sender.publicKey, mint);

            common.log(`Collecting ${token_amount.uiAmount} tokens from ${sender.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`);
            transactions.push(trade_common.send_tokens(token_amount_raw, sender_assoc_addr, receiver_assoc_addr, sender)
                .then(signature => common.log(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                .catch(error => common.error(`Transaction failed for ${wallet.name}: ${error.message}`)));

            await common.sleep(INTERVAL);
        }

        await Promise.allSettled(transactions);
    } catch (error) {
        common.error(`[ERROR] ${error}`);
    }
}

export async function buy_token(
    wallets: common.Wallet[], amount: number, mint: PublicKey, program: common.Program = common.Program.Pump): Promise<void> {
    common.log(`Buying the tokens from the accounts by the mint ${mint.toString()}...`);
    common.log(`Buying ${amount} SOL of the token...\n`);

    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    let amm: PublicKey | undefined;
    let mint_meta: trade_pump.PumpTokenMeta | trade_moon.MoonshotTokenMeta;

    switch (program) {
        case common.Program.Pump: {
            mint_meta = await trade_pump.fetch_mint(mint.toString());
            if (Object.keys(mint_meta).length === 0) {
                common.error(`[ERROR] Mint metadata not found for program: ${program}.`);
                return;
            }
            if (mint_meta.raydium_pool !== null) amm = new PublicKey(mint_meta.raydium_pool);
            break;
        }
        case common.Program.Moonshot: {
            mint_meta = await trade_moon.fetch_mint(mint.toString());
            if (Object.keys(mint_meta).length === 0) {
                common.error(`[ERROR] Mint metadata not found for program: ${program}.`);
                return;
            }
            if (mint_meta.dexId === 'raydium') amm = new PublicKey(mint_meta.pairAddress);
            break;
        }
        default: {
            common.error(`[ERROR] Invalid program received: ${program}`);
            return;
        }
    }

    try {
        const transactions = [];

        for (const wallet of wallets) {
            const buyer = wallet.keypair

            const balance = await trade_common.get_balance(buyer.publicKey) / LAMPORTS_PER_SOL;
            if (balance < amount) continue;

            common.log(`Buying ${amount} SOL worth of tokens with ${buyer.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`);

            if (amm) {
                const sol_amount = trade_common.get_sol_token_amount(amount);
                transactions.push(trade_common.swap_raydium(sol_amount, buyer, amm, mint, BUY_SLIPPAGE)
                    .then(signature => common.log(`Raydium Transaction completed for ${wallet.name}, signature: ${signature}`))
                    .catch(error => common.error(`Raydium Transaction failed for ${wallet.name}: ${error.message}`)));
                continue;
            }

            if (trade_pump.is_pump_meta(mint_meta)) {
                transactions.push(trade_pump.buy_token(amount, buyer, mint_meta, BUY_SLIPPAGE)
                    .then(signature => common.log(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                    .catch(error => common.error(`Transaction failed for ${wallet.name}: ${error.message}`)));
            } else if (trade_moon.is_moonshot_meta(mint_meta)) {
                transactions.push(trade_moon.buy_token(amount, buyer, mint_meta, BUY_SLIPPAGE)
                    .then(signature => common.log(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                    .catch(error => common.error(`Transaction failed for ${wallet.name}: ${error.message}`)));
            }

            // await common.sleep(INTERVAL);
        }

        await Promise.allSettled(transactions);
    } catch (error) {
        common.error(`[ERROR] ${error}`);
    }
}

export async function sell_token(
    wallets: common.Wallet[], mint: PublicKey, program: common.Program = common.Program.Pump, percent?: number): Promise<void> {
    const PERCENT = percent || 100.0;
    common.log(`Selling all the tokens from the accounts by the mint ${mint.toString()}...`);
    common.log(`Selling ${PERCENT}% of the tokens...\n`);

    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    let amm: PublicKey | undefined;
    let mint_meta: trade_pump.PumpTokenMeta | trade_moon.MoonshotTokenMeta;

    switch (program) {
        case common.Program.Pump: {
            mint_meta = await trade_pump.fetch_mint(mint.toString());
            if (Object.keys(mint_meta).length === 0) {
                common.error(`[ERROR] Mint metadata not found for program: ${program}.`);
                return;
            }
            if (mint_meta.raydium_pool !== null) amm = new PublicKey(mint_meta.raydium_pool);
            break;
        }
        case common.Program.Moonshot: {
            mint_meta = await trade_moon.fetch_mint(mint.toString());
            if (Object.keys(mint_meta).length === 0) {
                common.error(`[ERROR] Mint metadata not found for program: ${program}.`);
                return;
            }
            if (mint_meta.dexId === 'raydium') amm = new PublicKey(mint_meta.pairAddress);
            break;
        }
        default: {
            common.error(`[ERROR] Invalid program received: ${program}`);
            return;
        }
    }

    try {
        const transactions = [];

        for (const wallet of wallets) {
            const seller = wallet.keypair
            const token_amount = await trade_common.get_token_balance(seller.publicKey, mint, 'confirmed');
            if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) continue;

            const token_amount_to_sell = trade_common.get_token_amount_by_percent(token_amount, PERCENT);

            common.log(`Selling ${token_amount_to_sell.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`);

            if (amm) {
                transactions.push(trade_common.swap_raydium(token_amount_to_sell, seller, amm, trade_common.SOL_MINT, SELL_SLIPPAGE)
                    .then(signature => common.log(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                    .catch(error => common.error(`Transaction failed for ${wallet.name}: ${error.message}`)));
                continue;
            }

            if (trade_pump.is_pump_meta(mint_meta)) {
                transactions.push(trade_pump.sell_token(token_amount_to_sell, seller, mint_meta, SELL_SLIPPAGE)
                    .then(signature => common.log(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                    .catch(error => common.error(`Transaction failed for ${wallet.name}: ${error.message}`)));
            } else if (trade_moon.is_moonshot_meta(mint_meta)) {
                transactions.push(trade_moon.sell_token(token_amount_to_sell, seller, mint_meta, SELL_SLIPPAGE)
                    .then(signature => common.log(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                    .catch(error => common.error(`Transaction failed for ${wallet.name}: ${error.message}`)));
            }

            // await common.sleep(INTERVAL);
        }

        await Promise.allSettled(transactions);
    } catch (error) {
        common.error(`[ERROR] ${error}`);
    }
}

export async function topup(wallets: common.Wallet[], amount: number, sender: Keypair, is_spider: boolean): Promise<void> {
    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    common.log(`Topping up ${amount} SOL to ${wallets.length} keys...`);

    try {
        const balance = await trade_common.get_balance(sender.publicKey) / LAMPORTS_PER_SOL;
        common.log(`Payer address: ${sender.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`);
        if (balance < amount * wallets.length) {
            common.error(`[ERROR] Payer balance is not enough to topup ${amount} SOL to ${wallets.length - 1} keys`);
            return;
        }
    } catch (err) {
        common.error(`[ERROR] Failed to process payer file: ${err}`);
        return;
    }

    if (!is_spider) {
        const transactions = [];
        const failed: string[] = [];

        for (const wallet of wallets) {
            const receiver = wallet.keypair
            if (receiver.publicKey.equals(sender.publicKey)) continue;

            common.log(`Sending ${amount} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`);
            transactions.push(trade_common.send_lamports(amount * LAMPORTS_PER_SOL, sender, receiver.publicKey, common.PriorityLevel.VERY_HIGH)
                .then(signature => common.log(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                .catch(error => {
                    common.error(`Transaction failed for ${wallet.name}: ${error.message}`)
                    failed.push(wallet.name);
                }));

            await common.sleep(INTERVAL);
        }
        await Promise.allSettled(transactions);

        if (failed.length > 0) {
            common.log(`\nFailed transactions:`);
            for (const item of failed) common.log(`File: ${item}`);
        }
    } else {
        await spider.run_spider_transfer(wallets, amount, sender);
    }
}

export async function start(wallets: common.Wallet[], bot_config: common.BotConfig, workers: common.WorkerJob[]): Promise<void> {
    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    const sol_price = await common.fetch_sol_price();

    common.log('[Main Worker] Starting the bot...');
    const ok = await run.start_workers(wallets, bot_config, workers);
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

            let mint_meta = await trade_pump.init_mint_meta(bot_config.mint, sol_price)
            run.worker_post_message(workers, 'mint', mint_meta);
            const interval = setInterval(async () => {
                let updated_mint_meta = await trade_pump.update_mint_meta_reserves(mint_meta, sol_price);
                if (updated_mint_meta) {
                    common.log(`[Main Worker] Current MCAP: $${updated_mint_meta.usd_market_cap.toFixed(3)}`);
                    mint_meta = updated_mint_meta;
                    run.worker_post_message(workers, 'mint', updated_mint_meta);
                }
            }, META_UPDATE_INTERVAL);

            run.worker_post_message(workers, 'buy', {}, bot_config.start_interval || 0);
            await run.wait_for_workers(workers);
            clearInterval(interval);
        } else {
            common.error('[ERROR] Token not found. Exiting...');
            global.RL.close();
        }
    } catch (error) {
        common.error(`[ERROR] ${error}`);
        global.RL.close();
    }
}

export function generate(count: number, name: string, reserve: boolean, keys_path?: string, index?: number): void {
    common.log(`Generating ${count} keypairs...\n`);

    const wallets: Partial<common.Wallet>[] = [];
    const starting_index = index || 1;

    if (keys_path && existsSync(keys_path)) {
        const private_keys = readFileSync(keys_path, 'utf8').split('\n').filter(i => i);
        private_keys.forEach((wallet, i) => {
            if (wallet.length < 10) return;
            wallet = wallet.trim();
            try {
                const decoded_key = Array.from(bs58.decode(wallet));
                wallets.push({ keypair: Keypair.fromSecretKey(new Uint8Array(decoded_key)), name: `wallet[${i + starting_index}]`, is_reserve: false });
            } catch (e) {
                common.error(`[ERROR] Invalid key at line ${i + 1}`);
                return;
            }
        });
    } else {
        for (let i = 0; i < count; i++)
            wallets.push({ keypair: Keypair.generate(), name: `wallet[${i + starting_index}]`, is_reserve: false });
    }

    if (reserve) wallets.push({ keypair: Keypair.generate(), name: 'reserve', is_reserve: true });

    const writeStream = createWriteStream(name, { encoding: 'utf8' });
    writeStream.write(common.KEYS_FILE_HEADERS.join(',') + '\n');
    wallets.forEach((wallet) => {
        if (wallet.name && wallet.is_reserve && wallet.keypair) {
            const row = [wallet.name, JSON.stringify(Array.from(wallet.keypair.secretKey)), wallet.is_reserve].join(',');
            writeStream.write(row + '\n');
        }
    });

    common.log('Wallet generation completed');
}

export async function benchmark(NUM_REQUESTS: number, test_public_key: string, batch_size = 10, update_interval = 10): Promise<void> {
    const public_key = new PublicKey(test_public_key);
    const limit = pLimit(batch_size);

    let total_call_time = 0;
    let min_time = Number.MAX_VALUE;
    let max_time = 0;
    let errors = 0;
    let calls = 0;
    const connection = new Connection(<any>process.env.RPC, {
        disableRetryOnRateLimit: true,
        httpHeaders: {
            'Authorization': `Bearer ${process.env.RPC_TOKEN}`
        }
    });

    const start_time = process.hrtime();
    const tasks = Array.from({ length: NUM_REQUESTS }, (_, i) => limit(async () => {
        calls++
        const startTime = process.hrtime();

        try {
            const result = await connection.getBalance(public_key)
            //   console.log(`Request ${i + 1} | Balance: ${result}`);
        } catch (error) {
            //   console.error(`Error on request ${i + 1}:`, error);
            errors++;
            return;
        }

        const [seconds, nanoseconds] = process.hrtime(startTime);
        const elapsed_time = seconds * 1000 + nanoseconds / 1e6; // Convert to milliseconds
        total_call_time += elapsed_time;

        if (elapsed_time < min_time) min_time = elapsed_time;
        if (elapsed_time > max_time) max_time = elapsed_time;

        if ((i + 1) % update_interval === 0 || i === NUM_REQUESTS - 1) {
            const avgTime = total_call_time / (i + 1 - errors);
            const tps = (i + 1 - errors) / (total_call_time / 1000);

            process.stdout.write(`\r[${i + 1}/${NUM_REQUESTS}] | Errors: ${errors} | Avg Time: ${avgTime.toFixed(2)} ms | Min Time: ${min_time.toFixed(2)} ms | Max Time: ${max_time.toFixed(2)} ms | TPS: ${tps.toFixed(2)}`);
        }
    }));

    await Promise.all(tasks);
    const end_time = process.hrtime(start_time);
    const total_elapsed_time = end_time[0] * 1000 + end_time[1] / 1e6;
    const avg_time = total_elapsed_time / (NUM_REQUESTS - errors);
    const tps = (NUM_REQUESTS - errors) / (total_elapsed_time / 1000);

    console.log(`\n\nBenchmark Results:`);
    console.log(`Total Requests: ${NUM_REQUESTS}`);
    console.log(`Successful Requests: ${NUM_REQUESTS - errors}`);
    console.log(`Failed Requests: ${errors}`);
    console.log(`Total Time: ${total_elapsed_time.toFixed(2)} ms`);
    console.log(`Average Time per Request: ${avg_time.toFixed(2)} ms`);
    console.log(`Min Time: ${min_time.toFixed(2)} ms`);
    console.log(`Max Time: ${max_time.toFixed(2)} ms`);
    console.log(`Estimated TPS: ${tps.toFixed(2)}`);
}
