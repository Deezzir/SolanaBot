import { PublicKey, ParsedTransactionWithMeta, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as common from '../common/common.js';
import { PNL_BATCH_DELAY_MS, PNL_BATCH_SIZE, SOL_MINT } from '../constants.js';
import { get_all_signatures, get_token_meta } from '../common/trade_common.js';

interface TransactionBalanceChanges {
    pre_sol_balance: number;
    post_sol_balance: number;
    pre_token_balance: number;
    post_token_balance: number;
    change_sol: number;
    change_tokens: number;
}

interface TransactionWithBalances extends ParsedTransactionWithMeta {
    balance_changes: TransactionBalanceChanges;
    transaction_data: {
        mint?: string;
        signature: string;
    };
}

interface ProfitLossTX {
    signature: string;
    change_sol: number;
    change_tokens: number;
    timestamp?: number;
}

interface ProfitLoss {
    mint: string;
    name: string;
    symbol: string;
    realized_pnl: number;
    unrealized_pnl: number;
    token_balance: number;
    transactions: ProfitLossTX[];
}

interface WalletPNL {
    address: PublicKey;
    profit_loss: ProfitLoss[];
    total_realized_pnl: number;
    total_unrealized_pnl: number;
}

function lamports_to_sol(lamports: number): number {
    return lamports / LAMPORTS_PER_SOL;
}

function get_default_transaction_balance_changes(): TransactionBalanceChanges {
    return {
        pre_sol_balance: 0.0,
        post_sol_balance: 0.0,
        pre_token_balance: 0.0,
        post_token_balance: 0.0,
        change_sol: 0.0,
        change_tokens: 0.0
    };
}

function calculate_balance_changes(tx: ParsedTransactionWithMeta, public_key: PublicKey): TransactionBalanceChanges {
    if (!tx.meta || !tx.meta.postTokenBalances || !tx.meta.preTokenBalances) {
        return get_default_transaction_balance_changes();
    }

    const change_sol_index = tx.transaction.message.accountKeys.findIndex((account) =>
        account.pubkey.equals(public_key)
    );
    const pre_token_balance_index = tx.meta.preTokenBalances.findIndex(
        (change) => change.owner === public_key.toString()
    );
    const post_token_balance_index = tx.meta.postTokenBalances.findIndex(
        (change) => change.owner === public_key.toString()
    );

    const pre_sol_balance = lamports_to_sol(tx.meta.preBalances[change_sol_index]);
    const post_sol_balance = lamports_to_sol(tx.meta.postBalances[change_sol_index]);

    let pre_token_balance = 0.0;
    let post_token_balance = 0.0;

    if (pre_token_balance_index !== -1)
        pre_token_balance = tx.meta.preTokenBalances[pre_token_balance_index].uiTokenAmount.uiAmount || 0.0;

    if (post_token_balance_index !== -1)
        post_token_balance = tx.meta.postTokenBalances[post_token_balance_index].uiTokenAmount.uiAmount || 0.0;

    const change_sol = post_sol_balance - pre_sol_balance;
    const change_tokens = post_token_balance - pre_token_balance;

    return {
        pre_sol_balance,
        post_sol_balance,
        pre_token_balance,
        post_token_balance,
        change_sol,
        change_tokens
    };
}

async function get_transactions(signatures: string[]): Promise<(ParsedTransactionWithMeta | null)[]> {
    return common.retry_with_backoff(() =>
        global.CONNECTION.getParsedTransactions(signatures, {
            maxSupportedTransactionVersion: 0
        })
    );
}

async function fetch_transaction_batch(signatures: string[]): Promise<(ParsedTransactionWithMeta | null)[]> {
    return common.retry_with_backoff(async () => {
        const transactions: (ParsedTransactionWithMeta | null)[] = [];
        const signature_chunks = common.chunks(signatures, PNL_BATCH_SIZE);

        for (const chunk of signature_chunks) {
            const parsed_transactions = await get_transactions(chunk);
            transactions.push(...parsed_transactions);
            await common.sleep(PNL_BATCH_DELAY_MS);
        }
        return transactions;
    });
}

function extract_transaction_data(tx: ParsedTransactionWithMeta): {
    mint?: string;
    signature: string;
} {
    let mint;
    // First check token balances for mint
    if (tx.meta) {
        if (tx.meta.preTokenBalances && tx.meta.preTokenBalances.length > 0) {
            for (const token_balance of tx.meta.preTokenBalances) {
                if (token_balance.mint && token_balance.mint !== SOL_MINT.toString()) {
                    mint = token_balance.mint;
                    break;
                }
            }
        }

        // If not found in pre balances, check post balances
        if (!mint && tx.meta.postTokenBalances && tx.meta.postTokenBalances.length > 0) {
            for (const token_balance of tx.meta.postTokenBalances) {
                if (token_balance.mint && token_balance.mint !== SOL_MINT.toString()) {
                    mint = token_balance.mint;
                    break;
                }
            }
        }
    }

    // If still no mint found, check instructions
    if (!mint && tx.transaction?.message?.instructions) {
        for (const instruction of tx.transaction.message.instructions) {
            if ('parsed' in instruction && instruction.parsed?.info?.mint) {
                mint = instruction.parsed.info.mint;
                break;
            }
        }

        if (!mint && tx.meta?.innerInstructions) {
            for (const inner_instruction_set of tx.meta.innerInstructions) {
                for (const instruction of inner_instruction_set.instructions) {
                    if ('parsed' in instruction && instruction.parsed?.info?.mint) {
                        mint = instruction.parsed.info.mint;
                        break;
                    }
                }
                if (mint) break;
            }
        }
    }

    return {
        signature: tx.transaction.signatures[0],
        mint
    };
}

async function calculate_profit_loss(
    transactions: TransactionWithBalances[],
    sol_price: number
): Promise<ProfitLoss[]> {
    const mint_entries = new Map<
        string,
        {
            total_sol_change: number;
            total_tokens_change: number;
            transactions: ProfitLossTX[];
        }
    >();

    for (const tx of transactions) {
        if (!tx.transaction_data.mint) continue;
        const mint = tx.transaction_data.mint;
        const change_sol = tx.balance_changes.change_sol;
        const change_tokens = tx.balance_changes.change_tokens;

        if (change_sol > 0 && change_tokens == 0) continue;

        if (!mint_entries.has(mint)) {
            mint_entries.set(mint, {
                total_sol_change: 0,
                total_tokens_change: 0,
                transactions: []
            });
        }

        const mint_entry = mint_entries.get(mint)!;
        mint_entry.total_sol_change += change_sol;
        mint_entry.total_tokens_change += change_tokens;
        mint_entry.transactions.push({
            signature: tx.transaction_data.signature,
            change_sol: tx.balance_changes.change_sol,
            change_tokens: tx.balance_changes.change_tokens,
            timestamp: tx.blockTime || undefined
        });
    }

    const profit_loss_promises = Array.from(mint_entries.entries()).map(async ([mint, data]) => {
        let token_price = 0.0;
        let name = 'Unknown';
        let symbol = 'Unknown';
        const meta = await get_token_meta(new PublicKey(mint));
        if (meta) {
            token_price = meta.price_per_token / sol_price;
            name = meta.token_name;
            symbol = meta.token_symbol;
        }
        let unrealized_pnl = data.total_tokens_change * token_price;
        if (unrealized_pnl < 1e-2 && unrealized_pnl > -1e-2) unrealized_pnl = 0.0;
        return {
            mint,
            name,
            symbol,
            realized_pnl: data.total_sol_change,
            unrealized_pnl,
            token_balance: data.total_tokens_change,
            transactions: data.transactions.sort((a, b) => {
                if (!a.timestamp || !b.timestamp) return 0;
                return b.timestamp - a.timestamp;
            })
        };
    });

    return Promise.all(profit_loss_promises);
}

export async function get_wallet_pnl(public_key: PublicKey, sol_price: number): Promise<WalletPNL> {
    try {
        common.log(`Fetching all signatures for wallet ${public_key.toString()}...`);
        const signatures = await get_all_signatures(public_key);
        common.log(`Found ${signatures.length} total transactions\n`);

        const signature_chunks = common.chunks(
            signatures.map((sig) => sig.signature),
            PNL_BATCH_SIZE
        );

        const all_transactions: (ParsedTransactionWithMeta | null)[] = [];
        for (const chunk of signature_chunks) {
            const batch_transactions = await fetch_transaction_batch(chunk);
            all_transactions.push(...batch_transactions);
            await common.sleep(PNL_BATCH_DELAY_MS);
        }

        const processed_transactions: TransactionWithBalances[] = all_transactions
            .map((tx) => {
                if (!tx) return;
                const tx_data = extract_transaction_data(tx);
                if (!tx_data.mint) return;

                return {
                    balance_changes: calculate_balance_changes(tx, public_key),
                    transaction_data: tx_data,
                    ...tx
                };
            })
            .filter((tx) => tx !== undefined);

        const profit_loss = await calculate_profit_loss(processed_transactions, sol_price);
        const total_realized_pnl = profit_loss.reduce((acc, cur) => acc + cur.realized_pnl, 0.0);
        const total_unrealized_pnl = profit_loss.reduce((acc, cur) => acc + cur.unrealized_pnl, 0.0);

        return {
            address: public_key,
            profit_loss,
            total_realized_pnl,
            total_unrealized_pnl
        };
    } catch (error) {
        common.error(`Error fetching connected wallets and transactions: ${error}`);
        throw error;
    }
}
