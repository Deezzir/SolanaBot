import {
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    Signer,
    SystemProgram,
    TokenAmount,
    TransactionInstruction,
    VersionedTransaction,
    TransactionMessage,
    RpcResponseAndContext,
    ComputeBudgetProgram,
    Commitment
} from '@solana/web3.js';
import {
    AccountLayout,
    TokenAccountNotFoundError,
    TokenInvalidAccountOwnerError,
    createAssociatedTokenAccountInstruction,
    createCloseAccountInstruction,
    createInitializeAccountInstruction,
    createTransferInstruction,
    getAccount,
    getAssociatedTokenAddress,
    getMint
} from '@solana/spl-token';
import { Metaplex } from '@metaplex-foundation/js';
import { CreateMetadataAccountV3InstructionData, getCreateMetadataAccountV3InstructionDataSerializer } from '@metaplex-foundation/mpl-token-metadata';
import {
    Liquidity,
    LiquidityPoolInfo,
    LiquidityPoolKeys,
    Percent,
    Token,
    TokenAmount as RayTokenAmount,
    LIQUIDITY_STATE_LAYOUT_V4,
    MARKET_STATE_LAYOUT_V3,
    MAINNET_PROGRAM_ID,
    CurrencyAmount
} from '@raydium-io/raydium-sdk';
import fetch from 'cross-fetch';
import { Wallet } from '@project-serum/anchor';
import BN from 'bn.js';
import * as common from './common.js';
import bs58 from 'bs58';

const SWAP_SEED = 'swap';
const DEFAULT_CURVE_TOKEN_DECIMALS = 6;

export const SOL_MINT = new PublicKey(process.env.SOLANA_TOKEN || 'So11111111111111111111111111111111111111112');

const TOKEN_PROGRAM_ID = new PublicKey(process.env.TOKEN_PROGRAM_ID || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const JUPITER_API_URL = process.env.JUPITER_API_URL || 'https://quote-api.jup.ag/v6/';
const RAYDIUM_AUTHORITY = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');

const MAX_RETRIES = 2;

export interface IMintMetaPrinter {
    readonly name: string;
    readonly symbol: string;
    readonly mint: string;
    readonly usd_mc: number;
}

export interface IProgramTrader {
    buy_token(sol_amount: number, buyer: Signer, mint_meta: object, slippage: number, priority?: PriorityLevel): Promise<String>;
    sell_token(token_amount: TokenAmount, seller: Signer, mint_meta: Partial<object>, slippage: number, priority?: PriorityLevel): Promise<String>;
    get_mint_meta(mint: string): Promise<object | undefined>;
    create_token(creator: Signer, meta: common.IPFSMetadata, cid: string, mint?: Keypair, sol_amount?: number): Promise<[String, PublicKey]>;
    get_random_mints(count: number): Promise<object[]>;
    init_mint_meta(mint: PublicKey, sol_price: number): Promise<object>;
    update_mint_meta_reserves(mint_meta: object, sol_price: number): Promise<object | undefined>;
    get_meta_printer(mint_meta: object): IMintMetaPrinter;
}

export enum PriorityLevel {
    MIN = 'Min',
    LOW = 'Low',
    MEDIUM = 'Medium',
    HIGH = 'High',
    VERY_HIGH = 'VeryHigh',
    UNSAFE_MAX = 'UnsafeMax',
    DEFAULT = 'Default'
}

type PriorityOptions = {
    accounts?: string[];
    priority_level: PriorityLevel;
};

type RaydiumAmounts = {
    amount_in: RayTokenAmount;
    token_in: PublicKey;
    token_out: PublicKey;
    min_amount_out: CurrencyAmount;
};

export type MintMeta = {
    token_name: string;
    token_symbol: string;
    token_decimals: number;
    mint: PublicKey;
};

export function decode_metaplex_instr(data: string): [CreateMetadataAccountV3InstructionData, number] {
    const serializer = getCreateMetadataAccountV3InstructionDataSerializer();
    const decoded = serializer.deserialize(bs58.decode(data));
    return decoded;
}

export async function check_account_exists(account: PublicKey): Promise<boolean | undefined> {
    try {
        let account_info = await getAccount(global.CONNECTION, account);
        if (account_info && account_info.isInitialized) return true;
    } catch (error) {
        if (error instanceof TokenAccountNotFoundError || error instanceof TokenInvalidAccountOwnerError) {
            return false;
        } else {
            throw new Error(`[ERROR] Failed to check the account: ${error}`);
        }
    }
}

export async function get_token_supply(mint: PublicKey): Promise<{ supply: bigint; decimals: number }> {
    try {
        const mint_data = await getMint(global.CONNECTION, mint, 'confirmed');
        return { supply: mint_data.supply, decimals: mint_data.decimals };
    } catch (err) {
        common.error(`[ERROR] Failed to get the token supply: ${err}`);
        return {
            supply: BigInt(1_000_000_000 * 10 ** DEFAULT_CURVE_TOKEN_DECIMALS),
            decimals: DEFAULT_CURVE_TOKEN_DECIMALS
        };
    }
}

export async function get_balance(pubkey: PublicKey): Promise<number> {
    return await global.CONNECTION.getBalance(pubkey);
}

// function is_bundle_error<T>(value: T | Error): value is Error {
//     return value instanceof Error;
// }

// export async function create_and_send_tipped_tx(instructions: TransactionInstruction[], payer: Signer, signers: Signer[], tip: number): Promise<String> {
//     try {
//         const ctx = await global.CONNECTION.getLatestBlockhashAndContext('confirmed');
//         const c = jito.searcher.searcherClient(JITOTIP_BLOCK_URL, JITOTIP_AUTH_KEY);

//         instructions.unshift(
//             SystemProgram.transfer({
//                 fromPubkey: payer.publicKey,
//                 toPubkey: JITOTIP,
//                 lamports: tip * LAMPORTS_PER_SOL
//             })
//         );

//         const versioned_tx = new VersionedTransaction(
//             new TransactionMessage({
//                 payerKey: payer.publicKey,
//                 recentBlockhash: ctx.value.blockhash,
//                 instructions: instructions.filter(Boolean)
//             }).compileToV0Message()
//         );
//         versioned_tx.sign(signers);

//         let signature = bs58.encode(Buffer.from(versioned_tx.signatures[0]));
//         let bundle = new jito.bundle.Bundle([versioned_tx], 1);

//         if (!is_bundle_error(bundle)) {
//             try {
//                 await c.sendBundle(bundle);
//                 await check_transaction_status(signature, ctx);
//                 return signature;
//             } catch (e) {
//                 throw new Error(`Failed to send a bundle: ${e}`);
//             }
//         } else {
//             throw new Error(`Failed to create a bundle: ${bundle}`);
//         }
//     } catch (err) {
//         throw new Error(`Failed to send tipped transaction: ${err}`);
//     }
// }

async function is_blockhash_expired(last_valid_block_height: number): Promise<boolean> {
    let current_block_height = await global.CONNECTION.getBlockHeight('confirmed');
    return last_valid_block_height - current_block_height < 0;
}

async function check_transaction_status(
    signature: string,
    context: RpcResponseAndContext<Readonly<{ blockhash: string; lastValidBlockHeight: number }>>
): Promise<void> {
    const retry_interval = 1000;
    while (true) {
        const { value: status } = await global.CONNECTION.getSignatureStatus(signature, {
            searchTransactionHistory: true
        });

        if (status) {
            if ((status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') && status.err === null) {
                return;
            }
            if (status.err) throw new Error(`Transaction failed | Signature: ${signature} | Error: ${status.err}`);
        }

        const is_expired = await is_blockhash_expired(context.value.lastValidBlockHeight);
        if (is_expired) throw new Error('Blockhash has expired.');

        await common.sleep(retry_interval);
    }
}

async function get_priority_fee(priority: PriorityOptions): Promise<number> {
    const response = await global.HELIUS_CONNECTION.rpc.getPriorityFeeEstimate({
        accountKeys: priority.accounts,
        options: {
            priorityLevel: priority.priority_level
        }
    });
    return Math.floor(response.priorityFeeEstimate || 0);
}

export async function create_and_send_smart_tx(instructions: TransactionInstruction[], signers: Signer[]) {
    return await global.HELIUS_CONNECTION.rpc.sendSmartTransaction(instructions, signers, [], {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: MAX_RETRIES
    });
}

export async function create_and_send_tx(instructions: TransactionInstruction[], signers: Signer[], priority?: PriorityOptions): Promise<String> {
    if (signers.length === 0) throw new Error(`[ERROR] No signers provided.`);

    if (priority) {
        const fee = await get_priority_fee(priority);
        instructions.unshift(
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: fee
            })
        );
    }
    const ctx = await global.CONNECTION.getLatestBlockhashAndContext('confirmed');

    const versioned_tx = new VersionedTransaction(
        new TransactionMessage({
            payerKey: signers[0].publicKey,
            recentBlockhash: ctx.value.blockhash,
            instructions: instructions.filter(Boolean)
        }).compileToV0Message()
    );

    versioned_tx.sign(signers);

    const signature = await global.CONNECTION.sendTransaction(versioned_tx, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: MAX_RETRIES
    });

    await check_transaction_status(signature, ctx);
    return signature;
}

export async function get_balance_change(signature: string, address: PublicKey): Promise<number> {
    try {
        const tx_details = await global.CONNECTION.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
        });
        if (!tx_details) throw new Error(`[ERROR] Transaction not found: ${signature}`);
        const balance_index = tx_details?.transaction.message.getAccountKeys().staticAccountKeys.findIndex((i) => i.equals(address));
        if (balance_index !== undefined && balance_index !== -1) {
            const pre_balance = tx_details?.meta?.preBalances[balance_index] || 0;
            const post_balance = tx_details?.meta?.postBalances[balance_index] || 0;
            return (pre_balance - post_balance) / LAMPORTS_PER_SOL;
        }
        return 0;
    } catch (err) {
        throw new Error(`[ERROR] Failed to get the balance change: ${err}`);
    }
}

export async function check_has_balances(wallets: common.Wallet[], min_balance: number = 0): Promise<boolean> {
    let ok = true;

    try {
        const balance_checks = wallets.map(async (wallet) => {
            const holder = wallet.keypair;
            try {
                const lamports = await get_balance(holder.publicKey);
                const sol_balance = lamports / LAMPORTS_PER_SOL;
                if (sol_balance <= min_balance) {
                    common.error(`Address: ${holder.publicKey.toString().padEnd(44, ' ')} has no balance. (wallet ${wallet.id})`);
                    ok = false;
                }
            } catch (err) {
                common.error(`Failed to get the balance: ${err} for 'wallet ${wallet.id}'`);
                ok = false;
            }
        });

        await Promise.all(balance_checks);

        if (!ok) common.error('[ERROR] Some accounts are empty.');
        return ok;
    } catch (err) {
        common.error(`[ERROR] failed to process keys: ${err}`);
        return false;
    }
}

export async function send_lamports(lamports: number, sender: Signer, receiver: PublicKey, priority?: PriorityLevel): Promise<String> {
    let instructions: TransactionInstruction[] = [];
    let fees = 0;
    let units = 500;

    if (priority) {
        fees = Math.floor(
            await get_priority_fee({
                priority_level: priority,
                accounts: ['11111111111111111111111111111111']
            })
        );
        instructions.push(
            ComputeBudgetProgram.setComputeUnitLimit({
                units: units
            })
        );

        instructions.push(
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: fees
            })
        );
    }

    instructions.push(
        SystemProgram.transfer({
            fromPubkey: sender.publicKey,
            toPubkey: receiver,
            lamports: lamports - 5000 - Math.ceil((fees * units) / 10 ** 6)
        })
    );

    return await create_and_send_tx(instructions, [sender]);
}

export async function calc_assoc_token_addr(owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
    let ata = await getAssociatedTokenAddress(mint, owner, true);
    return ata;
}

export async function get_token_meta(mint: PublicKey): Promise<MintMeta> {
    const metaplex = Metaplex.make(global.CONNECTION);

    const metaplex_acc = metaplex.nfts().pdas().metadata({ mint });

    const metaplex_acc_info = await global.CONNECTION.getAccountInfo(metaplex_acc);

    if (metaplex_acc_info) {
        const token = await metaplex.nfts().findByMint({ mintAddress: mint });
        return {
            token_name: token.name,
            token_symbol: token.symbol,
            token_decimals: token.mint.decimals,
            mint: mint
        };
    }

    throw new Error(`Failed to get the token metadata.`);
}

export async function get_token_balance(pubkey: PublicKey, mint: PublicKey, commitment: Commitment = 'finalized'): Promise<TokenAmount> {
    try {
        const assoc_addres = await calc_assoc_token_addr(pubkey, mint);
        const account_info = await global.CONNECTION.getTokenAccountBalance(assoc_addres, commitment);
        return account_info.value;
    } catch (err) {
        return {
            uiAmount: null,
            amount: '0',
            decimals: 0
        };
    }
}

export async function send_tokens(token_amount: number, sender: PublicKey, receiver: PublicKey, owner: Signer): Promise<String> {
    let instructions: TransactionInstruction[] = [];
    instructions.push(createTransferInstruction(sender, receiver, owner.publicKey, token_amount));

    return await create_and_send_smart_tx(instructions, [owner]);
}

export async function create_assoc_token_account(payer: Signer, owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
    try {
        const assoc_address = await calc_assoc_token_addr(owner, mint);
        if (!(await check_account_exists(assoc_address))) {
            let instructions: TransactionInstruction[] = [];
            instructions.push(createAssociatedTokenAccountInstruction(payer.publicKey, assoc_address, owner, mint));
            await create_and_send_smart_tx(instructions, [payer]);
        }
        return assoc_address;
    } catch (err) {
        throw new Error(`Max retries reached, failed to get associated token account. Last error: ${err}`);
    }
}

export async function swap_jupiter(
    amount: TokenAmount,
    seller: Signer,
    from: PublicKey,
    to: PublicKey,
    slippage: number = 0.05,
    priority?: PriorityLevel
): Promise<String> {
    const wallet = new Wallet(Keypair.fromSecretKey(seller.secretKey));
    const amount_in = amount.amount;
    let fees = 0.0;
    const url = `${JUPITER_API_URL}quote?inputMint=${from.toString()}&outputMint=${to.toString()}&amount=${amount_in}&slippageBps=${slippage * 10000}`;

    const quoteResponse = await (await fetch(url)).json();

    if (quoteResponse.errorCode) {
        throw new Error(`Failed to get the quote: ${quoteResponse.error}`);
    }

    if (priority) {
        fees = await get_priority_fee({
            priority_level: priority,
            accounts: ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4']
        });
    }

    const { swapTransaction } = await (
        await fetch(`${JUPITER_API_URL}swap`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                quoteResponse,
                userPublicKey: wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                computeUnitPriceMicroLamports: fees
            })
        })
    ).json();

    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    var tx = VersionedTransaction.deserialize(swapTransactionBuf);
    tx.sign([wallet.payer]);

    const signature = await CONNECTION.sendRawTransaction(tx.serialize());
    const latestBlockHash = await CONNECTION.getLatestBlockhash();
    await CONNECTION.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: signature
    });
    return signature;
}

export async function close_accounts(owner: Wallet): Promise<PublicKey[]> {
    const token_accounts = await global.CONNECTION.getTokenAccountsByOwner(owner.publicKey, {
        programId: TOKEN_PROGRAM_ID
    });
    const deserialized = token_accounts.value.map((acc) => {
        return {
            pubkey: acc.pubkey,
            data: AccountLayout.decode(acc.account.data)
        };
    });
    const unsold = deserialized
        .filter((acc) => acc.data.amount !== BigInt(0))
        .map(async (acc) => {
            const mint = acc.data.mint;
            const { decimals } = await get_token_supply(mint);
            const balance = Number(acc.data.amount) / 10 ** decimals;
            common.log(`Unsold mint: ${mint.toString()} | Balance: ${balance.toString()}`);
            return acc.data.mint;
        });

    const accounts = deserialized.filter((acc) => acc.data.amount === BigInt(0));

    for (const chunk of common.chunks(accounts, 15)) {
        while (true) {
            const intructions: TransactionInstruction[] = [];
            for (const account of chunk) {
                intructions.push(createCloseAccountInstruction(account.pubkey, owner.publicKey, owner.publicKey));
            }

            try {
                const signature = await create_and_send_smart_tx(intructions, [owner.payer]);
                common.log(`${chunk.length} accounts closed | Signature ${signature}`);
                break;
            } catch (err) {
                common.error(`Failed to close accounts: ${err}, retrying...`);
            }
        }
    }
    return await Promise.all(unsold);
}

async function calc_raydium_amounts(
    pool_keys: LiquidityPoolKeys,
    pool_info: LiquidityPoolInfo,
    token_buy: PublicKey,
    amount_in: number,
    raw_slippage: number
): Promise<RaydiumAmounts> {
    let mint_token_out = token_buy;
    let token_out_decimals = pool_keys.baseMint.equals(mint_token_out) ? pool_info.baseDecimals : pool_keys.quoteDecimals;
    let mint_token_in = pool_keys.baseMint.equals(mint_token_out) ? pool_keys.quoteMint : pool_keys.baseMint;
    let token_in_decimals = pool_keys.baseMint.equals(mint_token_out) ? pool_info.quoteDecimals : pool_info.baseDecimals;

    const token_in = new Token(TOKEN_PROGRAM_ID, mint_token_in, token_in_decimals);
    const token_amount_in = new RayTokenAmount(token_in, amount_in, false);
    const token_out = new Token(TOKEN_PROGRAM_ID, mint_token_out, token_out_decimals);
    const slippage = new Percent(raw_slippage, 100);
    const { minAmountOut } = Liquidity.computeAmountOut({
        poolKeys: pool_keys,
        poolInfo: pool_info,
        amountIn: token_amount_in,
        currencyOut: token_out,
        slippage
    });
    return {
        amount_in: token_amount_in,
        token_in: mint_token_in,
        token_out: mint_token_out,
        min_amount_out: minAmountOut
    };
}

async function get_swap_acc_intsruction(seller: Signer, token_acc: PublicKey, lamports: number = 0): Promise<TransactionInstruction[]> {
    let instructions: TransactionInstruction[] = [];
    instructions.push(
        SystemProgram.createAccountWithSeed({
            seed: SWAP_SEED,
            basePubkey: seller.publicKey,
            fromPubkey: seller.publicKey,
            newAccountPubkey: token_acc,
            lamports: (await global.CONNECTION.getMinimumBalanceForRentExemption(165)) + lamports,
            space: 165,
            programId: TOKEN_PROGRAM_ID
        })
    );
    instructions.push(createInitializeAccountInstruction(token_acc, SOL_MINT, seller.publicKey, TOKEN_PROGRAM_ID));
    return instructions;
}

async function create_raydium_swap_tx(
    amount: TokenAmount,
    seller: Signer,
    token_buy: PublicKey,
    pool_keys: LiquidityPoolKeys,
    pool_info: LiquidityPoolInfo,
    slippage: number,
    priority?: PriorityLevel
) {
    const raw_amount_in = parseInt(amount.amount, 10);
    const { amount_in, token_in, token_out, min_amount_out } = await calc_raydium_amounts(pool_keys, pool_info, token_buy, amount.uiAmount || 0, slippage);

    let token_in_acc: PublicKey;
    let token_out_acc: PublicKey;
    let instructions: TransactionInstruction[] = [];

    if (token_in.equals(SOL_MINT)) {
        token_out_acc = await calc_assoc_token_addr(seller.publicKey, token_out);
        if (!(await check_account_exists(token_out_acc))) {
            instructions.push(createAssociatedTokenAccountInstruction(seller.publicKey, token_out_acc, seller.publicKey, token_out));
        }
        token_in_acc = await PublicKey.createWithSeed(seller.publicKey, SWAP_SEED, TOKEN_PROGRAM_ID);
        instructions = instructions.concat(await get_swap_acc_intsruction(seller, token_in_acc, raw_amount_in));
    } else {
        token_out_acc = await PublicKey.createWithSeed(seller.publicKey, SWAP_SEED, TOKEN_PROGRAM_ID);
        instructions = instructions.concat(await get_swap_acc_intsruction(seller, token_out_acc));
        token_in_acc = await calc_assoc_token_addr(seller.publicKey, token_in);
    }
    instructions.push(
        new TransactionInstruction({
            programId: new PublicKey(pool_keys.programId),
            keys: [
                {
                    pubkey: TOKEN_PROGRAM_ID,
                    isSigner: false,
                    isWritable: false
                },
                { pubkey: pool_keys.id, isSigner: false, isWritable: true },
                {
                    pubkey: pool_keys.authority,
                    isSigner: false,
                    isWritable: false
                },
                {
                    pubkey: pool_keys.openOrders,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.targetOrders,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.baseVault,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.quoteVault,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.marketProgramId,
                    isSigner: false,
                    isWritable: false
                },
                {
                    pubkey: pool_keys.marketId,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.marketBids,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.marketAsks,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.marketEventQueue,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.marketBaseVault,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.marketQuoteVault,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.marketAuthority,
                    isSigner: false,
                    isWritable: false
                },
                { pubkey: token_in_acc, isSigner: false, isWritable: true },
                { pubkey: token_out_acc, isSigner: false, isWritable: true },
                { pubkey: seller.publicKey, isSigner: true, isWritable: false }
            ],
            data: Buffer.from(Uint8Array.of(9, ...new BN(amount_in.raw).toArray('le', 8), ...new BN(min_amount_out.raw).toArray('le', 8)))
        })
    );
    if (token_in.equals(SOL_MINT)) {
        instructions.push(createCloseAccountInstruction(token_in_acc, seller.publicKey, seller.publicKey));
    } else {
        instructions.push(createCloseAccountInstruction(token_out_acc, seller.publicKey, seller.publicKey));
    }

    if (priority) {
        return await create_and_send_tx(instructions, [seller], {
            priority_level: priority,
            accounts: ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8']
        });
    } else {
        return await create_and_send_smart_tx(instructions, [seller]);
    }
}

async function get_raydium_poolkeys(amm: PublicKey): Promise<LiquidityPoolKeys | undefined> {
    const ammAccount = await global.CONNECTION.getAccountInfo(amm);
    if (ammAccount) {
        const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(ammAccount.data);
        const marketAccount = await global.CONNECTION.getAccountInfo(poolState.marketId);
        if (marketAccount) {
            const marketState = MARKET_STATE_LAYOUT_V3.decode(marketAccount.data);
            const marketAuthority = PublicKey.createProgramAddressSync(
                [marketState.ownAddress.toBuffer(), marketState.vaultSignerNonce.toArrayLike(Buffer, 'le', 8)],
                MAINNET_PROGRAM_ID.OPENBOOK_MARKET
            );
            return {
                id: amm,
                programId: MAINNET_PROGRAM_ID.AmmV4,
                status: poolState.status,
                baseDecimals: poolState.baseDecimal.toNumber(),
                quoteDecimals: poolState.quoteDecimal.toNumber(),
                lpDecimals: 9,
                baseMint: poolState.baseMint,
                quoteMint: poolState.quoteMint,
                version: 4,
                authority: RAYDIUM_AUTHORITY,
                openOrders: poolState.openOrders,
                baseVault: poolState.baseVault,
                quoteVault: poolState.quoteVault,
                marketProgramId: MAINNET_PROGRAM_ID.OPENBOOK_MARKET,
                marketId: marketState.ownAddress,
                marketBids: marketState.bids,
                marketAsks: marketState.asks,
                marketEventQueue: marketState.eventQueue,
                marketBaseVault: marketState.baseVault,
                marketQuoteVault: marketState.quoteVault,
                marketAuthority: marketAuthority,
                targetOrders: poolState.targetOrders,
                lpMint: poolState.lpMint
            } as unknown as LiquidityPoolKeys;
        }
    }
    return undefined;
}

export async function swap_raydium(
    amount: TokenAmount,
    seller: Signer,
    amm: PublicKey,
    swap_to: PublicKey,
    slippage: number = 0.05,
    priority?: PriorityLevel
): Promise<String> {
    const pool_keys = await get_raydium_poolkeys(amm);
    if (pool_keys) {
        const pool_info = await Liquidity.fetchInfo({
            connection: global.CONNECTION,
            poolKeys: pool_keys
        });
        const raw_slippage = slippage * 100;
        return create_raydium_swap_tx(amount, seller, swap_to, pool_keys, pool_info, raw_slippage, priority);
    }
    throw new Error(`Failed to get the pool keys.`);
}

export function get_sol_token_amount(amount: number): TokenAmount {
    return {
        uiAmount: amount,
        amount: (amount * LAMPORTS_PER_SOL).toString(),
        decimals: 9
    } as TokenAmount;
}

export function get_token_amount_by_percent(token_amount: TokenAmount, percent: number): TokenAmount {
    if (percent < 0 || percent > 100) throw new Error(`Invalid percent: ${percent}`);
    if (token_amount.uiAmount === null) throw new Error(`Invalid token amount.`);
    if (percent === 100) return token_amount;
    return {
        uiAmount: Math.floor((token_amount.uiAmount * percent) / 100),
        amount: ((BigInt(token_amount.amount) * BigInt(percent)) / BigInt(100)).toString(),
        decimals: token_amount.decimals
    } as TokenAmount;
}
