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
    Finality,
    AddressLookupTableAccount,
    Transaction,
    AddressLookupTableProgram
} from '@solana/web3.js';
import {
    AccountLayout,
    TOKEN_PROGRAM_ID,
    TokenAccountNotFoundError,
    TokenInvalidAccountOwnerError,
    createAssociatedTokenAccountInstruction,
    createCloseAccountInstruction,
    createTransferInstruction,
    getAccount,
    getAssociatedTokenAddressSync,
    getMint
} from '@solana/spl-token';
import fetch from 'cross-fetch';
import {
    COMMITMENT,
    JITO_ENDPOINTS,
    PriorityLevel,
    TRADE_DEFAULT_CURVE_DECIMALS,
    TRADE_MAX_RETRIES,
    TRADE_RETRY_INTERVAL_MS,
    JITO_TIP_ACCOUNTS,
    JITO_BUNDLE_SIZE,
    TRADE_RETRY_ITERATIONS
} from '../constants.js';
import * as common from './common.js';
import bs58 from 'bs58';

export interface IMintMeta {
    readonly token_name: string;
    readonly token_symbol: string;
    readonly token_mint: string;
    readonly token_usd_mc: number;
    readonly migrated: boolean;
    readonly platform_fee: number;
    readonly mint_pubkey: PublicKey;
}

export interface IProgramTrader {
    get_name(): string;
    buy_token(
        sol_amount: number,
        buyer: Signer,
        mint_meta: IMintMeta,
        slippage: number,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<String>;
    sell_token(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: Partial<IMintMeta>,
        slippage: number,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<String>;
    buy_token_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: IMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]>;
    sell_token_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: IMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]>;
    buy_sell_instructions(
        sol_amount: number,
        trader: Signer,
        mint_meta: IMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]>;
    buy_sell_bundle(
        sol_amount: number,
        trader: Signer,
        mint_meta: IMintMeta,
        tip: number,
        slippage: number,
        priority?: PriorityLevel
    ): Promise<String>;
    buy_sell(
        sol_amount: number,
        trader: Signer,
        mint_meta: IMintMeta,
        slippage: number,
        interval_ms?: number,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<[String, String]>;
    create_token(
        creator: Signer,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        sol_amount?: number,
        mint?: Keypair
    ): Promise<[String, PublicKey]>;
    create_token_metadata(meta: common.IPFSMetadata, image_path: string): Promise<string>;
    get_random_mints(count: number): Promise<IMintMeta[]>;
    get_mint_meta(mint: PublicKey, sol_price?: number): Promise<IMintMeta | undefined>;
    update_mint_meta(mint_meta: IMintMeta, sol_price?: number): Promise<IMintMeta>;
    default_mint_meta(mint: PublicKey, sol_price?: number): Promise<IMintMeta>;
}

type PriorityOptions = {
    accounts?: string[];
    transaction?: {
        instructions: TransactionInstruction[];
        signers: Signer[];
    };
    priority_level?: PriorityLevel;
};

export type MintAsset = {
    token_name: string;
    token_symbol: string;
    token_decimals: number;
    token_supply: number;
    price_per_token: number;
    mint: PublicKey;
};

export type TokenMetrics = {
    price_sol: number;
    mcap_sol: number;
    supply: bigint;
};

export async function get_tx_with_retries(
    signature: string,
    max_retries: number = 5
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

export async function check_ata_exists(account: PublicKey): Promise<boolean | undefined> {
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

export function calc_ata(owner: PublicKey, mint: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(mint, owner, true);
}

export async function get_token_supply(mint: PublicKey): Promise<{ supply: bigint; decimals: number }> {
    try {
        const mint_data = await getMint(global.CONNECTION, mint, COMMITMENT);
        return { supply: mint_data.supply, decimals: mint_data.decimals };
    } catch (err) {
        return {
            supply: BigInt(1_000_000_000 * 10 ** TRADE_DEFAULT_CURVE_DECIMALS),
            decimals: TRADE_DEFAULT_CURVE_DECIMALS
        };
    }
}

export async function get_vault_balance(vault: PublicKey): Promise<{ balance: bigint; decimals: number }> {
    const balance = await global.CONNECTION.getTokenAccountBalance(vault);
    return { balance: BigInt(balance.value.amount), decimals: balance.value.decimals };
}

export async function get_balance(pubkey: PublicKey, commitment: Commitment = 'finalized'): Promise<number> {
    return await global.CONNECTION.getBalance(pubkey, { commitment });
}

export async function get_token_balance(
    owner: PublicKey,
    mint: PublicKey,
    commitment: Commitment = 'finalized'
): Promise<TokenAmount> {
    try {
        const assoc_addres = calc_ata(owner, mint);
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

export async function get_token_meta(mint: PublicKey): Promise<MintAsset> {
    try {
        const result = await global.HELIUS_CONNECTION.rpc.getAsset({ id: mint.toString() });

        if (result.token_info && result.content) {
            return {
                token_name: result.content.metadata.name,
                token_symbol: result.content.metadata.symbol,
                token_decimals: result.token_info.decimals || TRADE_DEFAULT_CURVE_DECIMALS,
                token_supply: result.token_info.supply || 10 ** 16,
                price_per_token: result.token_info.price_info?.price_per_token || 0.0,
                mint: mint
            };
        }
        throw new Error(`Failed to get the token metadata`);
    } catch (err) {
        throw new Error(`Failed to get the token metadata: ${err} `);
    }
}

function get_random_jito_tip_account(): PublicKey {
    const random_tip_account = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    return new PublicKey(random_tip_account);
}

async function send_jito_bundle(serialized_txs: string[]): Promise<string[]> {
    const requests = JITO_ENDPOINTS.map((endpoint) =>
        fetch(`${endpoint}/bundles`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'sendBundle',
                params: [
                    serialized_txs,
                    {
                        encoding: 'base64'
                    }
                ]
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

async function send_jito_tx(serialized_tx: string): Promise<string[]> {
    const requests = JITO_ENDPOINTS.map((endpoint) =>
        fetch(`${endpoint}/transactions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'sendTransaction',
                params: [
                    serialized_tx,
                    {
                        encoding: 'base64'
                    }
                ]
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

async function create_and_send_protected_tx(
    instructions: TransactionInstruction[],
    signers: Signer[],
    tip: number,
    alts?: AddressLookupTableAccount[]
): Promise<String> {
    instructions = instructions.filter(Boolean);
    if (instructions.length === 0) throw new Error(`No instructions provided.`);
    if (signers.length === 0) throw new Error(`No signers provided.`);
    const payer = signers.at(0)!;

    const jito_tip_account = get_random_jito_tip_account();
    const ctx = await global.CONNECTION.getLatestBlockhashAndContext(COMMITMENT);

    instructions.push(
        SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: jito_tip_account,
            lamports: tip * LAMPORTS_PER_SOL
        })
    );

    const versioned_tx = new VersionedTransaction(
        new TransactionMessage({
            payerKey: payer.publicKey,
            recentBlockhash: ctx.value.blockhash,
            instructions: instructions
        }).compileToV0Message(alts)
    );
    versioned_tx.sign(signers);
    const jito_tx_signature = bs58.encode(versioned_tx.signatures[0]);
    const serialized_tx = Buffer.from(versioned_tx.serialize()).toString('base64');

    const responses = await send_jito_tx(serialized_tx);
    if (responses.length > 0) {
        await check_transaction_status(jito_tx_signature, ctx);
        return responses[0];
    } else {
        throw new Error(`Failed to send the protected transaction, no successfull response from the JITO endpoints`);
    }
}

export async function create_and_send_bundle(
    instructions: TransactionInstruction[][],
    signers: Signer[][],
    tip: number,
    alts?: AddressLookupTableAccount[]
): Promise<String> {
    instructions = instructions.filter(Boolean);
    if (instructions.length > JITO_BUNDLE_SIZE || instructions.length === 0)
        throw new Error(`Bundle size exceeded or size is 0.`);
    if (instructions.length !== signers.length) throw new Error(`Instructions and signers length mismatch.`);
    for (let i = 0; i < instructions.length; i++) {
        if (instructions[i].length === 0) throw new Error(`No instructions provided for tx ${i}.`);
        if (signers[i].length === 0) throw new Error(`No signers provided for tx ${i}.`);
        instructions[i] = instructions[i].filter(Boolean);
    }

    const jito_tip_account = get_random_jito_tip_account();
    const ctx = await global.CONNECTION.getLatestBlockhashAndContext(COMMITMENT);
    let signature: string;

    let serialized_txs = [];
    for (let i = 0; i < instructions.length; i++) {
        if (i === instructions.length - 1) {
            instructions[i].push(
                SystemProgram.transfer({
                    fromPubkey: signers[i][signers[i].length - 1].publicKey,
                    toPubkey: jito_tip_account,
                    lamports: tip * LAMPORTS_PER_SOL
                })
            );
        }
        const versioned_tx = new VersionedTransaction(
            new TransactionMessage({
                payerKey: signers[i][signers[i].length - 1].publicKey,
                recentBlockhash: ctx.value.blockhash,
                instructions: instructions[i]
            }).compileToV0Message(alts)
        );
        versioned_tx.sign(signers[i]);
        if (i === instructions.length - 1) signature = bs58.encode(versioned_tx.signatures[0]);
        serialized_txs.push(Buffer.from(versioned_tx.serialize()).toString('base64'));
    }

    const responses = await send_jito_bundle(serialized_txs);
    if (responses.length > 0) {
        await check_transaction_status(signature!, ctx);
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
                    throw new Error(`Transaction failed with an error | Signature: ${signature} `);
            }
        }

        const is_expired = await is_blockhash_expired(context.value.lastValidBlockHeight);
        if (is_expired) throw new Error('Blockhash has expired.');

        await common.sleep(retry_interval);
    }
}

export async function get_priority_fee(priority_opts: PriorityOptions): Promise<number> {
    let encoded_tx: string | undefined;

    if (priority_opts.transaction) {
        const { blockhash, lastValidBlockHeight } = await global.CONNECTION.getLatestBlockhash(COMMITMENT);
        const tx = new Transaction({
            blockhash: blockhash,
            lastValidBlockHeight: lastValidBlockHeight,
            feePayer: priority_opts.transaction.signers[0].publicKey
        }).add(...priority_opts.transaction.instructions);
        encoded_tx = bs58.encode(tx.serialize({ verifySignatures: false, requireAllSignatures: false }));
    }

    const response = await global.HELIUS_CONNECTION.rpc.getPriorityFeeEstimate({
        transaction: encoded_tx,
        accountKeys: priority_opts.accounts,
        options: {
            priorityLevel: priority_opts.priority_level,
            recommended: priority_opts.priority_level === undefined ? true : undefined
        }
    });
    return Math.floor(response.priorityFeeEstimate || 0);
}

export async function create_and_send_smart_tx(
    instructions: TransactionInstruction[],
    signers: Signer[],
    alts?: AddressLookupTableAccount[]
): Promise<String> {
    instructions = instructions.filter(Boolean);
    if (instructions.length === 0) throw new Error(`No instructions provided.`);
    if (signers.length === 0) throw new Error(`No signers provided.`);

    return await global.HELIUS_CONNECTION.rpc.sendSmartTransaction(instructions, signers, alts, {
        skipPreflight: true,
        preflightCommitment: COMMITMENT,
        maxRetries: TRADE_MAX_RETRIES
    });
}

export async function create_and_send_tx(
    instructions: TransactionInstruction[],
    signers: Signer[],
    priority?: PriorityLevel,
    protection_tip?: number,
    alts?: AddressLookupTableAccount[]
): Promise<String> {
    if (instructions.length === 0) throw new Error(`No instructions provided.`);
    if (signers.length === 0) throw new Error(`No signers provided.`);
    const tx_instructions = instructions.filter(Boolean);

    if (priority) {
        const fee = await get_priority_fee({
            priority_level: priority,
            transaction: { instructions: tx_instructions, signers }
        });
        tx_instructions.unshift(
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: fee
            })
        );
        tx_instructions.unshift(
            ComputeBudgetProgram.setComputeUnitLimit({
                units: 1_600_000
            })
        );
    }

    if (protection_tip) return await create_and_send_protected_tx(tx_instructions, signers, protection_tip, alts);

    const ctx = await global.CONNECTION.getLatestBlockhashAndContext(COMMITMENT);
    const versioned_tx = new VersionedTransaction(
        new TransactionMessage({
            payerKey: signers[0].publicKey,
            recentBlockhash: ctx.value.blockhash,
            instructions: tx_instructions
        }).compileToV0Message(alts)
    );
    versioned_tx.sign(signers);

    const signature = await global.CONNECTION.sendTransaction(versioned_tx, {
        skipPreflight: false,
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
        if (!tx_details) throw new Error(`Transaction not found: ${signature} `);
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
        throw new Error(`Failed to get the balance change: ${err} `);
    }
}

export async function send_lamports(
    lamports: number,
    sender: Signer,
    receiver: PublicKey,
    priority?: PriorityLevel
): Promise<String> {
    lamports = Math.floor(lamports);
    const send_instruction = SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: receiver,
        lamports: lamports
    });

    if (priority) {
        const units = 500;
        const fees = await get_priority_fee({
            priority_level: priority,
            transaction: {
                instructions: [send_instruction],
                signers: [sender]
            }
        });
        let instructions = [
            ComputeBudgetProgram.setComputeUnitLimit({
                units: units
            }),
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: fees
            }),
            SystemProgram.transfer({
                fromPubkey: sender.publicKey,
                toPubkey: receiver,
                lamports: lamports - 5000 - Math.ceil((fees * units) / 10 ** 6)
            })
        ];
        return await create_and_send_tx(instructions, [sender]);
    }

    return await create_and_send_smart_tx([send_instruction], [sender]);
}

export async function send_lamports_with_retries(
    amount: number,
    sender: Keypair,
    receiver: PublicKey,
    priority?: PriorityLevel,
    max_retries: number = 5
): Promise<String> {
    for (let attempt = 1; attempt <= max_retries; attempt++) {
        try {
            return await send_lamports(amount, sender, receiver, priority);
        } catch (error) {
            if (attempt < max_retries) {
                common.error(
                    common.red(`Transaction failed for ${receiver.toString()}, attempt ${attempt}. Retrying...`)
                );
                const balance = await get_balance(sender.publicKey, COMMITMENT);
                if (balance === 0) throw new Error(`Sender has no balance.`);
                if (balance < amount) amount = balance;
            } else {
                common.error(common.red(`Transaction failed for ${receiver.toString()} after ${max_retries} attempts`));
            }
        }
        await common.sleep(TRADE_RETRY_INTERVAL_MS * attempt);
    }
    throw new Error('Max retries reached, transaction failed');
}

export async function send_tokens(
    token_amount: TokenAmount,
    mint: PublicKey,
    sender: Signer,
    receiver: PublicKey,
    create_receiver_ata: boolean = false
): Promise<String> {
    if (token_amount.uiAmount === null) throw new Error(`Invalid token amount.`);
    const token_amount_raw = BigInt(token_amount.amount);

    let instructions: TransactionInstruction[] = [];
    const receiver_ata = calc_ata(receiver, mint);
    const sender_ata = calc_ata(sender.publicKey, mint);

    if (!(await check_ata_exists(receiver_ata)) && create_receiver_ata) {
        instructions.push(createAssociatedTokenAccountInstruction(sender.publicKey, receiver_ata, receiver, mint));
    }
    instructions.push(createTransferInstruction(sender_ata, receiver_ata, sender.publicKey, token_amount_raw));

    return await create_and_send_smart_tx(instructions, [sender]);
}

export async function close_accounts(owner: Keypair): Promise<{ ok: boolean; unsold: PublicKey[] }> {
    const token_accounts = (
        await global.CONNECTION.getTokenAccountsByOwner(owner.publicKey, {
            programId: TOKEN_PROGRAM_ID
        })
    ).value.map((acc) => {
        return {
            pubkey: acc.pubkey,
            data: AccountLayout.decode(acc.account.data)
        };
    });
    const unsold_mints = await Promise.all(
        token_accounts
            .filter((acc) => acc.data.amount !== BigInt(0))
            .map(async (acc) => {
                const mint = acc.data.mint;
                const balance = Number(acc.data.amount) / 10 ** (await get_token_supply(mint)).decimals;
                common.log(`Unsold mint: ${mint.toString()} | Balance: ${balance.toString()} `);
                return acc.data.mint;
            })
    );
    const accounts_to_close = token_accounts.filter((acc) => acc.data.amount === BigInt(0));

    if ((await get_balance(owner.publicKey, COMMITMENT)) === 0) {
        common.error(common.red(`Owner has no balance to close the accounts, skipping...`));
        return { ok: false, unsold: unsold_mints };
    }
    for (const chunk of common.chunks(accounts_to_close, 15)) {
        while (true) {
            const intructions = chunk.map((account) => {
                return createCloseAccountInstruction(account.pubkey, owner.publicKey, owner.publicKey);
            });
            try {
                const signature = await create_and_send_tx(intructions, [owner], PriorityLevel.HIGH);
                common.log(`${chunk.length} accounts closed | Signature ${signature} `);
                break;
            } catch (err) {
                common.error(common.red(`Failed to close accounts, retrying...`));
            }
        }
    }
    return { ok: true, unsold: unsold_mints };
}

export function get_sol_token_amount(amount: number): TokenAmount {
    return {
        uiAmount: amount,
        amount: (amount * LAMPORTS_PER_SOL).toString(),
        decimals: Math.log10(LAMPORTS_PER_SOL)
    } as TokenAmount;
}

export function get_token_amount(amount: number, decimals: number): TokenAmount {
    if (decimals < 0 || decimals > 18) throw new Error(`Invalid decimals: ${decimals} `);
    return {
        uiAmount: amount,
        amount: (amount * 10 ** decimals).toString(),
        decimals: decimals
    } as TokenAmount;
}

export function get_token_amount_by_percent(token_amount: TokenAmount, percent: number): TokenAmount {
    if (percent < 0.0 || percent > 1.0) throw new Error(`Invalid percent: ${percent} `);
    if (token_amount.uiAmount === null) throw new Error(`Invalid token amount.`);
    if (percent === 1.0) return token_amount;
    return {
        uiAmount: Math.floor(token_amount.uiAmount * percent),
        amount: ((BigInt(token_amount.amount) * BigInt(Math.floor(percent * 10000))) / BigInt(10000)).toString(),
        decimals: token_amount.decimals
    } as TokenAmount;
}

export async function create_lta(payer: Signer): Promise<[PublicKey, String]> {
    const commitment: Commitment = 'finalized';
    let retries = TRADE_RETRY_ITERATIONS;

    while (retries > 0) {
        try {
            const recent_slot = await global.CONNECTION.getSlot(commitment);
            const [instruction, lt_address] = AddressLookupTableProgram.createLookupTable({
                authority: payer.publicKey,
                payer: payer.publicKey,
                recentSlot: recent_slot
            });
            const signature = await create_and_send_tx([instruction], [payer], PriorityLevel.HIGH);
            return [lt_address, signature];
        } catch (err) {
            retries--;
        }
    }
    throw new Error(`Failed after multiple attempts`);
}

const lta_cache = new Map<string, AddressLookupTableAccount>();
export async function get_ltas(addresses: PublicKey[]): Promise<AddressLookupTableAccount[]> {
    const results: AddressLookupTableAccount[] = [];
    const uncached: PublicKey[] = [];

    for (const addr of addresses) {
        const addr_str = addr.toString();
        if (lta_cache.has(addr_str)) {
            results.push(lta_cache.get(addr_str)!);
        } else {
            uncached.push(addr);
        }
    }

    if (uncached.length > 0) {
        const new_ltas = await Promise.all(
            uncached.map(async (addr) => {
                try {
                    const account = await global.CONNECTION.getAddressLookupTable(addr, { commitment: COMMITMENT });
                    if (account && account.value) {
                        lta_cache.set(addr.toString(), account.value);
                        return account.value;
                    }
                    throw new Error(`not found`);
                } catch (error) {
                    throw new Error(`Failed to get Address Lookup Table account for ${addr}: ${error}`);
                }
            })
        );
        results.push(...new_ltas);
    }

    return results.filter((acc) => acc !== null);
}

export async function extend_lta(lta: PublicKey, payer: Signer, addresses: PublicKey[]): Promise<String[]> {
    const max_addresses = 256;
    const lt_account = (await global.CONNECTION.getAddressLookupTable(lta, { commitment: COMMITMENT })).value;
    if (!lt_account) throw new Error('Address Lookup Table not found');

    const to_insert = addresses.filter(
        (new_addr) => !lt_account.state.addresses.some((old_addr) => old_addr.equals(new_addr))
    );
    if (to_insert.length === 0) throw new Error('No new addresses to insert');
    if (lt_account.state.addresses.length + to_insert.length > max_addresses)
        throw new Error(`Address Lookup Table is full, cannot insert more addresses`);

    const txs: Promise<String>[] = [];
    for (const chunk of common.chunks(to_insert, 20)) {
        const instruction = AddressLookupTableProgram.extendLookupTable({
            authority: payer.publicKey,
            lookupTable: lta,
            payer: payer.publicKey,
            addresses: chunk
        });
        txs.push(create_and_send_tx([instruction], [payer], PriorityLevel.HIGH));
    }
    return await Promise.all(txs);
}

export async function close_ltas(payer: Signer, ltas: readonly AddressLookupTableAccount[]): Promise<String[]> {
    const deactivated_ltas = ltas.filter((item) => !item.isActive());

    const instructions = deactivated_ltas.map((lta) =>
        AddressLookupTableProgram.closeLookupTable({
            authority: payer.publicKey,
            recipient: payer.publicKey,
            lookupTable: lta.key
        })
    );
    const txs: Promise<String>[] = common
        .chunks(instructions, 10)
        .map((chunk) => create_and_send_smart_tx(chunk, [payer]));
    return Promise.all(txs);
}

export async function get_ltas_by_authority(
    authority: PublicKey,
    is_active?: boolean
): Promise<AddressLookupTableAccount[]> {
    try {
        const result = await global.CONNECTION.getProgramAccounts(AddressLookupTableProgram.programId, {
            filters: [
                {
                    memcmp: {
                        offset: 22,
                        bytes: authority.toBase58()
                    }
                }
            ]
        });
        if (!result) throw new Error(`No Address Lookup Table accounts found for authority ${authority}`);
        const ltas = result.map(
            (account) =>
                new AddressLookupTableAccount({
                    key: account.pubkey,
                    state: AddressLookupTableAccount.deserialize(account.account.data)
                })
        );
        if (is_active !== undefined) return ltas.filter((lta) => lta.isActive() === is_active);
        return ltas;
    } catch (error) {
        throw new Error(`Failed to get Address Lookup Table accounts by authority: ${error}`);
    }
}

export async function deactivate_ltas(
    authority: Signer,
    ltas: readonly AddressLookupTableAccount[]
): Promise<String[]> {
    const active_ltas = ltas.filter((item) => item.isActive());
    if (ltas.length === 0) throw new Error(`No active Address Lookup Table accounts`);

    const instructions = active_ltas.map((lta) =>
        AddressLookupTableProgram.deactivateLookupTable({
            authority: authority.publicKey,
            lookupTable: lta.key
        })
    );
    const txs: Promise<String>[] = common
        .chunks(instructions, 10)
        .map((chunk) => create_and_send_smart_tx(chunk, [authority]));
    return Promise.all(txs);
}
