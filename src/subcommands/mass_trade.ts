import { ComputeBudgetProgram, LAMPORTS_PER_SOL, Signer, TransactionInstruction } from '@solana/web3.js';
import * as common from '../common/common.js';
import * as trade from '../common/trade_common.js';
import { COMMITMENT, JITO_BUNDLE_SIZE, PriorityLevel } from '../constants.js';

export async function bundle_buy(
    mint_meta: trade.IMintMeta,
    wallets: common.Wallet[],
    trader: trade.IProgramTrader,
    amount: number | undefined,
    min: number | undefined,
    max: number | undefined,
    slippage: number,
    bundle_tip: number,
    priority: PriorityLevel
): Promise<void> {
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
                const [instrs] = await trader.buy_token_instructions(buy_amount, buyer, mint_meta, slippage);
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

export async function bundle_sell(
    mint_meta: trade.IMintMeta,
    wallets: common.Wallet[],
    trader: trade.IProgramTrader,
    percent: number,
    slippage: number,
    bundle_tip: number,
    priority: PriorityLevel
): Promise<void> {
    const wallets_with_balance = (
        await Promise.all(
            wallets.map(async (wallet) => {
                const token_amount = await trade.get_token_balance(
                    wallet.keypair.publicKey,
                    mint_meta.mint_pubkey,
                    COMMITMENT
                );
                if (token_amount && token_amount.uiAmount && token_amount.uiAmount > 0) {
                    return {
                        ...wallet,
                        token_amount
                    };
                }
                return null;
            })
        )
    ).filter((wallet) => wallet !== null);

    const wallet_bundles = common.chunks(wallets_with_balance, JITO_BUNDLE_SIZE);
    const bundles: Promise<void>[] = [];
    let priority_fee: number | undefined = undefined;

    for (const wallet_bundle of wallet_bundles) {
        const instructions: TransactionInstruction[][] = [];
        const signers: Signer[][] = [];
        for (const wallet of wallet_bundle) {
            const seller = wallet.keypair;
            const token_amount_to_sell = trade.get_token_amount_by_percent(wallet.token_amount, percent);
            try {
                common.log(
                    `Selling ${token_amount_to_sell.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
                );
                const [instrs] = await trader.sell_token_instructions(
                    token_amount_to_sell,
                    seller,
                    mint_meta,
                    slippage
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

export async function seq_buy(
    mint_meta: trade.IMintMeta,
    wallets: common.Wallet[],
    trader: trade.IProgramTrader,
    amount: number | undefined,
    min: number | undefined,
    max: number | undefined,
    slippage: number,
    priority: PriorityLevel,
    protection_tip?: number
): Promise<void> {
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
                    .buy_token(buy_amount, buyer, mint_meta, slippage, priority, protection_tip)
                    .then((signature) =>
                        common.log(common.green(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                    )
                    .catch((error) =>
                        common.error(
                            common.red(`Transaction failed for ${wallet.name} (${wallet.id}): ${error.message}`)
                        )
                    )
            );
            mint_meta = await trader.update_mint_meta(mint_meta);
        } catch (error) {
            common.error(common.red(`Failed to buy the token for ${wallet.name}: ${error}`));
        }
    }
    await Promise.allSettled(transactions);
}

export async function seq_sell(
    mint_meta: trade.IMintMeta,
    wallets: common.Wallet[],
    trader: trade.IProgramTrader,
    percent: number,
    slippage: number,
    priority: PriorityLevel,
    protection_tip?: number
): Promise<void> {
    const transactions: Promise<void>[] = [];

    for (const wallet of wallets) {
        const seller = wallet.keypair;
        try {
            const token_amount = await trade.get_token_balance(seller.publicKey, mint_meta.mint_pubkey, COMMITMENT);
            if (!token_amount || token_amount.uiAmount === 0 || !token_amount.uiAmount) continue;
            const token_amount_to_sell = trade.get_token_amount_by_percent(token_amount, percent);
            common.log(
                `Selling ${token_amount_to_sell.uiAmount} tokens from ${seller.publicKey.toString().padEnd(44, ' ')} (${wallet.name})...`
            );
            transactions.push(
                trader
                    .sell_token(token_amount_to_sell, seller, mint_meta, slippage, priority, protection_tip)
                    .then((signature) =>
                        common.log(common.green(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                    )
                    .catch((error) =>
                        common.error(
                            common.red(`Transaction failed for ${wallet.name} (${wallet.id}): ${error.message}`)
                        )
                    )
            );
            mint_meta = await trader.update_mint_meta(mint_meta);
        } catch (error) {
            common.error(common.red(`Failed to sell the token for ${wallet.name}: ${error}`));
        }
    }
    await Promise.allSettled(transactions);
}
