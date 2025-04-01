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
    Commitment,
    VersionedTransactionResponse,
    Finality
} from '@solana/web3.js';
import {
    AccountLayout,
    TOKEN_PROGRAM_ID,
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
import {
    COMMITMENT,
    JITO_ENDPOINTS,
    JUPITER_API_URL,
    RAYDIUM_AMM_PROGRAM_ID,
    RAYDIUM_AUTHORITY,
    SOL_MINT,
    TRADE_DEFAULT_CURVE_DECIMALS,
    TRADE_MAX_RETRIES,
    TRADE_SWAP_SEED
} from '../constants.js';
import BN from 'bn.js';
import * as common from './common.js';
import bs58 from 'bs58';
import { JITO_TIP_ACCOUNTS } from 'helius-sdk';

export interface IMintMeta {
    readonly token_name: string;
    readonly token_symbol: string;
    readonly token_mint: string;
    readonly token_usd_mc: number;
    readonly bond_complete: boolean;
    readonly amm: PublicKey | null;
}

export interface IProgramTrader {
    get_name(): string;
    buy_token(
        sol_amount: number,
        buyer: Signer,
        mint_meta: IMintMeta,
        slippage: number,
        priority?: PriorityLevel
    ): Promise<String>;
    buy_token_with_retry(
        sol_amount: number,
        buyer: Signer,
        mint_meta: IMintMeta,
        slippage: number,
        retries: number,
        priority?: PriorityLevel
    ): Promise<String | undefined>;
    sell_token(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: Partial<IMintMeta>,
        slippage: number,
        priority?: PriorityLevel
    ): Promise<String>;
    sell_token_with_retry(
        seller: Signer,
        mint_meta: Partial<IMintMeta>,
        slippage: number,
        retries: number,
        priority?: PriorityLevel
    ): Promise<String | undefined>;
    buy_sell_bundle(
        sol_amount: number,
        trader: Signer,
        mint_meta: IMintMeta,
        tip: number,
        slippage: number,
        priority?: PriorityLevel
    ): Promise<String>;
    get_mint_meta(mint: PublicKey): Promise<IMintMeta | undefined>;
    create_token(
        creator: Signer,
        meta: common.IPFSMetadata,
        cid: string,
        mint?: Keypair,
        sol_amount?: number
    ): Promise<[String, PublicKey]>;
    get_random_mints(count: number): Promise<IMintMeta[]>;
    init_mint_meta(mint: PublicKey, sol_price: number): Promise<IMintMeta>;
    update_mint_meta(mint_meta: IMintMeta, sol_price: number): Promise<IMintMeta>;
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

export async function get_tx_with_retries(
    signature: string,
    max_retries: number = TRADE_MAX_RETRIES
): Promise<VersionedTransactionResponse | null> {
    let retries = max_retries;

    while (retries > 0) {
        const transaction = await global.CONNECTION.getTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: COMMITMENT
        });

        if (transaction) return transaction;
        retries--;
    }
    return null;
}

export async function check_account_exists(account: PublicKey): Promise<boolean | undefined> {
    try {
        let account_info = await getAccount(global.CONNECTION, account);
        if (account_info && account_info.isInitialized) return true;
    } catch (error) {
        if (error instanceof TokenAccountNotFoundError || error instanceof TokenInvalidAccountOwnerError) {
            return false;
        } else {
            throw new Error(`Failed to check the account: ${error}`);
        }
    }
}

export async function get_token_supply(mint: PublicKey): Promise<{ supply: bigint; decimals: number }> {
    try {
        const mint_data = await getMint(global.CONNECTION, mint, COMMITMENT);
        return { supply: mint_data.supply, decimals: mint_data.decimals };
    } catch (err) {
        common.error(`[ERROR] Failed to get the token supply: ${err}`);
        return {
            supply: BigInt(1_000_000_000 * 10 ** TRADE_DEFAULT_CURVE_DECIMALS),
            decimals: TRADE_DEFAULT_CURVE_DECIMALS
        };
    }
}

export async function get_balance(pubkey: PublicKey): Promise<number> {
    return await global.CONNECTION.getBalance(pubkey);
}

function get_random_jito_tip_account(): PublicKey {
    const randomValidator = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    return new PublicKey(randomValidator);
}

async function send_bundle(serialized_txs: string[]): Promise<string[]> {
    const requests = JITO_ENDPOINTS.map((endpoint) =>
        fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'sendBundle',
                params: [serialized_txs]
            })
        })
    );
    const responses = await Promise.all(
        requests.map((resp) =>
            resp
                .then((resp) => resp.json())
                .then((data) => data.result as string)
                .catch((err) => err)
        )
    );
    return responses.filter((resp) => !(resp instanceof Error) && resp !== undefined);
}

export async function create_and_send_bundle(
    instructions: TransactionInstruction[][],
    signers: Signer[],
    tip: number
): Promise<String> {
    if (signers.length === 0) throw new Error(`No signers provided.`);
    const payer = signers.at(0)!;

    const jito_tip_account = get_random_jito_tip_account();
    const ctx = await global.CONNECTION.getLatestBlockhashAndContext(COMMITMENT);

    const jito_tip_tx_message = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: ctx.value.blockhash,
        instructions: [
            SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: jito_tip_account,
                lamports: tip * LAMPORTS_PER_SOL
            })
        ]
    }).compileToV0Message();
    const jito_tip_tx = new VersionedTransaction(jito_tip_tx_message);
    jito_tip_tx.sign([payer]);
    const jito_tx_signature = bs58.encode(jito_tip_tx.signatures[0]);

    let serialized_txs = [];

    serialized_txs.push(bs58.encode(jito_tip_tx.serialize()));
    for (let i = 0; i < instructions.length; i++) {
        const versioned_tx = new VersionedTransaction(
            new TransactionMessage({
                payerKey: payer.publicKey,
                recentBlockhash: ctx.value.blockhash,
                instructions: instructions[i].filter(Boolean)
            }).compileToV0Message()
        );
        versioned_tx.sign(signers);
        serialized_txs.push(bs58.encode(versioned_tx.serialize()));
    }

    const responses = await send_bundle(serialized_txs);
    if (responses.length > 0) {
        await check_transaction_status(jito_tx_signature, ctx);
        return responses[0];
    } else {
        throw new Error(`Failed to send the bundle, no successfull response from the JITO endpoints`);
    }
}

async function is_blockhash_expired(last_valid_block_height: number): Promise<boolean> {
    let current_block_height = await global.CONNECTION.getBlockHeight(COMMITMENT);
    return last_valid_block_height - current_block_height < 0;
}

async function check_transaction_status(
    signature: string,
    context: RpcResponseAndContext<Readonly<{ blockhash: string; lastValidBlockHeight: number }>>,
    finality: Finality = 'confirmed'
): Promise<void> {
    const retry_interval = 1000;
    while (true) {
        const { value: status } = await CONNECTION.getSignatureStatus(signature);

        if (status && status.confirmationStatus === finality) {
            const tx = await CONNECTION.getTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: finality
            });
            if (tx) {
                if (tx.meta?.err === null) return;
                if (tx.meta?.err !== null)
                    throw new Error(`Transaction failed with an error | Signature: ${signature}`);
            }
        }

        const is_expired = await is_blockhash_expired(context.value.lastValidBlockHeight);
        if (is_expired) throw new Error('Blockhash has expired.');

        await common.sleep(retry_interval);
    }
}

export async function get_priority_fee(priority: PriorityOptions): Promise<number> {
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
        skipPreflight: true,
        preflightCommitment: COMMITMENT,
        maxRetries: TRADE_MAX_RETRIES
    });
}

export async function create_and_send_tx(
    instructions: TransactionInstruction[],
    signers: Signer[],
    priority?: PriorityOptions
): Promise<String> {
    if (signers.length === 0) throw new Error(`No signers provided.`);

    if (priority) {
        const fee = await get_priority_fee(priority);
        instructions.unshift(
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: fee
            })
        );
    }
    const ctx = await global.CONNECTION.getLatestBlockhashAndContext(COMMITMENT);

    const versioned_tx = new VersionedTransaction(
        new TransactionMessage({
            payerKey: signers[0].publicKey,
            recentBlockhash: ctx.value.blockhash,
            instructions: instructions.filter(Boolean)
        }).compileToV0Message()
    );

    versioned_tx.sign(signers);

    const signature = await global.CONNECTION.sendTransaction(versioned_tx, {
        skipPreflight: true,
        preflightCommitment: COMMITMENT,
        maxRetries: TRADE_MAX_RETRIES
    });

    await check_transaction_status(signature, ctx);
    return signature;
}

export async function get_balance_change(signature: string, address: PublicKey): Promise<number> {
    try {
        const tx_details = await global.CONNECTION.getTransaction(signature, {
            commitment: COMMITMENT,
            maxSupportedTransactionVersion: 0
        });
        if (!tx_details) throw new Error(`Transaction not found: ${signature}`);
        const balance_index = tx_details?.transaction.message
            .getAccountKeys()
            .staticAccountKeys.findIndex((i) => i.equals(address));
        if (balance_index !== undefined && balance_index !== -1) {
            const pre_balance = tx_details?.meta?.preBalances[balance_index] || 0;
            const post_balance = tx_details?.meta?.postBalances[balance_index] || 0;
            return (pre_balance - post_balance) / LAMPORTS_PER_SOL;
        }
        return 0;
    } catch (err) {
        throw new Error(`Failed to get the balance change: ${err}`);
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
                    common.error(
                        `Address: ${holder.publicKey.toString().padEnd(44, ' ')} has no balance. (wallet ${wallet.id})`
                    );
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

export async function send_lamports(
    lamports: number,
    sender: Signer,
    receiver: PublicKey,
    priority?: PriorityLevel
): Promise<String> {
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

export async function get_random_mints(trader: IProgramTrader, count: number): Promise<IMintMeta[]> {
    let mints: IMintMeta[] = [];
    while (true) {
        mints = await trader.get_random_mints(count);
        if (mints.length === count) break;
        await common.sleep(2000);
    }
    return mints;
}

export async function get_token_meta(mint: PublicKey): Promise<MintMeta> {
    try {
        const result = await global.HELIUS_CONNECTION.rpc.getAsset(mint.toString());

        if (result.token_info && result.content) {
            return {
                token_name: result.content.metadata.name,
                token_symbol: result.content.metadata.symbol,
                token_decimals: result.token_info.decimals || TRADE_DEFAULT_CURVE_DECIMALS,
                mint: mint
            };
        }
        throw new Error(`Failed to get the token metadata`);
    } catch (err) {
        throw new Error(`Failed to get the token metadata: ${err}`);
    }
}

export async function get_token_balance(
    pubkey: PublicKey,
    mint: PublicKey,
    commitment: Commitment = 'finalized'
): Promise<TokenAmount> {
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

export async function send_tokens(
    token_amount: number,
    sender: PublicKey,
    receiver: PublicKey,
    owner: Signer
): Promise<String> {
    let instructions: TransactionInstruction[] = [];
    instructions.push(createTransferInstruction(sender, receiver, owner.publicKey, token_amount));

    return await create_and_send_smart_tx(instructions, [owner]);
}

export async function send_tokens_with_account_create(
    token_amount: number,
    mint: PublicKey,
    sender: PublicKey,
    receiver: PublicKey,
    payer: Signer
): Promise<String> {
    let instructions: TransactionInstruction[] = [];

    const ata = await calc_assoc_token_addr(receiver, mint);
    if (!(await check_account_exists(ata))) {
        instructions.push(createAssociatedTokenAccountInstruction(payer.publicKey, ata, receiver, mint));
    }

    instructions.push(createTransferInstruction(sender, ata, payer.publicKey, token_amount));
    return await create_and_send_smart_tx(instructions, [payer]);
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

async function swap_jupiter(
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
                const signature = await create_and_send_tx(intructions, [owner.payer], {
                    accounts: [TOKEN_PROGRAM_ID.toString()],
                    priority_level: PriorityLevel.MEDIUM
                });
                common.log(`${chunk.length} accounts closed | Signature ${signature}`);
                break;
            } catch (err) {
                if (err instanceof Error) {
                    common.error(`Failed to close accounts: ${err.message}, retrying...`);
                }
                common.error(`Failed to close accounts, retrying...`);
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
    let token_out_decimals = pool_keys.baseMint.equals(mint_token_out)
        ? pool_info.baseDecimals
        : pool_keys.quoteDecimals;
    let mint_token_in = pool_keys.baseMint.equals(mint_token_out) ? pool_keys.quoteMint : pool_keys.baseMint;
    let token_in_decimals = pool_keys.baseMint.equals(mint_token_out)
        ? pool_info.quoteDecimals
        : pool_info.baseDecimals;

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

async function get_swap_acc_intsruction(
    seller: Signer,
    token_acc: PublicKey,
    lamports: number = 0
): Promise<TransactionInstruction[]> {
    let instructions: TransactionInstruction[] = [];
    instructions.push(
        SystemProgram.createAccountWithSeed({
            seed: TRADE_SWAP_SEED,
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
    const { amount_in, token_in, token_out, min_amount_out } = await calc_raydium_amounts(
        pool_keys,
        pool_info,
        token_buy,
        amount.uiAmount || 0,
        slippage
    );

    let token_in_acc: PublicKey;
    let token_out_acc: PublicKey;
    let instructions: TransactionInstruction[] = [];

    if (token_in.equals(SOL_MINT)) {
        token_out_acc = await calc_assoc_token_addr(seller.publicKey, token_out);
        if (!(await check_account_exists(token_out_acc))) {
            instructions.push(
                createAssociatedTokenAccountInstruction(seller.publicKey, token_out_acc, seller.publicKey, token_out)
            );
        }
        token_in_acc = await PublicKey.createWithSeed(seller.publicKey, TRADE_SWAP_SEED, TOKEN_PROGRAM_ID);
        instructions = instructions.concat(await get_swap_acc_intsruction(seller, token_in_acc, raw_amount_in));
    } else {
        token_out_acc = await PublicKey.createWithSeed(seller.publicKey, TRADE_SWAP_SEED, TOKEN_PROGRAM_ID);
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
            data: Buffer.from(
                Uint8Array.of(
                    9,
                    ...new BN(amount_in.raw).toArray('le', 8),
                    ...new BN(min_amount_out.raw).toArray('le', 8)
                )
            )
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

async function get_vault_balance(vault: PublicKey): Promise<number> {
    const balance = await global.CONNECTION.getTokenAccountBalance(vault);
    return parseFloat(balance.value.amount) / Math.pow(10, balance.value.decimals);
}

export async function get_raydium_token_metrics(
    amm: PublicKey
): Promise<{ price_sol: number; mcap_sol: number; supply: bigint }> {
    try {
        const info = await global.CONNECTION.getAccountInfo(amm);
        if (!info) return { price_sol: 0.0, mcap_sol: 0.0, supply: BigInt(0) };
        const pool_state = LIQUIDITY_STATE_LAYOUT_V4.decode(info.data);

        const base_token_balance = await get_vault_balance(pool_state.baseVault);
        const quote_token_balance = await get_vault_balance(pool_state.quoteVault);

        const price_sol = base_token_balance / quote_token_balance;
        const token = await get_token_supply(pool_state.quoteMint);
        const mcap_sol = (price_sol * Number(token.supply)) / Math.pow(10, token.decimals);
        return { price_sol, mcap_sol, supply: token.supply };
    } catch (err) {
        return { price_sol: 0.0, mcap_sol: 0.0, supply: BigInt(0) };
    }
}

export async function get_raydium_amm_from_mint(mint: PublicKey): Promise<PublicKey | null> {
    try {
        const [marketAccount] = await CONNECTION.getProgramAccounts(RAYDIUM_AMM_PROGRAM_ID, {
            commitment: COMMITMENT,
            filters: [
                { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
                {
                    memcmp: {
                        offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('baseMint'),
                        bytes: SOL_MINT.toBase58()
                    }
                },
                {
                    memcmp: {
                        offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
                        bytes: mint.toBase58()
                    }
                }
            ]
        });
        return marketAccount.pubkey;
    } catch {
        return null;
    }
}

export async function get_raydium_poolkeys(amm: PublicKey): Promise<LiquidityPoolKeys> {
    const ammAccount = await global.CONNECTION.getAccountInfo(amm);
    if (ammAccount) {
        try {
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
        } catch {
            throw new Error('Invalid Raydium AMM address');
        }
    }
    throw new Error('Failed to retrieve account information');
}

async function swap_raydium(
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
    if (percent < 0.0 || percent > 1.0) throw new Error(`Invalid percent: ${percent}`);
    if (token_amount.uiAmount === null) throw new Error(`Invalid token amount.`);
    if (percent === 1.0) return token_amount;
    return {
        uiAmount: Math.floor(token_amount.uiAmount * percent),
        amount: (BigInt(token_amount.amount) * BigInt(percent)).toString(),
        decimals: token_amount.decimals
    } as TokenAmount;
}

export async function swap(
    amount: TokenAmount,
    buyer: Signer,
    swap_to: PublicKey,
    swap_from: PublicKey,
    amm: PublicKey,
    slippage: number = 0.05,
    _priority: PriorityLevel = PriorityLevel.DEFAULT
): Promise<String> {
    try {
        return swap_raydium(amount, buyer, amm, swap_to, slippage);
    } catch (error) {
        try {
            const signature = await swap_jupiter(amount, buyer, swap_from, swap_to, slippage);
            return signature;
        } catch (error) {
            throw new Error(`Both Raydium and Jupiter transactions failed.`);
        }
    }
}
