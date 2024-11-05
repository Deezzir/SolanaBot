import { Keypair, PublicKey, LAMPORTS_PER_SOL, Connection } from '@solana/web3.js';
import { PumpTrader, PumpRunner, PumpTokenMeta } from './pump/pump.js';
import { MoonTrader, MoonRunner, MoonshotTokenMeta } from './moon/moon.js';
import dotenv from 'dotenv';
import { Wallet } from '@project-serum/anchor';
import { createWriteStream, existsSync, readFileSync } from 'fs';
import { bs58 } from '@project-serum/anchor/dist/cjs/utils/bytes/index.js';
import pLimit from 'p-limit';
import * as spider from './spider.js';
import * as common from './common/common.js';
import * as snipe from './common/snipe_common.js';
import * as trade from './common/trade_common.js';
dotenv.config({ path: './.env' });

const INTERVAL = 50;
const SELL_SLIPPAGE = 0.5;
const BUY_SLIPPAGE = 0.1;

export async function clean(wallets: common.Wallet[]): Promise<void> {
    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    common.log('Cleaning all the accounts...\n');

    let unsold_set: string[] = [];

    for (const wallet of wallets) {
        const closer = new Wallet(wallet.keypair);

        const balance = await trade.get_balance(closer.publicKey);
        if (balance === 0) {
            common.error(`No balance for ${closer.publicKey.toString().padEnd(44, ' ')} (${wallet.name}), skipping...`);
            continue;
        }

        common.log(`Cleaning ${closer.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`);
        const unsold = await trade.close_accounts(closer);
        if (unsold) unsold_set = [...new Set([...unsold_set, ...unsold.map((i) => i.toString())])];
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
    cid: string,
    creator: Keypair,
    program: common.Program = common.Program.Pump,
    dev_buy?: number,
    mint?: Keypair
): Promise<void> {
    common.log('Creating a token...\n');

    let meta: common.IPFSMetadata;
    let trader: trade.IProgramTrader;

    switch (program) {
        case common.Program.Pump: {
            trader = PumpTrader;
            break;
        }
        case common.Program.Moonshot: {
            trader = MoonTrader;
            break;
        }
        default: {
            common.error(`[ERROR] Invalid program received: ${program}`);
            return;
        }
    }

    try {
        const balance = (await trade.get_balance(creator.publicKey)) / LAMPORTS_PER_SOL;
        common.log(`Dev address: ${creator.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL`);

        if (dev_buy && dev_buy > balance) {
            common.error(`[ERROR] Creator balance is not enough to buy ${dev_buy} SOL`);
            return;
        }

        if (mint) common.log(`Custom Mint address: ${mint.publicKey.toString()}`);

        meta = (await common.fetch_ipfs_json(cid)) as common.IPFSMetadata;
        common.log(`Token name: ${meta.name} | Symbol: ${meta.symbol}`);
    } catch (error) {
        common.error(`[ERROR] Failed to process: ${error}`);
        return;
    }

    common.log(`Token Meta: ${JSON.stringify(meta, null, 2)}`);
    console.log(`Dev Buy: ${dev_buy || 0}\n`);

    try {
        const [sig, mint_addr] = await trader.create_token(creator, meta, cid, mint, dev_buy);
        common.log(`Token created | Signature: ${sig}`);
        common.log(`Mint address: ${mint_addr}`);
    } catch (error) {
        common.error(`[ERROR] Failed to create token: ${error}`);
    }
}

export async function promote(
    times: number,
    cid: string,
    creator: Keypair,
    program: common.Program = common.Program.Pump
): Promise<void> {
    common.log(`Promoting ${times} accounts with CID ${cid}...\n`);

    let meta: common.IPFSMetadata;
    let trader: trade.IProgramTrader;

    switch (program) {
        case common.Program.Pump: {
            trader = PumpTrader;
            break;
        }
        case common.Program.Moonshot: {
            trader = MoonTrader;
            break;
        }
        default: {
            common.error(`[ERROR] Invalid program received: ${program}`);
            return;
        }
    }

    try {
        const balance = (await trade.get_balance(creator.publicKey)) / LAMPORTS_PER_SOL;
        common.log(`Creator address: ${creator.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL`);

        meta = (await common.fetch_ipfs_json(cid)) as common.IPFSMetadata;
        common.log(`Token name: ${meta.name} | Symbol: ${meta.symbol}\n`);
    } catch (error) {
        common.error(`[ERROR] Failed to process: ${error}`);
        return;
    }

    const transactions = [];

    while (times > 0) {
        transactions.push(
            trader
                .create_token(creator, meta, cid)
                .then(([sig, mint]) => common.log(`Signature: ${sig.toString().padEnd(88, ' ')} | Mint: ${mint}`))
                .catch((error) => common.error(`Transaction failed: ${error.message}`))
        );

        times--;
        await common.sleep(INTERVAL);
    }

    await Promise.allSettled(transactions);
}

export async function spl_balance(wallets: common.Wallet[], mint: PublicKey): Promise<void> {
    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    try {
        common.log(`Getting the token balance of the keys by the mint ${mint.toString()}...`);
        common.log(`Bot count: ${wallets.length}\n`);

        const { token_name, token_symbol } = await trade.get_token_meta(mint);
        const { supply, decimals } = await trade.get_token_supply(mint);
        const supply_num = parseInt(supply.toString());
        common.log(`Token: ${token_name} | Symbol: $${token_symbol}\n`);

        common.print_header([
            { title: 'Id', width: common.COLUMN_WIDTHS.id },
            { title: 'Name', width: common.COLUMN_WIDTHS.name },
            { title: 'Public Key', width: common.COLUMN_WIDTHS.publicKey },
            { title: 'Allocation', width: common.COLUMN_WIDTHS.allocation, align: 'right' },
            { title: `$${token_symbol} Balance`, width: common.COLUMN_WIDTHS.tokenBalance, align: 'right' }
        ]);

        let total = 0;
        for (const wallet of wallets) {
            const balance = await trade.get_token_balance(wallet.keypair.publicKey, mint, 'confirmed');
            const ui_balance = balance.uiAmount || 0;
            if (ui_balance === 0) continue;

            const alloc = (ui_balance / (supply_num / 10 ** decimals)) * 100;
            total += ui_balance;

            common.print_row([
                { content: wallet.id.toString(), width: common.COLUMN_WIDTHS.id },
                { content: wallet.name, width: common.COLUMN_WIDTHS.name },
                { content: wallet.keypair.publicKey.toString(), width: common.COLUMN_WIDTHS.publicKey },
                { content: `${alloc.toFixed(2)}%`, width: common.COLUMN_WIDTHS.allocation, align: 'right' },
                { content: ui_balance.toFixed(2), width: common.COLUMN_WIDTHS.tokenBalance, align: 'right' }
            ]);
        }

        common.print_footer([
            { width: common.COLUMN_WIDTHS.id },
            { width: common.COLUMN_WIDTHS.name },
            { width: common.COLUMN_WIDTHS.publicKey },
            { width: common.COLUMN_WIDTHS.allocation },
            { width: common.COLUMN_WIDTHS.tokenBalance }
        ]);

        const allocation = (total / (supply_num / 10 ** decimals)) * 100;

        common.log(`\nTotal balance: ${total} ${token_symbol}`);
        common.log(`Total allocation: ${allocation.toFixed(2)}%\n`);
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
    trade
        .send_lamports(amount * LAMPORTS_PER_SOL, sender, receiver, trade.PriorityLevel.VERY_HIGH)
        .then((signature) => common.log(`Transaction completed, signature: ${signature}`))
        .catch((error) => common.error(`Transaction failed: ${error.message}`));
}

export async function balance(wallets: common.Wallet[]): Promise<void> {
    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    let total = 0;
    common.log('Getting the balance of the keys...');
    common.log(`Bot count: ${wallets.length}\n`);

    common.print_header([
        { title: 'Id', width: common.COLUMN_WIDTHS.id },
        { title: 'Name', width: common.COLUMN_WIDTHS.name },
        { title: 'Public Key', width: common.COLUMN_WIDTHS.publicKey },
        { title: 'SOL Balance', width: common.COLUMN_WIDTHS.solBalance, align: 'right' }
    ]);

    for (const wallet of wallets) {
        const balance = (await trade.get_balance(wallet.keypair.publicKey)) / LAMPORTS_PER_SOL;
        total += balance;

        common.print_row([
            { content: wallet.id.toString().concat(wallet.is_reserve ? '*' : ''), width: common.COLUMN_WIDTHS.id },
            { content: wallet.name, width: common.COLUMN_WIDTHS.name },
            { content: wallet.keypair.publicKey.toString(), width: common.COLUMN_WIDTHS.publicKey },
            { content: balance.toFixed(9), width: common.COLUMN_WIDTHS.solBalance, align: 'right' }
        ]);
    }

    common.print_footer([
        { width: common.COLUMN_WIDTHS.id },
        { width: common.COLUMN_WIDTHS.name },
        { width: common.COLUMN_WIDTHS.publicKey },
        { width: common.COLUMN_WIDTHS.solBalance }
    ]);

    common.log(`\nTotal balance: ${total} SOL\n`);
}

export async function sell_token_once(
    mint: PublicKey,
    seller: Keypair,
    percent?: number,
    program: common.Program = common.Program.Pump
): Promise<void> {
    const PERCENT = percent || 100.0;
    common.log(`Selling the token by the mint ${mint.toString()}...`);
    common.log(`Selling ${PERCENT}% of the tokens...`);

    const token_amount = await trade.get_token_balance(seller.publicKey, mint);
    common.log(`Seller address: ${seller.publicKey.toString()} | Balance: ${token_amount.uiAmount || 0} tokens\n`);
    if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) {
        common.error('[ERROR] No tokens to sell');
        return;
    }
    const token_amount_to_sell = trade.get_token_amount_by_percent(token_amount, PERCENT);

    common.log(
        `Selling ${token_amount_to_sell.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')}...`
    );

    let mint_meta: PumpTokenMeta | MoonshotTokenMeta | undefined;
    let trader: trade.IProgramTrader;

    switch (program) {
        case common.Program.Pump: {
            trader = PumpTrader;
            mint_meta = (await trader.get_mint_meta(mint.toString())) as PumpTokenMeta;
            break;
        }
        case common.Program.Moonshot: {
            trader = MoonTrader;
            mint_meta = (await trader.get_mint_meta(mint.toString())) as MoonshotTokenMeta;
            break;
        }
        default: {
            common.error(`[ERROR] Invalid program received: ${program}`);
            return;
        }
    }

    if (!mint_meta) {
        common.log(`[ERROR] Mint metadata not found for program: ${program}.`);
        return;
    }

    trader
        .sell_token(token_amount_to_sell, seller, mint_meta, SELL_SLIPPAGE)
        .then((signature) => common.log(`Transaction completed, signature: ${signature}`))
        .catch((error) => common.error(`Transaction failed: ${error.message}`));
}

export async function buy_token_once(
    amount: number,
    mint: PublicKey,
    buyer: Keypair,
    program: common.Program = common.Program.Pump
): Promise<void> {
    common.log(`Buying ${amount} SOL of the token with mint ${mint.toString()}...`);

    try {
        const balance = (await trade.get_balance(buyer.publicKey)) / LAMPORTS_PER_SOL;
        common.log(`Buyer address: ${buyer.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`);
        if (balance < amount) {
            common.error(`[ERROR] Buyer balance is not enough to buy ${amount} SOL`);
            return;
        }
    } catch (error) {
        common.error('[ERROR] Failed to process payer wallet');
        return;
    }

    let mint_meta: PumpTokenMeta | MoonshotTokenMeta | undefined;
    let trader: trade.IProgramTrader;

    switch (program) {
        case common.Program.Pump: {
            trader = PumpTrader;
            mint_meta = (await trader.get_mint_meta(mint.toString())) as PumpTokenMeta;
            break;
        }
        case common.Program.Moonshot: {
            trader = MoonTrader;
            mint_meta = (await trader.get_mint_meta(mint.toString())) as MoonshotTokenMeta;
            break;
        }
        default: {
            common.error(`[ERROR] Invalid program received: ${program}`);
            return;
        }
    }

    if (!mint_meta) {
        common.log(`[ERROR] Mint metadata not found for program: ${program}.`);
        return;
    }

    trader
        .buy_token(amount, buyer, mint_meta, BUY_SLIPPAGE)
        .then((signature) => common.log(`Transaction completed, signature: ${signature}`))
        .catch((error) => common.error(`Transaction failed: ${error.message}`));
}

export async function warmup(
    wallets: common.Wallet[],
    program: common.Program = common.Program.Pump,
    min?: number,
    max?: number
): Promise<void> {
    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    const MIN = min || 1;
    const MAX = max || 5;

    if (MAX < MIN) {
        common.error('[ERROR] Invalid min and max values.');
        return;
    }

    const token_cnts = Array.from({ length: wallets.length }, () => Math.floor(Math.random() * (MAX - MIN) + MIN));
    common.log(`Warming up ${wallets.length} accounts...`);
    let trader: trade.IProgramTrader;

    switch (program) {
        case common.Program.Pump: {
            trader = PumpTrader;
            break;
        }
        case common.Program.Moonshot: {
            trader = MoonTrader;
            break;
        }
        default: {
            common.error(`[ERROR] Invalid program received: ${program}`);
            return;
        }
    }

    for (const [i, wallet] of wallets.entries()) {
        const buyer = wallet.keypair;
        let mints = [];

        const balance = await trade.get_balance(buyer.publicKey);
        if (balance === 0) {
            common.error(`No balance for ${buyer.publicKey.toString().padEnd(44, ' ')} (${wallet.name}), skipping...`);
            continue;
        }

        while (true) {
            mints = await trader.get_random_mints(token_cnts[i]);
            if (mints.length === token_cnts[i]) break;
            await common.sleep(2000);
        }

        common.log(
            `Warming up ${buyer.publicKey.toString().padEnd(44, ' ')} with ${token_cnts[i]} tokens (${wallet.name})...`
        );
        for (const mint of mints) {
            const mint_printer = trader.get_meta_printer(mint);
            let amount = parseFloat(common.normal_random(0.001, 0.0001).toFixed(4));
            if (amount === 0) amount = 0.001;

            common.log(`Buying ${amount} SOL of the token '${mint_printer.name}' with mint ${mint_printer.mint}...`);

            let buy_attempts = 5;
            let bought = false;
            while (buy_attempts > 0 && !bought) {
                try {
                    const signature = await trader.buy_token(amount, buyer, mint, 0.05);
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
                    const balance = await trade.get_token_balance(buyer.publicKey, new PublicKey(mint_printer.mint));
                    if (balance.uiAmount === 0 || balance.uiAmount === null) {
                        common.log(
                            `No tokens yet to sell for ${wallet.name} and mint ${mint_printer.mint}, waiting...`
                        );
                        sell_attempts--;
                        continue;
                    }
                    common.log(`Selling ${balance.uiAmount} '${mint_printer.name}' tokens (${wallet.name})...`);
                    const signature = await trader.sell_token(balance, buyer, mint, 0.05);
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
    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    common.log(`Collecting all the SOL from the accounts to ${receiver}...`);
    common.log(`Receiver address: ${receiver.toString()}\n`);

    const transactions = [];

    for (const wallet of wallets) {
        const sender = wallet.keypair;
        const amount = await trade.get_balance(sender.publicKey);
        if (amount === 0 || receiver.equals(sender.publicKey)) continue;

        common.log(
            `Collecting ${amount / LAMPORTS_PER_SOL} SOL from ${sender.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
        );
        transactions.push(
            trade
                .send_lamports(amount, sender, receiver, trade.PriorityLevel.VERY_HIGH)
                .then((signature) => common.log(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                .catch((error) => common.error(`Transaction failed for ${wallet.name}: ${error.message}`))
        );

        await common.sleep(INTERVAL);
    }

    await Promise.allSettled(transactions);
}

export async function collect_token(wallets: common.Wallet[], mint: PublicKey, receiver: PublicKey): Promise<void> {
    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    common.log(`Collecting all the tokens from the accounts to ${receiver}...`);

    try {
        const receiver_assoc_addr = await trade.create_assoc_token_account(wallets[0].keypair, receiver, mint);

        const transactions = [];

        for (const wallet of wallets) {
            const sender = wallet.keypair;
            const token_amount = await trade.get_token_balance(sender.publicKey, mint);
            const token_amount_raw = parseInt(token_amount.amount);

            if (
                !token_amount ||
                token_amount.uiAmount === 0 ||
                !token_amount.uiAmount ||
                sender.publicKey.equals(receiver)
            )
                continue;
            const sender_assoc_addr = await trade.calc_assoc_token_addr(sender.publicKey, mint);

            common.log(
                `Collecting ${token_amount.uiAmount} tokens from ${sender.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
            );
            transactions.push(
                trade
                    .send_tokens(token_amount_raw, sender_assoc_addr, receiver_assoc_addr, sender)
                    .then((signature) =>
                        common.log(`Transaction completed for ${wallet.name}, signature: ${signature}`)
                    )
                    .catch((error) => common.error(`Transaction failed for ${wallet.name}: ${error.message}`))
            );

            await common.sleep(INTERVAL);
        }

        await Promise.allSettled(transactions);
    } catch (error) {
        common.error(`[ERROR] ${error}`);
    }
}

export async function buy_token(
    wallets: common.Wallet[],
    amount: number,
    mint: PublicKey,
    program: common.Program = common.Program.Pump
): Promise<void> {
    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    common.log(`Buying the tokens from the accounts by the mint ${mint.toString()}...`);
    common.log(`Buying ${amount} SOL of the token...\n`);

    let mint_meta: PumpTokenMeta | MoonshotTokenMeta | undefined;
    let trader: trade.IProgramTrader;

    switch (program) {
        case common.Program.Pump: {
            trader = PumpTrader;
            mint_meta = (await trader.get_mint_meta(mint.toString())) as PumpTokenMeta;
            break;
        }
        case common.Program.Moonshot: {
            trader = MoonTrader;
            mint_meta = (await trader.get_mint_meta(mint.toString())) as MoonshotTokenMeta;
            break;
        }
        default: {
            common.log(`[ERROR] Invalid program received: ${program}`);
            return;
        }
    }

    if (!mint_meta) {
        common.log(`[ERROR] Mint metadata not found for program: ${program}.`);
        return;
    }

    const transactions: Promise<void>[] = [];

    for (const wallet of wallets) {
        const buyer = wallet.keypair;

        try {
            const balance = (await trade.get_balance(buyer.publicKey)) / LAMPORTS_PER_SOL;
            if (balance < amount) continue;

            common.log(
                `Buying ${amount} SOL worth of tokens with ${buyer.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
            );

            transactions.push(
                trader
                    .buy_token(amount, buyer, mint_meta, BUY_SLIPPAGE)
                    .then((signature) =>
                        common.log(`Transaction completed for ${wallet.name}, signature: ${signature}`)
                    )
                    .catch((error) => common.error(`Transaction failed for ${wallet.name}: ${error.message}`))
            );

            // await common.sleep(INTERVAL);
        } catch (error) {
            common.error(`[ERROR] ${error}`);
        }
    }

    await Promise.allSettled(transactions);
}

export async function sell_token(
    wallets: common.Wallet[],
    mint: PublicKey,
    program: common.Program = common.Program.Pump,
    percent?: number
): Promise<void> {
    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    const PERCENT = percent || 100.0;
    common.log(`Selling all the tokens from the accounts by the mint ${mint.toString()}...`);
    common.log(`Selling ${PERCENT}% of the tokens...\n`);

    let mint_meta: PumpTokenMeta | MoonshotTokenMeta | undefined;
    let trader: trade.IProgramTrader;

    switch (program) {
        case common.Program.Pump: {
            trader = PumpTrader;
            mint_meta = (await trader.get_mint_meta(mint.toString())) as PumpTokenMeta;
            break;
        }
        case common.Program.Moonshot: {
            trader = MoonTrader;
            mint_meta = (await trader.get_mint_meta(mint.toString())) as MoonshotTokenMeta;
            break;
        }
        default: {
            common.log(`[ERROR] Invalid program received: ${program}`);
            return;
        }
    }

    if (!mint_meta) {
        common.log(`[ERROR] Mint metadata not found for program: ${program}.`);
        return;
    }

    const transactions: Promise<void>[] = [];

    for (const wallet of wallets) {
        const seller = wallet.keypair;
        try {
            const token_amount = await trade.get_token_balance(seller.publicKey, mint, 'confirmed');
            if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) continue;

            const token_amount_to_sell = trade.get_token_amount_by_percent(token_amount, PERCENT);

            common.log(
                `Selling ${token_amount_to_sell.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
            );

            transactions.push(
                trader
                    .sell_token(token_amount_to_sell, seller, mint_meta, SELL_SLIPPAGE)
                    .then((signature) =>
                        common.log(`Transaction completed for ${wallet.name}, signature: ${signature}`)
                    )
                    .catch((error) => common.error(`Transaction failed for ${wallet.name}: ${error.message}`))
            );
            // await common.sleep(INTERVAL);
        } catch (error) {
            common.error(`[ERROR] ${error}`);
        }
    }

    await Promise.allSettled(transactions);
}

export async function topup(
    wallets: common.Wallet[],
    amount: number,
    sender: Keypair,
    is_spider: boolean
): Promise<void> {
    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    common.log(`Topping up ${amount} SOL to ${wallets.length} keys...`);

    try {
        const balance = (await trade.get_balance(sender.publicKey)) / LAMPORTS_PER_SOL;
        common.log(`Payer address: ${sender.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`);
        if (balance < amount * wallets.length) {
            common.error(`[ERROR] Payer balance is not enough to topup ${amount} SOL to ${wallets.length - 1} keys`);
            return;
        }
    } catch (error) {
        common.error(`[ERROR] Failed to process payer wallet: ${error}`);
        return;
    }

    if (!is_spider) {
        const transactions = [];
        const failed: string[] = [];

        for (const wallet of wallets) {
            const receiver = wallet.keypair;
            if (receiver.publicKey.equals(sender.publicKey)) continue;

            common.log(`Sending ${amount} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`);
            transactions.push(
                trade
                    .send_lamports(amount * LAMPORTS_PER_SOL, sender, receiver.publicKey, trade.PriorityLevel.VERY_HIGH)
                    .then((signature) =>
                        common.log(`Transaction completed for ${wallet.name}, signature: ${signature}`)
                    )
                    .catch((error) => {
                        common.error(`Transaction failed for ${wallet.name}: ${error.message}`);
                        failed.push(wallet.name);
                    })
            );

            await common.sleep(INTERVAL);
        }
        await Promise.allSettled(transactions);

        if (failed.length > 0) {
            common.log(`\nFailed transactions:`);
            for (const item of failed) common.log(`Wallet: ${item}`);
        }
    } else {
        const rescue_keys = await spider.run_spider_transfer(wallets, amount, sender);
        if (rescue_keys) {
            common.log(`\n[Main Worker] Performing cleanup of the temporary wallets...\n`);
            await collect(rescue_keys, sender.publicKey);
        }
    }
}

export async function start(
    wallets: common.Wallet[],
    bot_config: snipe.BotConfig,
    program: common.Program = common.Program.Pump
): Promise<void> {
    if (wallets.length === 0) {
        common.error('[ERROR] No keys available.');
        return;
    }

    const sol_price = await common.fetch_sol_price();
    let sniper: snipe.ISniper;

    switch (program) {
        case common.Program.Pump: {
            sniper = new PumpRunner(bot_config);
            break;
        }
        case common.Program.Moonshot: {
            sniper = new MoonRunner(bot_config);
            break;
        }
        default: {
            common.error(`[ERROR] Invalid program received: ${program}`);
            return;
        }
    }

    await sniper.snipe(wallets, sol_price);
}

export function generate(count: number, name: string, reserve: boolean, keys_path?: string, index?: number): void {
    common.log(`Generating ${count} keypairs...\n`);

    const wallets: Partial<common.Wallet>[] = [];
    const starting_index = index || 1;

    if (keys_path && existsSync(keys_path)) {
        const private_keys = readFileSync(keys_path, 'utf8')
            .split('\n')
            .filter((i) => i);
        private_keys.forEach((wallet, i) => {
            if (wallet.length < 10) return;
            wallet = wallet.trim();
            try {
                const decoded_key = Array.from(bs58.decode(wallet));
                wallets.push({
                    keypair: Keypair.fromSecretKey(new Uint8Array(decoded_key)),
                    name: `wallet[${i + starting_index}]`,
                    is_reserve: false
                });
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
            const row = [wallet.name, JSON.stringify(Array.from(wallet.keypair.secretKey)), wallet.is_reserve].join(
                ','
            );
            writeStream.write(row + '\n');
        }
    });

    common.log('Wallet generation completed');
}

export async function benchmark(
    NUM_REQUESTS: number,
    test_public_key: string,
    batch_size = 10,
    update_interval = 10
): Promise<void> {
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
            Authorization: `Bearer ${process.env.RPC_TOKEN}`
        }
    });

    const start_time = process.hrtime();
    const tasks = Array.from({ length: NUM_REQUESTS }, (_, i) =>
        limit(async () => {
            calls++;
            const startTime = process.hrtime();

            try {
                await connection.getBalance(public_key);
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

                process.stdout.write(
                    `\r[${i + 1}/${NUM_REQUESTS}] | Errors: ${errors} | Avg Time: ${avgTime.toFixed(2)} ms | Min Time: ${min_time.toFixed(2)} ms | Max Time: ${max_time.toFixed(2)} ms | TPS: ${tps.toFixed(2)}`
                );
            }
        })
    );

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
