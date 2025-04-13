import {
    Keypair,
    PublicKey,
    LAMPORTS_PER_SOL,
    Connection,
    TransactionInstruction,
    Signer,
    ComputeBudgetProgram
} from '@solana/web3.js';
import { PumpTrader, PumpRunner } from './pump/pump.js';
import { MoonTrader, MoonRunner } from './moon/moon.js';
import { GenericTrader } from './generic/generic.js';
import { createWriteStream, existsSync, readFileSync } from 'fs';
import bs58 from 'bs58';
import {
    COMMANDS_BUY_SLIPPAGE,
    COMMANDS_INTERVAL_MS,
    COMMANDS_SELL_SLIPPAGE,
    COMMITMENT,
    HELIUS_RPC,
    JITO_BUNDLE_SIZE,
    PriorityLevel,
    WALLETS_FILE_HEADERS
} from './constants.js';
import * as common from './common/common.js';
import * as snipe from './common/snipe_common.js';
import * as trade from './common/trade_common.js';
import * as snipe_common from './common/snipe_common.js';
import * as transfers from './subcommands/transfers.js';
import * as volume from './subcommands/volume.js';
import * as token_drop from './subcommands/token_drop.js';
import * as pnl from './subcommands/pnl.js';

function get_trader(program: common.Program): trade.IProgramTrader {
    switch (program) {
        case common.Program.Pump: {
            return PumpTrader;
        }
        case common.Program.Moonshot: {
            return MoonTrader;
        }
        case common.Program.Generic: {
            return GenericTrader;
        }
        default: {
            throw new Error(`[ERROR] Invalid program received: ${program}`);
        }
    }
}

export async function clean(wallets: common.Wallet[]): Promise<void> {
    if (wallets.length === 0) throw new Error('[ERROR] No wallets available.');

    common.log(common.yellow('Cleaning all the accounts...\n'));

    let unsold_set: string[] = [];

    for (const wallet of wallets) {
        const closer = wallet.keypair;

        const balance = await trade.get_balance(closer.publicKey);
        if (balance === 0) {
            common.error(
                common.red(
                    `No balance for ${closer.publicKey.toString().padEnd(44, ' ')} (${wallet.name}), skipping...`
                )
            );
            continue;
        }

        common.log(`Cleaning ${closer.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`);
        const unsold = await trade.close_accounts(closer);
        if (unsold) unsold_set = [...new Set([...unsold_set, ...unsold.map((i) => i.toString())])];
        common.log(common.green(`Cleaned`));
    }

    if (unsold_set.length > 0) {
        common.log(common.red(`\nUnsold Tokens:`));
        for (const item of unsold_set) {
            common.log(common.bold(`Mint: ${item}`));
        }
    }
}

export async function create_token(
    cid: string,
    dev: Keypair,
    program: common.Program = common.Program.Pump,
    dev_buy?: number,
    mint?: Keypair
): Promise<void> {
    common.log('Creating a token...\n');

    const trader = get_trader(program);
    const balance = (await trade.get_balance(dev.publicKey)) / LAMPORTS_PER_SOL;
    const meta = await common.fetch_ipfs_json(cid);

    if (dev_buy && dev_buy > balance) throw new Error(`[ERROR] Dev balance is not enough to buy for ${dev_buy} SOL`);

    common.log(common.yellow(`Dev address: ${dev.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL`));
    if (mint) common.log(`Custom Mint address: ${mint.publicKey.toString()}`);
    common.log(`Token name: ${meta.name} | Symbol: ${meta.symbol}`);
    common.log(`Token Meta: ${JSON.stringify(meta, null, 2)}`);
    common.log(`Dev Buy: ${dev_buy || 0}\n`);

    try {
        const [sig, mint_addr] = await trader.create_token(dev, meta, cid, mint, dev_buy);
        common.log(common.bold(`Token created | Signature: ${sig}`));
        common.log(common.bold(`Mint address: ${mint_addr}`));
    } catch (error) {
        throw new Error(`[ERROR] Failed to create token: ${error}`);
    }
}

export async function promote(
    times: number,
    cid: string,
    dev: Keypair,
    program: common.Program = common.Program.Pump
): Promise<void> {
    common.log(common.yellow(`Creating ${times} tokens with CID ${cid}...\n`));

    const trader = get_trader(program);
    const balance = (await trade.get_balance(dev.publicKey)) / LAMPORTS_PER_SOL;
    const meta = await common.fetch_ipfs_json(cid);

    common.log(common.bold(`Dev address: ${dev.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL`));
    common.log(common.bold(`Token name: ${meta.name} | Symbol: ${meta.symbol}\n`));

    const transactions = [];

    while (times > 0) {
        transactions.push(
            trader
                .create_token(dev, meta, cid)
                .then(([sig, mint]) => common.log(`Signature: ${sig.toString().padEnd(88, ' ')} | Mint: ${mint}`))
                .catch((error) => common.error(`Transaction failed: ${error.message}`))
        );

        times--;
        await common.sleep(COMMANDS_INTERVAL_MS);
    }

    await Promise.allSettled(transactions);
}

export async function spl_balance(wallets: common.Wallet[], mint: PublicKey): Promise<void> {
    if (wallets.length === 0) throw new Error('[ERROR] No wallets available.');

    common.log(common.yellow(`Getting the token balance of the wallets by the mint ${mint.toString()}...`));

    let decimals, supply, supply_raw;
    let token_name, token_symbol;

    try {
        ({ token_name, token_symbol } = await trade.get_token_meta(mint));
        ({ supply: supply_raw, decimals } = await trade.get_token_supply(mint));
        supply = Number(supply_raw);
        common.log(common.yellow(`Token: ${token_name} | Symbol: $${token_symbol}\n`));
    } catch (error) {
        throw new Error(`[ERROR] Failed to get the token information: ${error}`);
    }

    common.print_header([
        { title: 'Id', width: common.COLUMN_WIDTHS.id },
        { title: 'Name', width: common.COLUMN_WIDTHS.name },
        { title: 'Public Key', width: common.COLUMN_WIDTHS.publicKey },
        { title: 'Allocation', width: common.COLUMN_WIDTHS.allocation, align: 'right' },
        { title: `$${token_symbol} Balance`, width: common.COLUMN_WIDTHS.tokenBalance, align: 'right' }
    ]);

    let total = 0;
    let wallet_count = 0;

    for (const wallet of wallets) {
        const balance = await trade.get_token_balance(wallet.keypair.publicKey, mint, COMMITMENT);
        const ui_balance = balance.uiAmount || 0;
        if (ui_balance === 0) continue;

        wallet_count++;
        const alloc = (ui_balance / (supply / 10 ** decimals)) * 100;
        total += ui_balance;

        common.print_row([
            { content: wallet.id.toString(), width: common.COLUMN_WIDTHS.id },
            { content: common.format_name(wallet.name), width: common.COLUMN_WIDTHS.name },
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

    const allocation = (total / (supply / 10 ** decimals)) * 100;

    common.log(common.green(`\nWallets with balance: ${wallet_count}`));
    common.log(`Total balance: ${common.format_currency(total)} ${token_symbol}`);
    common.log(common.bold(`Total allocation: ${allocation.toFixed(2)}%\n`));
}

export async function transfer_sol(amount: number, receiver: PublicKey, sender: Keypair): Promise<void> {
    common.log(common.yellow(`Transferring ${amount} SOL from ${sender} to ${receiver.toString()}...`));
    const balance = await trade.get_balance(sender.publicKey);

    if (sender.publicKey.equals(receiver)) {
        throw new Error('[ERROR] Sender and receiver addresses are the same.');
    }

    if (balance < amount * LAMPORTS_PER_SOL) {
        throw new Error(`[ERROR] Sender balance is not enough to transfer ${amount} SOL`);
    }
    trade
        .send_lamports(amount * LAMPORTS_PER_SOL, sender, receiver, PriorityLevel.DEFAULT)
        .then((signature) => common.log(common.green(`Transaction completed, signature: ${signature}`)))
        .catch((error) => common.error(common.red(`Transaction failed: ${error.message}`)));
}

export async function balance(wallets: common.Wallet[]): Promise<void> {
    if (wallets.length === 0) throw new Error('[ERROR] No wallets available.');

    let total = 0;
    common.log(common.yellow('Getting the balance of the wallets...'));
    common.log(common.yellow(`Wallet count: ${wallets.length}\n`));

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
            { content: common.format_name(wallet.name), width: common.COLUMN_WIDTHS.name },
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

    common.log(common.bold(`\nTotal balance: ${common.format_currency(total)} SOL\n`));
}

export async function sell_token_once(
    mint: PublicKey,
    seller: Keypair,
    percent?: number,
    slippage?: number,
    protection_tip?: number,
    priority: PriorityLevel = PriorityLevel.DEFAULT,
    program: common.Program = common.Program.Pump
): Promise<void> {
    const SLIPPAGE = slippage || COMMANDS_SELL_SLIPPAGE;
    const PERCENT = percent || 1.0;

    common.log(common.yellow(`Selling the token by the mint ${mint.toString()}...`));
    common.log(common.yellow(`Selling ${PERCENT * 100}% of the tokens...`));

    const token_amount = await trade.get_token_balance(seller.publicKey, mint);
    common.log(
        common.bold(
            `\nSeller address: ${seller.publicKey.toString()} | Balance: ${token_amount.uiAmount || 0} tokens\n`
        )
    );

    if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) {
        throw new Error('[ERROR] No tokens to sell');
    }

    const token_amount_to_sell = trade.get_token_amount_by_percent(token_amount, PERCENT);

    common.log(
        `Selling ${token_amount_to_sell.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')}...`
    );

    const trader = get_trader(program);
    let mint_meta = await trader.get_mint_meta(mint);

    if (!mint_meta) {
        throw new Error(`[ERROR] Mint metadata not found for program: ${program}.`);
    }
    trader
        .sell_token(token_amount_to_sell, seller, mint_meta, SLIPPAGE, priority, protection_tip)
        .then((signature) => common.log(common.green(`Transaction completed, signature: ${signature}`)))
        .catch((error) => common.error(common.red(`Transaction failed: ${error.message}`)));
}

export async function buy_token_once(
    amount: number,
    mint: PublicKey,
    buyer: Keypair,
    slippage?: number,
    protection_tip?: number,
    priority: PriorityLevel = PriorityLevel.DEFAULT,
    program: common.Program = common.Program.Pump
): Promise<void> {
    const SLIPPAGE = slippage || COMMANDS_BUY_SLIPPAGE;

    common.log(common.yellow(`Buying ${amount} SOL of the token with mint ${mint.toString()}...`));

    const balance = (await trade.get_balance(buyer.publicKey)) / LAMPORTS_PER_SOL;
    common.log(common.bold(`\nBuyer address: ${buyer.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`));
    if (balance < amount) {
        throw new Error(`[ERROR] Buyer balance is not enough to buy ${amount} SOL`);
    }

    const trader = get_trader(program);
    let mint_meta: trade.IMintMeta | undefined = await trader.get_mint_meta(mint);

    if (!mint_meta) {
        throw new Error(`[ERROR] Mint metadata not found for program: ${program}.`);
    }

    trader
        .buy_token(amount, buyer, mint_meta, SLIPPAGE, priority, protection_tip)
        .then((signature) => common.log(common.green(`Transaction completed, signature: ${signature}`)))
        .catch((error) => common.error(common.red(`Transaction failed: ${error.message}`)));
}

export async function warmup(
    wallets: common.Wallet[],
    bundle_tip: number = 0.0005,
    priority: PriorityLevel = PriorityLevel.DEFAULT,
    program: common.Program = common.Program.Pump,
    min?: number,
    max?: number
): Promise<void> {
    const MIN = min || 1;
    const MAX = max || 5;
    const SLIPPAGE = 0.5;

    if (wallets.length === 0) throw new Error('[ERROR] No wallets available.');
    if (MAX < MIN) throw new Error('[ERROR] Invalid min and max values.');

    common.log(common.yellow(`Warming up ${wallets.length} accounts...`));

    const token_cnts = Array.from({ length: wallets.length }, () => Math.floor(Math.random() * (MAX - MIN) + MIN));
    if (token_cnts.length !== wallets.length) throw new Error();
    const trader = get_trader(program);

    for (const [i, wallet] of wallets.entries()) {
        const buyer = wallet.keypair;

        const balance = await trade.get_balance(buyer.publicKey);
        if (balance === 0) {
            common.error(
                common.red(
                    `No balance for ${buyer.publicKey.toString().padEnd(44, ' ')} (${wallet.name}), skipping...\n`
                )
            );
            continue;
        }

        const mints: trade.IMintMeta[] = await trade.get_random_mints(trader, token_cnts[i]);
        common.log(
            common.yellow(
                `\nWarming up ${buyer.publicKey.toString().padEnd(44, ' ')} with ${token_cnts[i]} tokens (${wallet.name})...`
            )
        );
        for (const mint of mints) {
            let amount = Math.max(0.005, parseFloat(common.normal_random(0.01, 0.01).toFixed(4)));
            common.log(
                `Warming up with ${amount} SOL of the token '${mint.token_name}' with mint ${mint.token_mint}...`
            );
            try {
                const bundle_id = await trader.buy_sell_bundle(amount, buyer, mint, bundle_tip, SLIPPAGE, priority);
                common.log(common.green(`Bundle completed for ${wallet.name}, bundle ID: ${bundle_id}`));
            } catch (error) {
                common.log(
                    common.red(`Failed to bundle the token '${mint.token_name}' for ${wallet.name}, continuing...`)
                );
            }
        }
    }
}

export async function collect(wallets: common.Wallet[], receiver: PublicKey): Promise<void> {
    if (wallets.length === 0) throw new Error('[ERROR] No wallets available.');

    common.log(common.yellow(`Collecting all the SOL from the accounts...`));
    common.log(common.yellow(`Receiver address: ${receiver.toString()}\n`));

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
                .send_lamports(amount, sender, receiver, PriorityLevel.DEFAULT)
                .then((signature) =>
                    common.log(common.green(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                )
                .catch((error) => common.error(common.red(`Transaction failed for ${wallet.name}: ${error.message}`)))
        );

        await common.sleep(COMMANDS_INTERVAL_MS);
    }

    await Promise.allSettled(transactions);
}

export async function collect_token(wallets: common.Wallet[], mint: PublicKey, receiver: PublicKey): Promise<void> {
    if (wallets.length === 0) throw new Error('[ERROR] No wallets available.');

    common.log(common.yellow(`Collecting all the tokens from the accounts to ${receiver}...`));

    const receiver_assoc_addr = await trade.create_assoc_token_account(wallets[0].keypair, receiver, mint);
    const transactions = [];

    for (const wallet of wallets) {
        try {
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
                        common.log(common.green(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                    )
                    .catch((error) =>
                        common.error(common.red(`Transaction failed for ${wallet.name}: ${error.message}`))
                    )
            );
        } catch (error) {
            if (error instanceof Error) {
                common.error(common.red(`Failed to collect the token from ${wallet.name}: ${error.message}`));
            }
        }

        await common.sleep(COMMANDS_INTERVAL_MS);
    }

    await Promise.allSettled(transactions);
}

export async function buy_token(
    wallets: common.Wallet[],
    mint: PublicKey,
    priority: PriorityLevel = PriorityLevel.DEFAULT,
    program: common.Program = common.Program.Pump,
    bundle_tip?: number,
    amount?: number,
    min?: number,
    max?: number,
    slippage?: number
): Promise<void> {
    const SLIPPAGE = slippage || COMMANDS_BUY_SLIPPAGE;

    if (wallets.length === 0) throw new Error('[ERROR] No wallets available.');
    if (!amount && (!min || !max)) throw new Error('[ERROR] Either amount or min and max should be provided.');
    if (max && min && max < min) throw new Error('[ERROR] Invalid min and max values.');

    common.log(common.yellow(`Buying the tokens by the mint ${mint.toString()}...`));

    const trader = get_trader(program);
    let mint_meta = await trader.get_mint_meta(mint);
    if (!mint_meta) throw new Error(`[ERROR] Mint metadata not found for program: ${program}.`);

    if (!bundle_tip) {
        const transactions: Promise<void>[] = [];
        for (const wallet of wallets) {
            const buyer = wallet.keypair;
            let buy_amount = amount || common.uniform_random(min ?? 0, max ?? 0);
            try {
                const balance = (await trade.get_balance(buyer.publicKey)) / LAMPORTS_PER_SOL;
                if (balance < buy_amount) continue;
                common.log(
                    `Buying ${buy_amount.toFixed(6)} SOL worth of tokens with ${buyer.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
                );
                transactions.push(
                    trader
                        .buy_token(buy_amount, buyer, mint_meta, SLIPPAGE, priority)
                        .then((signature) =>
                            common.log(
                                common.green(`Transaction completed for ${wallet.name}, signature: ${signature}`)
                            )
                        )
                        .catch((error) =>
                            common.error(common.red(`Transaction failed for ${wallet.name}: ${error.message}`))
                        )
                );
                mint_meta = await trader.update_mint_meta(mint_meta);
            } catch (error) {
                common.error(common.red(`Failed to buy the token for ${wallet.name}: ${error}`));
            }
        }
        await Promise.allSettled(transactions);
    } else {
        const wallet_bundles = common.chunks(wallets, JITO_BUNDLE_SIZE);
        const bundles: Promise<void>[] = [];
        let priority_fee: number | undefined = undefined;
        for (const wallet_bundle of wallet_bundles) {
            const instructions: TransactionInstruction[][] = [];
            const signers: Signer[][] = [];
            for (const wallet of wallet_bundle) {
                const buyer = wallet.keypair;
                let buy_amount = amount || common.uniform_random(min ?? 0, max ?? 0);
                try {
                    const balance = await trade.get_balance(buyer.publicKey);
                    if (balance < buy_amount) continue;
                    common.log(
                        `Buying ${buy_amount.toFixed(6)} SOL worth of tokens with ${buyer.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
                    );
                    const [instrs] = await trader.buy_token_instructions(buy_amount, buyer, mint_meta, SLIPPAGE);
                    if (priority && !priority_fee) {
                        priority_fee = await trade.get_priority_fee({
                            priority_level: priority,
                            transaction: {
                                instructions: instrs,
                                signers: [buyer]
                            }
                        });
                    }
                    instrs.unshift(
                        ComputeBudgetProgram.setComputeUnitPrice({
                            microLamports: priority_fee!
                        })
                    );
                    instructions.push(instrs);
                    signers.push([buyer]);
                } catch (error) {
                    common.error(common.red(`Failed to add buy instruction to bundle ${wallet.name}: ${error}`));
                }
            }
            if (instructions.length === 0) continue;
            bundles.push(
                trade
                    .create_and_send_bundle(instructions, signers, bundle_tip)
                    .then((signature) => common.log(common.green(`Bundle completed, signature: ${signature}`)))
                    .catch((error) => common.error(common.red(`Bundle failed: ${error}`)))
            );
            mint_meta = await trader.update_mint_meta(mint_meta);
        }
        await Promise.allSettled(bundles);
    }
}

export async function sell_token(
    wallets: common.Wallet[],
    mint: PublicKey,
    priority: PriorityLevel = PriorityLevel.DEFAULT,
    program: common.Program = common.Program.Pump,
    bundle_tip?: number,
    percent?: number,
    slippage?: number
): Promise<void> {
    const SLIPPAGE = slippage || COMMANDS_SELL_SLIPPAGE;
    const PERCENT = percent || 1.0;

    if (wallets.length === 0) throw new Error('[ERROR] No wallets available.');

    common.log(common.yellow(`Selling all the tokens from the accounts by the mint ${mint.toString()}...`));
    common.log(common.yellow(`Selling ${PERCENT * 100}% of the tokens...\n`));

    const trader = get_trader(program);
    let mint_meta = await trader.get_mint_meta(mint);
    if (!mint_meta) throw new Error(`[ERROR] Mint metadata not found for program: ${program}.`);

    if (!bundle_tip) {
        const transactions: Promise<void>[] = [];
        for (const wallet of wallets) {
            const seller = wallet.keypair;
            try {
                const token_amount = await trade.get_token_balance(seller.publicKey, mint, COMMITMENT);
                if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) continue;
                const token_amount_to_sell = trade.get_token_amount_by_percent(token_amount, PERCENT);
                common.log(
                    `Selling ${token_amount_to_sell.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
                );
                transactions.push(
                    trader
                        .sell_token(token_amount_to_sell, seller, mint_meta, SLIPPAGE, priority)
                        .then((signature) =>
                            common.log(
                                common.green(`Transaction completed for ${wallet.name}, signature: ${signature}`)
                            )
                        )
                        .catch(() => common.error(common.red(`Transaction failed for ${wallet.name}`)))
                );
                mint_meta = await trader.update_mint_meta(mint_meta);
            } catch (error) {
                common.error(common.red(`Failed to sell the token for ${wallet.name}: ${error}`));
            }
        }
        await Promise.allSettled(transactions);
    } else {
        const wallet_bundles = common.chunks(wallets, JITO_BUNDLE_SIZE);
        const bundles: Promise<void>[] = [];
        let priority_fee: number | undefined = undefined;
        for (const wallet_bundle of wallet_bundles) {
            const instructions: TransactionInstruction[][] = [];
            const signers: Signer[][] = [];
            for (const wallet of wallet_bundle) {
                const seller = wallet.keypair;
                try {
                    const token_amount = await trade.get_token_balance(seller.publicKey, mint, COMMITMENT);
                    if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) continue;
                    const token_amount_to_sell = trade.get_token_amount_by_percent(token_amount, PERCENT);

                    const [instrs] = await trader.sell_token_instructions(
                        token_amount_to_sell,
                        seller,
                        mint_meta,
                        SLIPPAGE
                    );
                    if (priority && !priority_fee) {
                        priority_fee = await trade.get_priority_fee({
                            priority_level: priority,
                            transaction: {
                                instructions: instrs,
                                signers: [seller]
                            }
                        });
                    }
                    instrs.unshift(
                        ComputeBudgetProgram.setComputeUnitPrice({
                            microLamports: priority_fee!
                        })
                    );
                    instructions.push(instrs);
                    signers.push([seller]);
                } catch (error) {
                    common.error(common.red(`Failed to add sell instruction to bundle ${wallet.name}: ${error}`));
                }
            }
            if (instructions.length === 0) continue;
            bundles.push(
                trade
                    .create_and_send_bundle(instructions, signers, bundle_tip)
                    .then((signature) => common.log(common.green(`Bundle completed, signature: ${signature}`)))
                    .catch((error) => common.error(common.red(`Bundle failed: ${error}`)))
            );
            mint_meta = await trader.update_mint_meta(mint_meta);
        }
        await Promise.allSettled(bundles);
    }
}

export async function topup(
    wallets: common.Wallet[],
    amount: number,
    sender: Keypair,
    is_spider: boolean,
    is_random: boolean,
    depth?: number
): Promise<void> {
    if (wallets.length === 0) throw new Error('[ERROR] No wallets available.');
    if (depth && is_spider) throw new Error('[ERROR] Transfers and spider cannot be used together.');
    const total_amount = wallets.length * amount;
    let amounts: number[] = [];

    if (is_random) {
        common.log(common.yellow(`Topping up random amount of SOL to every ${wallets.length} walets...`));
        amounts = common.random_amounts(total_amount, wallets.length);
    } else {
        common.log(common.yellow(`Topping up ${amount} SOL to every ${wallets.length} walets...`));
        amounts = Array.from({ length: wallets.length }, () => amount);
    }

    const balance = (await trade.get_balance(sender.publicKey)) / LAMPORTS_PER_SOL;
    common.log(common.yellow(`Payer address: ${sender.publicKey.toString()} | Balance: ${balance.toFixed(5)} SOL\n`));
    if (balance < total_amount) {
        throw new Error(
            `[ERROR] Payer balance is not enough to top up ${total_amount} SOL to ${wallets.length} wallets`
        );
    }

    if (is_spider) {
        common.log('Running spider:\n');
        const rescue_keys = await transfers.run_spider_transfer(wallets, amount, sender);
        common.log(`\nPerforming cleanup of the temporary wallets...\n`);
        await collect(rescue_keys, sender.publicKey);
        return;
    }

    if (depth) {
        common.log(`Running transfers with depth ${depth}:\n`);
        const rescue_keys = await transfers.run_deep_transfer(wallets, amounts, sender, depth);
        common.log(`\nPerforming cleanup of the temporary wallets...\n`);
        await collect(rescue_keys, sender.publicKey);
        return;
    }

    await transfers.run_reg_transfer(wallets, amounts, sender);
}

export async function start(
    wallets: common.Wallet[],
    program: common.Program = common.Program.Pump,
    json_config?: object
): Promise<void> {
    if (wallets.length === 0) throw new Error('[ERROR] No wallets available.');

    const trader = get_trader(program);
    const sol_price = await common.fetch_sol_price();
    const bot_config = await snipe_common.setup_config(wallets.length, trader, json_config);

    if (bot_config.mint) {
        common.log(common.yellow('Sniping existing mint...'));
    } else if (bot_config.token_name && bot_config.token_ticker) {
        common.log(common.yellow('Sniping token by name and ticker...'));
    }

    let sniper: snipe.ISniper;
    switch (program) {
        case common.Program.Pump: {
            sniper = new PumpRunner(bot_config, trader);
            break;
        }
        case common.Program.Moonshot: {
            sniper = new MoonRunner(bot_config, trader);
            break;
        }
        case common.Program.Generic: {
            throw new Error('[ERROR] Generic program is not supported for sniping.');
        }
        default: {
            throw new Error(`[ERROR] Invalid program received: ${program}`);
        }
    }

    await sniper.snipe(wallets, sol_price);
}

export function generate(count: number, name: string, reserve: boolean, keys_path?: string, index?: number): void {
    common.log(common.yellow(`Generating ${count} keypairs...\n`));

    const wallets: Partial<common.Wallet>[] = [];
    const starting_index = index || 1;

    if (reserve) wallets.push({ keypair: Keypair.generate(), name: 'reserve', is_reserve: true });

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
            } catch {
                throw new Error(`[ERROR] Invalid key at line ${i + 1}`);
            }
        });
    } else {
        for (let i = 0; i < count; i++)
            wallets.push({ keypair: Keypair.generate(), name: `wallet[${i + starting_index}]`, is_reserve: false });
    }

    const writeStream = createWriteStream(name, { encoding: 'utf8' });
    writeStream.write(WALLETS_FILE_HEADERS.join(',') + '\n');
    wallets.forEach((wallet) => {
        if (wallet.name && wallet.keypair) {
            const row = [
                wallet.name,
                bs58.encode(wallet.keypair.secretKey),
                wallet.is_reserve,
                wallet.keypair.publicKey.toString(),
                new Date().toLocaleDateString()
            ].join(',');
            writeStream.write(row + '\n');
        }
    });

    common.log(common.green('Wallet generation completed\n'));
}

export async function wallet_pnl(public_key: PublicKey): Promise<void> {
    const sol_price = await common.fetch_sol_price();

    common.log(common.yellow(`Getting the wallet ${public_key.toString()} PnL...`));
    common.log(`SOL price: $${common.format_currency(sol_price)}\n`);

    const wallet_pnl = await pnl.get_wallet_pnl(public_key, sol_price);

    common.print_header([
        { title: 'Symbol', width: common.COLUMN_WIDTHS.name },
        { title: 'Mint', width: common.COLUMN_WIDTHS.publicKey },
        { title: 'Unrealized($)', width: common.COLUMN_WIDTHS.solBalance, align: 'right' },
        { title: 'Realized($)', width: common.COLUMN_WIDTHS.solBalance, align: 'right' },
        { title: 'Profit($)', width: common.COLUMN_WIDTHS.solBalance, align: 'right' },
        { title: 'Buy/Sell TXs', width: common.COLUMN_WIDTHS.solBalance, align: 'right' }
    ]);

    let total_unrealized = 0;
    let total_realized = 0;
    let total_invested_sol = 0;

    for (const token of wallet_pnl.profit_loss) {
        const unrealized_usd = token.unrealized_pnl * sol_price;
        let realized_usd = token.realized_pnl * sol_price;
        const total_profit_usd = unrealized_usd + realized_usd;

        const buy_txs = token.transactions.filter((tx) => tx.change_sol < 0);
        const sell_txs = token.transactions.filter((tx) => tx.change_sol > 0);
        const buy_cnt = buy_txs.length;
        const sell_cnt = sell_txs.length;

        total_unrealized += unrealized_usd;
        total_realized += realized_usd;

        const total_invested = buy_txs.reduce((sum, tx) => sum + Math.abs(tx.change_sol), 0);
        total_invested_sol += total_invested;

        common.print_row([
            { content: `$${token.symbol}`, width: common.COLUMN_WIDTHS.name },
            { content: token.mint, width: common.COLUMN_WIDTHS.publicKey },
            {
                content: `${common.format_currency(unrealized_usd)}`,
                width: common.COLUMN_WIDTHS.solBalance,
                align: 'right'
            },
            {
                content: `${common.format_currency(realized_usd)}`,
                width: common.COLUMN_WIDTHS.solBalance,
                align: 'right'
            },
            {
                content: `${common.format_currency(total_profit_usd)}`,
                width: common.COLUMN_WIDTHS.solBalance,
                align: 'right'
            },
            { content: `${buy_cnt}/${sell_cnt}`, width: common.COLUMN_WIDTHS.solBalance, align: 'right' }
        ]);
    }

    common.print_footer([
        { width: common.COLUMN_WIDTHS.name },
        { width: common.COLUMN_WIDTHS.publicKey },
        { width: common.COLUMN_WIDTHS.solBalance },
        { width: common.COLUMN_WIDTHS.solBalance },
        { width: common.COLUMN_WIDTHS.solBalance },
        { width: common.COLUMN_WIDTHS.solBalance }
    ]);

    const total = total_realized + total_unrealized;
    const total_invested_usd = total_invested_sol * sol_price;
    const total_pnl = total_invested_usd > 0 ? (total / total_invested_usd) * 100 : 0;

    let accent = total_realized > 0 ? common.green : common.red;
    common.log(`\nTotal Realized: ${accent('$' + common.format_currency(total_realized))}`);

    accent = total_unrealized > 0 ? common.green : common.red;
    common.log(`Total Unrealized: ${accent('$' + common.format_currency(total_unrealized))}`);

    accent = total > 0 ? common.green : common.red;
    common.log(
        `Total Profit: ${accent('$' + common.format_currency(total))} | ${accent(common.format_currency(total / sol_price) + 'SOL')}`
    );

    accent = total_pnl > 0 ? common.green : common.red;
    common.log(`Total PnL: ${accent(total_pnl.toFixed(2) + '%')}\n`);
}

export async function start_volume(json_config?: object): Promise<void> {
    const volume_config = await volume.setup_config(json_config);
    const volume_type_name = volume.VolumeTypeStrings[volume_config.type];

    if (volume_config.simulate) {
        common.log(common.yellow(`Simulating the ${volume_type_name} Volume Bot...\n`));
        const results = await volume.simulate(volume_config);

        if (volume_config.type === volume.VolumeType.Natural)
            common.log(common.red('Natural Volume simulation results may differ from the actual results\n'));

        common.log(common.bold('Simulation Results:'));
        common.log(`Current SOL price: $${common.format_currency(results.sol_price)}`);
        common.log(`Total SOL used: ${common.format_currency(results.total_sol)}`);
        common.log(`\nTotal SOL spent on fees: ${common.format_currency(results.total_tax_sol)}`);
        common.log(`Total USD spent on fees: $${common.format_currency(results.total_tax_usd)}`);
        common.log(`\nTotal volume in SOL: ${common.format_currency(results.total_volume_sol)}`);
        common.log(`Total volume in USD: ${common.bold('$' + common.format_currency(results.total_volume_usd))}`);
        return;
    }

    common.log(common.yellow(`Starting the ${volume_type_name} Volume Bot...`));

    switch (volume_config.type) {
        case volume.VolumeType.Fast: {
            await volume.execute_fast(volume_config);
            break;
        }
        case volume.VolumeType.Natural: {
            await volume.execute_natural(volume_config);
            break;
        }
        default:
            throw new Error('[ERROR] Invalid Volume Bot type.');
    }
}

export async function benchmark(
    NUM_REQUESTS: number,
    test_public_key: string,
    batch_size = 10,
    update_interval = 10
): Promise<void> {
    const public_key = new PublicKey(test_public_key);

    let total_call_time = 0;
    let min_time = Number.MAX_VALUE;
    let max_time = 0;
    let errors = 0;
    let calls = 0;
    const connection = new Connection(HELIUS_RPC, { disableRetryOnRateLimit: true });
    const start_time = process.hrtime();

    const task_queue = Array.from({ length: NUM_REQUESTS }, (_, i) => i);
    async function worker(): Promise<void> {
        while (task_queue.length > 0) {
            const i = task_queue.shift();
            if (i === undefined) return;

            calls++;
            const startTime = process.hrtime();

            try {
                await connection.getBalance(public_key);
            } catch (error) {
                errors++;
                continue;
            }

            const [seconds, nanoseconds] = process.hrtime(startTime);
            const elapsed_time = seconds * 1000 + nanoseconds / 1e6;
            total_call_time += elapsed_time;

            if (elapsed_time < min_time) min_time = elapsed_time;
            if (elapsed_time > max_time) max_time = elapsed_time;

            if ((i + 1) % update_interval === 0 || i === NUM_REQUESTS - 1) {
                const avgTime = total_call_time / (i + 1 - errors);
                const tps = (i + 1 - errors) / (total_call_time / 1000);

                process.stdout.write(
                    `\r[${i + 1}/${NUM_REQUESTS}] | ` +
                        `Errors: ${errors} | ` +
                        `Avg Time: ${avgTime.toFixed(2)} ms | ` +
                        `Min Time: ${min_time.toFixed(2)} ms | ` +
                        `Max Time: ${max_time.toFixed(2)} ms | ` +
                        `TPS: ${tps.toFixed(2)}`
                );
            }
        }
    }
    const workers = Array.from({ length: batch_size }, () => worker());
    await Promise.all(workers);

    const end_time = process.hrtime(start_time);
    const total_elapsed_time = end_time[0] * 1000 + end_time[1] / 1e6;
    const avg_time = total_elapsed_time / (NUM_REQUESTS - errors);
    const tps = (NUM_REQUESTS - errors) / (total_elapsed_time / 1000);

    common.log(common.green(`\n\nBenchmark Results:`));
    common.log(`Total Requests: ${NUM_REQUESTS}`);
    common.log(`Successful Requests: ${NUM_REQUESTS - errors}`);
    common.log(`Failed Requests: ${errors}`);
    common.log(`Total Time: ${total_elapsed_time.toFixed(2)} ms`);
    common.log(`Average Time per Request: ${avg_time.toFixed(2)} ms`);
    common.log(`Min Time: ${min_time.toFixed(2)} ms`);
    common.log(`Max Time: ${max_time.toFixed(2)} ms`);
    common.log(`Estimated TPS: ${tps.toFixed(2)}`);
}

export async function drop(
    airdrop_percent: number,
    mint: PublicKey,
    drop: Keypair,
    presale_percent: number = 0
): Promise<void> {
    common.log(common.yellow(`Dropping the mint ${mint.toString()}...`));
    common.log(common.yellow(`Airdrop percent: ${airdrop_percent}% | Presale percent: ${presale_percent}%`));

    const mint_meta = await trade.get_token_meta(mint);
    common.log(`Token name: ${mint_meta.token_name} | Symbol: ${mint_meta.token_symbol}\n`);

    let token_balance: number = 0;
    try {
        const balance = await trade.get_token_balance(drop.publicKey, mint_meta.mint);
        token_balance = Math.floor(balance.uiAmount || 0);
        common.log(
            common.yellow(
                `Drop address: ${drop.publicKey.toString()} | Balance: ${token_balance} ${mint_meta.token_symbol}\n`
            )
        );
    } catch (err) {
        throw new Error('[ERROR] Failed to process dropper file');
    }

    token_drop.execute(drop, token_balance, mint_meta, airdrop_percent, presale_percent);
}
