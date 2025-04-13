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
    ConfirmedSignatureInfo
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
    getAssociatedTokenAddress,
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
    JITO_BUNDLE_SIZE
} from '../constants.js';
import * as common from './common.js';
import bs58 from 'bs58';

export interface IMintMeta {
    readonly token_name: string;
    readonly token_symbol: string;
    readonly token_mint: string;
    readonly token_usd_mc: number;
    readonly migrated: boolean;
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
    buy_sell_bundle(
        sol_amount: number,
        trader: Signer,
        mint_meta: IMintMeta,
        tip: number,
        slippage: number,
        priority?: PriorityLevel
    ): Promise<String>;
    create_token(
        creator: Signer,
        meta: common.IPFSMetadata,
        cid: string,
        mint?: Keypair,
        sol_amount?: number
    ): Promise<[String, PublicKey]>;
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
    tip: number
): Promise<String> {
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
            instructions: instructions.filter(Boolean)
        }).compileToV0Message()
    );
    versioned_tx.sign(signers);
    const jito_tx_signature = bs58.encode(versioned_tx.signatures[0]);
    const serialized_tx = Buffer.from(versioned_tx.serialize()).toString('base64');

    const responses = await send_jito_tx(serialized_tx);
    if (responses.length > 0) {
        await check_transaction_status(jito_tx_signature, ctx);
        return responses[0];
    } else {
        throw new Error(`Failed to send the bundle, no successfull response from the JITO endpoints`);
    }
}

export async function create_and_send_bundle(
    instructions: TransactionInstruction[][],
    signers: Signer[][],
    tip: number
): Promise<String> {
    if (instructions.length > JITO_BUNDLE_SIZE || instructions.length === 0)
        throw new Error(`Bundle size exceeded or size is 0.`);
    if (instructions.length !== signers.length) throw new Error(`Instructions and signers length mismatch.`);
    for (let i = 0; i < instructions.length; i++) {
        if (instructions[i].length === 0) throw new Error(`No instructions provided for tx ${i}.`);
        if (signers[i].length === 0) throw new Error(`No signers provided for tx ${i}.`);
    }

    const jito_tip_account = get_random_jito_tip_account();
    const ctx = await global.CONNECTION.getLatestBlockhashAndContext(COMMITMENT);
    let signature: string;

    let serialized_txs = [];
    for (let i = 0; i < instructions.length; i++) {
        if (i === 0) {
            instructions[i].push(
                SystemProgram.transfer({
                    fromPubkey: signers[i][0].publicKey,
                    toPubkey: jito_tip_account,
                    lamports: tip * LAMPORTS_PER_SOL
                })
            );
        }
        const versioned_tx = new VersionedTransaction(
            new TransactionMessage({
                payerKey: signers[i][0].publicKey,
                recentBlockhash: ctx.value.blockhash,
                instructions: instructions[i].filter(Boolean)
            }).compileToV0Message()
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

export async function get_address_lt_accounts(keys: string[]): Promise<AddressLookupTableAccount[]> {
    const addressLookupTableAccountInfos = await global.CONNECTION.getMultipleAccountsInfo(
        keys.map((key) => new PublicKey(key))
    );

    return addressLookupTableAccountInfos.reduce((acc, accountInfo, index) => {
        const addressLookupTableAddress = keys[index];
        if (accountInfo) {
            const addressLookupTableAccount = new AddressLookupTableAccount({
                key: new PublicKey(addressLookupTableAddress),
                state: AddressLookupTableAccount.deserialize(accountInfo.data)
            });
            acc.push(addressLookupTableAccount);
        }

        return acc;
    }, new Array<AddressLookupTableAccount>());
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

export async function create_and_send_smart_tx(instructions: TransactionInstruction[], signers: Signer[]) {
    if (instructions.length === 0) throw new Error(`No instructions provided.`);
    return await global.HELIUS_CONNECTION.rpc.sendSmartTransaction(instructions, signers, [], {
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
    address_lt_accounts?: AddressLookupTableAccount[]
): Promise<String> {
    if (instructions.length === 0) throw new Error(`No instructions provided.`);
    if (signers.length === 0) throw new Error(`No signers provided.`);

    if (priority) {
        const fee = await get_priority_fee({
            priority_level: priority,
            transaction: { instructions, signers }
        });
        instructions.unshift(
            ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: fee
            })
        );
        instructions.unshift(
            ComputeBudgetProgram.setComputeUnitLimit({
                units: 1_600_000
            })
        );
    }

    if (protection_tip) return await create_and_send_protected_tx(instructions, signers, protection_tip);

    const ctx = await global.CONNECTION.getLatestBlockhashAndContext(COMMITMENT);
    const versioned_tx = new VersionedTransaction(
        new TransactionMessage({
            payerKey: signers[0].publicKey,
            recentBlockhash: ctx.value.blockhash,
            instructions: instructions.filter(Boolean)
        }).compileToV0Message(address_lt_accounts)
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
        common.error(`[ERROR] failed to process keys: ${err} `);
        return false;
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
        let fees = 0;
        let units = 500;
        fees = await get_priority_fee({
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
                common.error(`Transaction failed for ${receiver.toString()}, attempt ${attempt}. Retrying...`);
                const balance = await get_balance(sender.publicKey);
                if (balance === 0) throw new Error(`Sender has no balance.`);
                if (balance < amount) amount = balance;
            } else {
                common.error(`Transaction failed for ${receiver.toString()} after ${max_retries} attempts`);
            }
        }
        await common.sleep(TRADE_RETRY_INTERVAL_MS * attempt);
    }
    throw new Error('Max retries reached, transaction failed');
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
    if (!(await check_ata_exists(ata))) {
        instructions.push(createAssociatedTokenAccountInstruction(payer.publicKey, ata, receiver, mint));
    }

    instructions.push(createTransferInstruction(sender, ata, payer.publicKey, token_amount));
    return await create_and_send_smart_tx(instructions, [payer]);
}

export async function create_assoc_token_account(payer: Signer, owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
    try {
        const assoc_address = await calc_assoc_token_addr(owner, mint);
        if (!(await check_ata_exists(assoc_address))) {
            let instructions: TransactionInstruction[] = [];
            instructions.push(createAssociatedTokenAccountInstruction(payer.publicKey, assoc_address, owner, mint));
            await create_and_send_smart_tx(instructions, [payer]);
        }
        return assoc_address;
    } catch (err) {
        throw new Error(`Max retries reached, failed to get associated token account.Last error: ${err} `);
    }
}

export async function close_accounts(owner: Keypair): Promise<PublicKey[]> {
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
            common.log(`Unsold mint: ${mint.toString()} | Balance: ${balance.toString()} `);
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
                const signature = await create_and_send_tx(intructions, [owner], PriorityLevel.HIGH);
                common.log(`${chunk.length} accounts closed | Signature ${signature} `);
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

export async function get_vault_balance(vault: PublicKey): Promise<{ balance: bigint; decimals: number }> {
    const balance = await global.CONNECTION.getTokenAccountBalance(vault);
    return { balance: BigInt(balance.value.amount), decimals: balance.value.decimals };
}

export function get_sol_token_amount(amount: number): TokenAmount {
    return {
        uiAmount: amount,
        amount: (amount * LAMPORTS_PER_SOL).toString(),
        decimals: 9
    } as TokenAmount;
}

export function get_token_amount_by_percent(token_amount: TokenAmount, percent: number): TokenAmount {
    if (percent < 0.0 || percent > 1.0) throw new Error(`Invalid percent: ${percent} `);
    if (token_amount.uiAmount === null) throw new Error(`Invalid token amount.`);
    if (percent === 1.0) return token_amount;
    return {
        uiAmount: Math.floor(token_amount.uiAmount * percent),
        amount: (BigInt(token_amount.amount) * BigInt(percent)).toString(),
        decimals: token_amount.decimals
    } as TokenAmount;
}

export async function get_all_signatures(public_key: PublicKey): Promise<ConfirmedSignatureInfo[]> {
    const all_signatures: ConfirmedSignatureInfo[] = [];
    let last_signature: string | undefined;

    while (true) {
        const options: any = { limit: 50 };
        if (last_signature) options.before = last_signature;

        const signatures = await common.retry_with_backoff(() =>
            global.CONNECTION.getSignaturesForAddress(public_key, options)
        );

        all_signatures.push(...signatures);
        last_signature = signatures[signatures.length - 1].signature;
        if (signatures.length < 50 || signatures.length === 0) break;

        await common.sleep(TRADE_RETRY_INTERVAL_MS);
    }

    return all_signatures;
}
