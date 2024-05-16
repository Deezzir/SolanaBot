import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, Signer, SystemProgram, Transaction, TokenAmount, TransactionInstruction, VersionedTransaction, TransactionMessage, RpcResponseAndContext } from '@solana/web3.js';
import { createAssociatedTokenAccountInstruction, createTransferInstruction, getMint, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { Metaplex } from "@metaplex-foundation/js";
import fetch from 'cross-fetch';
import { Wallet } from '@project-serum/anchor';
import * as common from './common.js';
import * as jito from 'jito-ts';
import path from 'path';
import bs58 from 'bs58';
// import { Liquidity, LiquidityPoolKeys, Percent, SPL_ACCOUNT_LAYOUT, Token, jsonInfo2PoolKeys } from '@raydium-io/raydium-sdk';
// import { TokenAmount as RaydiumTokenAmount } from '@raydium-io/raydium-sdk';

export const KEYS_DIR = process.env.KEYS_DIR || './keys';
export const RESERVE_KEY_PATH = path.join(KEYS_DIR, process.env.RESERVE_KEY_PATH || 'key0.json');

const RESERVE = common.get_key(RESERVE_KEY_PATH);
if (!RESERVE) throw new Error(`[ERROR] Failed to read the reserve key file: ${RESERVE_KEY_PATH}`);
const RESERVE_KEYPAIR = Keypair.fromSecretKey(RESERVE);


const TRADE_PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ACCOUNT_0 = new PublicKey(process.env.ACCOUNT_0 || '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const ACCOUNT_1 = new PublicKey(process.env.ACCOUNT_1 || 'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
const ACCOUNT_2 = new PublicKey(process.env.ACCOUNT_2 || 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
const ACCOUNT_3 = new PublicKey(process.env.ACCOUNT_3 || 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM');
const BONDING_ADDR = new Uint8Array([98, 111, 110, 100, 105, 110, 103, 45, 99, 117, 114, 118, 101]);
const META_ADDR = new Uint8Array([109, 101, 116, 97, 100, 97, 116, 97]);

export const SOLANA_TOKEN = new PublicKey(process.env.SOLANA_TOKEN || 'So11111111111111111111111111111111111111112');

const JITOTIP = new PublicKey(process.env.JITOTIP || 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe');

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(process.env.ASSOCIATED_TOKEN_PROGRAM_ID || 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM_ID = new PublicKey(process.env.SYSTEM_PROGRAM_ID || '11111111111111111111111111111111');
const TOKEN_PROGRAM_ID = new PublicKey(process.env.TOKEN_PROGRAM_ID || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const RENT_PROGRAM_ID = new PublicKey(process.env.RENT_PROGRAM_ID || 'SysvarRent111111111111111111111111111111111');
const METAPLEX_TOKEN_META = new PublicKey(process.env.METAPLEX_TOKEN_META || 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

const FETCH_MINT_API_URL = process.env.FETCH_MINT_API_URL || '';

const BLOCK_URL = process.env.BLOCK_URL || '';
const JUPITER_API_URL = process.env.JUPITER_API_URL || 'https://quote-api.jup.ag/v6/';
const LIQUIDITY_FILE = process.env.LIQUIDITY_FILE || 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';

const PRIORITY_UNITS = 100000;
const PRIORITY_MICRO_LAMPORTS = 500000;
const MAX_RETRIES = 2;

export async function fetch_mint(mint: string): Promise<common.TokenMeta> {
    return fetch(`${FETCH_MINT_API_URL}/${mint}`)
        .then(response => response.json())
        .then(data => {
            if (!data || data.statusCode !== undefined) return {} as common.TokenMeta;
            return data as common.TokenMeta;
        })
        .catch(err => {
            common.log_error(`[ERROR] Failed fetching the mint: ${err}`);
            return {} as common.TokenMeta;
        });
}

export async function fetch_random_mints(count: number): Promise<common.TokenMeta[]> {
    const limit = 50;
    const offset = Array.from({ length: 20 }, (_, i) => i * limit).sort(() => 0.5 - Math.random())[0];
    return fetch(`${FETCH_MINT_API_URL}?offset=${offset}&limit=${limit}&sort=last_trade_timestamp&order=DESC`)
        .then(response => response.json())
        .then(data => {
            if (!data || data.statusCode !== undefined) return [] as common.TokenMeta[];
            const shuffled = data.sort(() => 0.5 - Math.random());
            return shuffled.slice(0, count) as common.TokenMeta[];
        })
        .catch(err => {
            common.log_error(`[ERROR] Failed fetching the mints: ${err}`);
            return [] as common.TokenMeta[];
        });
}

export async function fetch_by_name(name: string): Promise<common.TokenMeta[]> {
    const name_prepared = name.replace(/ /g, '%20');
    return fetch(`${FETCH_MINT_API_URL}?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false&searchTerm=${name_prepared}`)
        .then(response => response.json())
        .then(data => {
            if (!data || data.statusCode !== undefined) return [] as common.TokenMeta[];
            return data as common.TokenMeta[];
        })
        .catch(err => {
            common.log_error(`[ERROR] Failed fetching the mints: ${err}`);
            return [] as common.TokenMeta[];
        });
}

export async function get_token_supply(mint: PublicKey): Promise<bigint> {
    try {
        const mint_1 = await getMint(global.connection, mint, 'confirmed');
        return mint_1.supply;
    } catch (err) {
        common.log_error(`[ERROR] Failed to get the token supply: ${err}`);
        return BigInt(1000000000000000);
    }
}

export async function get_balance(pubkey: PublicKey): Promise<number> {
    return await global.connection.getBalance(pubkey);
}

const isError = <T>(value: T | Error): value is Error => {
    return value instanceof Error;
};

export async function create_and_send_tipped_tx(instructions: TransactionInstruction[], payer: Signer, signers: Signer[], tip: number, priority: boolean = false): Promise<String> {
    try {
        const c = jito.searcher.searcherClient(BLOCK_URL, RESERVE_KEYPAIR);
        const { blockhash, lastValidBlockHeight } = await global.connection.getLatestBlockhash();

        if (priority) instructions_add_priority(instructions);

        instructions.unshift(SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: JITOTIP,
            lamports: tip * LAMPORTS_PER_SOL,
        }));

        const versioned_tx = new VersionedTransaction(new TransactionMessage({
            payerKey: payer.publicKey,
            recentBlockhash: blockhash,
            instructions: instructions.filter(Boolean),
        }).compileToV0Message());
        versioned_tx.sign(signers);

        let signature = bs58.encode(Buffer.from(versioned_tx.signatures[0]));
        let bundle = new jito.bundle.Bundle([versioned_tx], 1);

        if (!isError(bundle)) {
            try {
                const resp = await c.sendBundle(bundle);
                await global.connection.confirmTransaction({
                    blockhash,
                    lastValidBlockHeight,
                    signature
                }, 'confirmed');
                return signature;
            } catch (e) {
                throw new Error(`Failed to send a bundle: ${e}`);
            }
        } else {
            throw new Error(`Failed to create a bundle: ${bundle}`);
        }
    } catch (err) {
        throw new Error(`Failed to send tipped transaction: ${err}`);

    }
}

async function isBlockhashExpired(lastValidBlockHeight: number) {
    let currentBlockHeight = (await global.connection.getBlockHeight('finalized'));
    return (currentBlockHeight > lastValidBlockHeight - 150);
}

async function create_and_send_tx(
    instructions: TransactionInstruction[], payer: Signer, signers: Signer[],
    context: RpcResponseAndContext<Readonly<{ blockhash: string; lastValidBlockHeight: number; }>>,
    max_retries: number = 5, priority: boolean = false
): Promise<String> {
    // const { blockhash, lastValidBlockHeight } = await global.connection.getLatestBlockhash();

    if (priority) instructions_add_priority(instructions);
    const versioned_tx = new VersionedTransaction(new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: context.value.blockhash,
        instructions: instructions.filter(Boolean),
    }).compileToV0Message());

    versioned_tx.sign(signers);

    const signature = await global.connection.sendTransaction(versioned_tx);
    // ,{
    //     skipPreflight: false,
    //     maxRetries: max_retries,
    // });

    let hashExpired = false;
    let txSuccess = false;
    while (!hashExpired && !txSuccess) {
        const { value: status } = await global.connection.getSignatureStatus(signature);

        if (status && ((status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) && status.err === null) {
            txSuccess = true;
            break;
        }

        if (status && status.err) {
            throw new Error(`Transaction failed: ${status.err}`);
        }

        hashExpired = await isBlockhashExpired(context.value.lastValidBlockHeight);

        if (hashExpired) {
            throw new Error('Blockhash has expired.');
        }

        await common.sleep(2000);
    }

    return signature;

    // try {
    //     const signature = await global.connection.sendTransaction(versioned_tx, {
    //         skipPreflight: false,
    //         maxRetries: max_retries,
    //     })
    //     await global.connection.confirmTransaction({
    //         blockhash,
    //         lastValidBlockHeight,
    //         signature
    //     }, 'confirmed');
    //     return signature;
    // } catch (err) {
    //     throw new Error(`Max retries reached, failed to send the transaction: ${err}`);
    // }
}

async function create_and_send_vtx(
    tx: VersionedTransaction, signers: Signer[],
    context: RpcResponseAndContext<Readonly<{ blockhash: string; lastValidBlockHeight: number; }>>,
    max_retries: number = 5, priority: boolean = false
): Promise<String> {
    // const { blockhash, lastValidBlockHeight } = await global.connection.getLatestBlockhash();

    tx.sign(signers);

    const rawTransaction = tx.serialize();
    const signature = await global.connection.sendRawTransaction(rawTransaction);
    // ,{
    //     skipPreflight: false,
    //     maxRetries: max_retries,
    // });

    let hashExpired = false;
    let txSuccess = false;
    while (!hashExpired && !txSuccess) {
        const { value: status } = await global.connection.getSignatureStatus(signature);

        if (status && ((status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized'))) {
            txSuccess = true;
            break;
        }

        hashExpired = await isBlockhashExpired(context.value.lastValidBlockHeight);

        if (hashExpired) {
            throw new Error('Blockhash has expired.');
        }

        await common.sleep(2000);
    }

    // await global.connection.confirmTransaction({
    //     blockhash,
    //     lastValidBlockHeight,
    //     signature
    // }, 'confirmed');

    return signature;
}

export async function get_balance_change(signature: string, address: PublicKey): Promise<number> {
    try {
        const tx_details = await global.connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (!tx_details)
            throw new Error(`[ERROR] Transaction not found: ${signature}`);
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

export async function check_has_balances(keys: Uint8Array[], min_balance: number = 0): Promise<boolean> {
    let ok = true;

    try {
        for (const key of keys) {
            const keypair = Keypair.fromSecretKey(key);
            const balance = await get_balance(keypair.publicKey) / LAMPORTS_PER_SOL;
            if (balance <= min_balance) {
                common.log_error(`Address: ${keypair.publicKey.toString().padEnd(44, ' ')} has no balance.`);
                ok = false;
            }
        }
        if (!ok) common.log_error('[ERROR] Some accounts are empty.');
        return ok;
    } catch (err) {
        common.log_error(`[ERROR] failed to process keys: ${err}`);
        return false;
    }
}

function instructions_add_priority(instructions: TransactionInstruction[]): void {
    const modify_cu = ComputeBudgetProgram.setComputeUnitLimit({
        units: PRIORITY_UNITS,
    });
    const priority_fee = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: PRIORITY_MICRO_LAMPORTS,
    });
    instructions.unshift(priority_fee);
    // instructions.unshift(modify_cu, priority_fee);
}

export async function send_lamports(
    lamports: number, sender: Signer, receiver: PublicKey,
    context: RpcResponseAndContext<Readonly<{ blockhash: string; lastValidBlockHeight: number; }>>,
    max: boolean = false, priority: boolean = false
): Promise<String> {
    const max_retries = MAX_RETRIES;

    let instructions: TransactionInstruction[] = [];
    instructions.push(SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: receiver,
        lamports: lamports - (max ? 5000 : 0),
    }));

    return await create_and_send_tx(instructions, sender, [sender], context, max_retries, priority);
}

export async function get_tx_fee(tx: Transaction): Promise<number> {
    try {
        const repsonse = await global.connection.getFeeForMessage(
            tx.compileMessage(),
            'confirmed'
        );
        if (!repsonse || !repsonse.value) return 0;
        return repsonse.value;
    } catch (err) {
        common.log_error(`[ERROR] Failed to get the transaction fee: ${err}`);
        return 0;
    }
}

export async function calc_assoc_token_addr(owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
    const address = PublicKey.findProgramAddressSync(
        [
            owner.toBuffer(),
            TOKEN_PROGRAM_ID.toBuffer(),
            mint.toBuffer(),
        ],
        ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
    return address;
}

export async function get_token_meta(mint: PublicKey): Promise<common.MintMeta> {
    const metaplex = Metaplex.make(global.connection);

    const metaplex_acc = metaplex
        .nfts()
        .pdas()
        .metadata({ mint });

    const metaplex_acc_info = await global.connection.getAccountInfo(metaplex_acc);

    if (metaplex_acc_info) {
        const token = await metaplex.nfts().findByMint({ mintAddress: mint });
        return {
            token_name: token.name,
            token_symbol: token.symbol,
            token_decimals: token.mint.decimals,
            mint: mint,
        }
    }

    throw new Error(`Failed to get the token metadata.`);
}

async function check_assoc_token_addr(assoc_address: PublicKey): Promise<boolean> {
    const accountInfo = await global.connection.getAccountInfo(assoc_address);
    return accountInfo !== null;
}

function get_token_amount_raw(amount: number, token: common.TokenMeta): number {
    const sup = Number(token.total_supply);
    return Math.round(amount * sup / token.market_cap);
}

function get_solana_amount_raw(amount: number, token: common.TokenMeta): number {
    const sup = Number(token.total_supply);
    return amount * token.market_cap / (sup * 1_000_000);
}

function calc_slippage_up(sol_amount: number, slippage: number): number {
    const lamports = sol_amount * LAMPORTS_PER_SOL;
    return Math.round(lamports * (1 + slippage) + lamports * (1 + slippage) / 1000);
}

function calc_slippage_down(sol_amount: number, slippage: number): number {
    const lamports = sol_amount * LAMPORTS_PER_SOL;
    return Math.round(lamports * (1 - slippage));
}

function buy_data(sol_amount: number, token_amount: number, slippage: number): Buffer {
    const instruction_buf = Buffer.from('66063d1201daebea', 'hex');
    const token_amount_buf = Buffer.alloc(8);
    token_amount_buf.writeBigUInt64LE(BigInt(token_amount), 0);
    const slippage_buf = Buffer.alloc(8);
    slippage_buf.writeBigUInt64LE(BigInt(calc_slippage_up(sol_amount, slippage)), 0);
    return Buffer.concat([instruction_buf, token_amount_buf, slippage_buf]);
}

function sell_data(sol_amount: number, token_amount: number, slippage: number): Buffer {
    const instruction_buf = Buffer.from('33e685a4017f83ad', 'hex');
    const token_amount_buf = Buffer.alloc(8);
    token_amount_buf.writeBigUInt64LE(BigInt(token_amount), 0);
    const slippage_buf = Buffer.alloc(8);
    slippage_buf.writeBigUInt64LE(BigInt(calc_slippage_down(sol_amount, slippage)), 0);
    return Buffer.concat([instruction_buf, token_amount_buf, slippage_buf]);
}

export async function get_token_balance(pubkey: PublicKey, mint: PublicKey): Promise<TokenAmount> {
    try {
        const assoc_addres = await calc_assoc_token_addr(pubkey, mint);
        const account_info = await global.connection.getTokenAccountBalance(assoc_addres);
        return account_info.value;
    } catch (err) {
        return {
            uiAmount: null,
            amount: '0',
            decimals: 0,
        };
    }
}

export async function send_tokens(
    token_amount: number, sender: PublicKey, receiver: PublicKey, owner: Signer,
    context: RpcResponseAndContext<Readonly<{ blockhash: string; lastValidBlockHeight: number; }>>,
    priority: boolean = false
): Promise<String> {
    const max_retries = MAX_RETRIES;

    let instructions: TransactionInstruction[] = []
    instructions.push(createTransferInstruction(
        sender,
        receiver,
        owner.publicKey,
        token_amount
    ));

    return await create_and_send_tx(instructions, owner, [owner], context, max_retries, priority);
}

export async function create_assoc_token_account(payer: Signer, owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
    const max_retries = MAX_RETRIES;
    try {
        let account = await getOrCreateAssociatedTokenAccount(global.connection, payer, mint, owner, false, 'confirmed', { maxRetries: max_retries, skipPreflight: true });
        return account.address;
    } catch (err) {
        throw new Error(`Max retries reached, failed to get associated token account. Last error: ${err}`);
    }
}

export async function buy_token(
    sol_amount: number, buyer: Signer, mint_meta: common.TokenMeta,
    context: RpcResponseAndContext<Readonly<{ blockhash: string; lastValidBlockHeight: number; }>>,
    tip: number = 0.1, slippage: number = 0.05, priority: boolean = false
): Promise<String> {
    const max_retries = MAX_RETRIES;

    const mint = new PublicKey(mint_meta.mint);
    const bonding_curve = new PublicKey(mint_meta.bonding_curve);
    const assoc_bonding_curve = new PublicKey(mint_meta.associated_bonding_curve);

    const token_amount = get_token_amount_raw(sol_amount, mint_meta);
    const instruction_data = buy_data(sol_amount, token_amount, slippage);
    const assoc_address = await calc_assoc_token_addr(buyer.publicKey, mint);
    const is_assoc = await check_assoc_token_addr(assoc_address);

    let instructions: TransactionInstruction[] = [];
    if (!is_assoc) {
        instructions.push(createAssociatedTokenAccountInstruction(
            buyer.publicKey,
            assoc_address,
            buyer.publicKey,
            mint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
        ));
    }
    instructions.push(new TransactionInstruction({
        keys: [
            { pubkey: ACCOUNT_0, isSigner: false, isWritable: false },
            { pubkey: ACCOUNT_1, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bonding_curve, isSigner: false, isWritable: true },
            { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
            { pubkey: assoc_address, isSigner: false, isWritable: true },
            { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: RENT_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ACCOUNT_2, isSigner: false, isWritable: false },
            { pubkey: TRADE_PROGRAM_ID, isSigner: false, isWritable: false }
        ],
        programId: TRADE_PROGRAM_ID,
        data: instruction_data,
    }));
    return await create_and_send_tx(instructions, buyer, [buyer], context, max_retries, priority);
    return await create_and_send_tipped_tx(instructions, buyer, [buyer], tip, priority);
}

export async function sell_token(
    token_amount: TokenAmount, seller: Signer, mint_meta: common.TokenMeta,
    context: RpcResponseAndContext<Readonly<{ blockhash: string; lastValidBlockHeight: number; }>>,
    tip: number = 0.1, slippage: number = 0.05, priority: boolean = false
): Promise<String> {
    const max_retries = MAX_RETRIES;

    const mint = new PublicKey(mint_meta.mint);
    const bonding_curve = new PublicKey(mint_meta.bonding_curve);
    const assoc_bonding_curve = new PublicKey(mint_meta.associated_bonding_curve);

    if (token_amount.uiAmount === null)
        throw new Error(`[ERROR]: Failed to get the token amount.`);
    const token_amount_raw = parseInt(token_amount.amount);
    if (isNaN(token_amount_raw))
        throw new Error(`[ERROR]: Failed to parse the token amount.`);

    const sol_amount = get_solana_amount_raw(token_amount.uiAmount, mint_meta);
    const instruction_data = sell_data(sol_amount, token_amount_raw, slippage);
    const assoc_address = await calc_assoc_token_addr(seller.publicKey, mint);

    let instructions: TransactionInstruction[] = [];
    instructions.push(new TransactionInstruction({
        keys: [
            { pubkey: ACCOUNT_0, isSigner: false, isWritable: false },
            { pubkey: ACCOUNT_1, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bonding_curve, isSigner: false, isWritable: true },
            { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
            { pubkey: assoc_address, isSigner: false, isWritable: true },
            { pubkey: seller.publicKey, isSigner: true, isWritable: true },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ACCOUNT_2, isSigner: false, isWritable: false },
            { pubkey: TRADE_PROGRAM_ID, isSigner: false, isWritable: false }
        ],
        programId: TRADE_PROGRAM_ID,
        data: instruction_data,
    }));
    return await create_and_send_tx(instructions, seller, [seller], context, max_retries, priority);
    return await create_and_send_tipped_tx(instructions, seller, [seller], tip, priority);
}

function create_data(token_name: string, token_ticker: string, meta_link: string): Buffer {
    const instruction_buf = Buffer.from('181ec828051c0777', 'hex');

    const token_name_buf = Buffer.alloc(4 + token_name.length);
    token_name_buf.writeUInt32LE(token_name.length, 0);
    token_name_buf.write(token_name, 4);

    const token_ticker_buf = Buffer.alloc(4 + token_ticker.length);
    token_ticker_buf.writeUInt32LE(token_ticker.length, 0);
    token_ticker_buf.write(token_ticker, 4);

    const meta_link_buf = Buffer.alloc(4 + meta_link.length);
    meta_link_buf.writeUInt32LE(meta_link.length, 0);
    meta_link_buf.write(meta_link, 4);

    return Buffer.concat([instruction_buf, token_name_buf, token_ticker_buf, meta_link_buf]);
}

export async function create_token(
    creator: Signer, meta: common.IPFSMetadata, cid: string,
    context: RpcResponseAndContext<Readonly<{ blockhash: string; lastValidBlockHeight: number; }>>,
    priority: boolean = false
): Promise<[String, PublicKey]> {
    const max_retries = MAX_RETRIES;
    const meta_link = `${common.IPFS}${cid}`;
    const instruction_data = create_data(meta.name, meta.symbol, meta_link)
    const mint = Keypair.generate();
    const [bonding] = PublicKey.findProgramAddressSync([BONDING_ADDR, mint.publicKey.toBuffer()], TRADE_PROGRAM_ID);
    const [assoc_bonding] = PublicKey.findProgramAddressSync([bonding.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.publicKey.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
    const [metaplex] = PublicKey.findProgramAddressSync([META_ADDR, METAPLEX_TOKEN_META.toBuffer(), mint.publicKey.toBuffer()], METAPLEX_TOKEN_META);

    let instructions: TransactionInstruction[] = [];
    instructions.push(new TransactionInstruction({
        keys: [
            { pubkey: mint.publicKey, isSigner: true, isWritable: true },                       // mint 1
            { pubkey: ACCOUNT_3, isSigner: false, isWritable: false },                          // ACCOUNT3 2
            { pubkey: bonding, isSigner: false, isWritable: true },                             // bonding curve 3
            { pubkey: assoc_bonding, isSigner: false, isWritable: true },                       // assic bonding curve 4
            { pubkey: ACCOUNT_0, isSigner: false, isWritable: false },                          // ACCOUNT0 5
            { pubkey: METAPLEX_TOKEN_META, isSigner: false, isWritable: false },                // METAPLEX_TOKEN_META 6
            { pubkey: metaplex, isSigner: false, isWritable: true },                            // metaplex metadata account 7
            { pubkey: creator.publicKey, isSigner: true, isWritable: true },                    // creater account 8
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },                  // SYSTEM_PROG 9
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },                   // TOKEN_PROG 10
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },        // ASSOC_TOKEN_ACC_PROG 11
            { pubkey: RENT_PROGRAM_ID, isSigner: false, isWritable: false },                    // RENT_PROG 12
            { pubkey: ACCOUNT_2, isSigner: false, isWritable: false },                          // ACCOUNT2 13
            { pubkey: TRADE_PROGRAM_ID, isSigner: false, isWritable: false }                    // TRADE_PROG 14
        ],
        programId: TRADE_PROGRAM_ID,
        data: instruction_data,
    }));

    // const sig = await create_and_send_tipped_tx(instructions, creater, [creater, mint], 30_000_000, priority);
    const sig = await create_and_send_tx(instructions, creator, [creator, mint], context, max_retries, priority);
    return [sig, mint.publicKey];
}

export async function swap_jupiter(
    amount: TokenAmount, seller: Signer, mint: common.TokenMeta,
    context: RpcResponseAndContext<Readonly<{ blockhash: string; lastValidBlockHeight: number; }>>,
    slippage: number = 0.05, priority: boolean = false
): Promise<String> {
    const max_retries = MAX_RETRIES;

    const wallet = new Wallet(Keypair.fromSecretKey(seller.secretKey));
    const amount_in = amount.amount;
    const url = `${JUPITER_API_URL}quote?inputMint=${mint.mint.toString()}&outputMint=${SOLANA_TOKEN.toString()}&amount=${amount_in}&slippageBps=${slippage * 10000}`;

    const quoteResponse = await (
        await fetch(url)
    ).json();

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
                computeUnitPriceMicroLamports: priority ? PRIORITY_MICRO_LAMPORTS : 0,
            })
        })
    ).json();

    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    return await create_and_send_vtx(transaction, [wallet.payer], context, max_retries, priority);
}

// async function load_pool_keys(liquidity_file: string): Promise<any[]> {
//     const liquidity_resp = await fetch(liquidity_file);
//     if (!liquidity_resp.ok) {
//         throw new Error(`[ERROR]: Failed to fetch liquidity file: ${liquidity_file}`);
//     }
//     const liquidity = (await liquidity_resp.json()) as { official: any; unOfficial: any };
//     return [...(liquidity?.official ?? []), ...(liquidity?.unOfficial ?? [])]
// }

// function find_pool_info(pool: any[], base_mint: PublicKey, quote_mint: PublicKey): LiquidityPoolKeys | null {
//     const data = pool.find(
//         (i) => (i.baseMint === base_mint.toString() && i.quoteMint === quote_mint.toString()) || (i.baseMint === quote_mint.toString() && i.quoteMint === base_mint.toString())
//     );
//     if (!data) return null;
//     return jsonInfo2PoolKeys(data) as LiquidityPoolKeys;
// }

// async function get_owner_token_accounts(owner: PublicKey) {
//     const walletTokenAccount = await global.connection.getTokenAccountsByOwner(owner, {
//         programId: TOKEN_PROGRAM_ID,
//     })

//     return walletTokenAccount.value.map((i) => ({
//         pubkey: i.pubkey,
//         programId: i.account.owner,
//         accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
//     }))
// }

// async function get_raydium_swap_tx(amount: number, seller: Signer, mint_from: PublicKey, mint_to: PublicKey, pool_keys: any, slippage: number, priority: boolean): Promise<String> {
//     const max_retries = MAX_RETRIES;
//     const { min_amount_out, amount_in } = await calc_swap_amounts(amount, mint_from, mint_to, pool_keys, slippage);
//     const token_accounts = await get_owner_token_accounts(seller.publicKey);

//     const swap_tx = await Liquidity.makeSwapInstructionSimple({
//         connection: connection,
//         makeTxVersion: 1,
//         poolKeys: {
//             ...pool_keys,
//         },
//         userKeys: {
//             tokenAccounts: token_accounts,
//             owner: seller.publicKey,
//         },
//         amountIn: amount_in,
//         amountOut: min_amount_out,
//         fixedSide: 'in',
//         config: {
//             bypassAssociatedCheck: false,
//         },
//         computeBudgetConfig: priority ? {
//             microLamports: PRIORITY_MICRO_LAMPORTS,
//             units: PRIORITY_UNITS,
//         } : undefined,
//     });

//     return create_and_send_tx(swap_tx.innerTransactions[0].instructions, seller, [seller], max_retries, true);
// }

// async function calc_swap_amounts(amount: number, mint_from: PublicKey, mint_to: PublicKey, pool_keys: any, slippage: number) {
//     const pool_info = await Liquidity.fetchInfo({ connection: global.connection, poolKeys: pool_keys });

//     const currency_in = new Token(TOKEN_PROGRAM_ID, mint_from, pool_keys.baseDecimals);
//     const currency_out = new Token(TOKEN_PROGRAM_ID, mint_to, pool_keys.quoteDecimals);
//     const amount_in = new RaydiumTokenAmount(currency_in, amount, false);
//     const slipage = new Percent(slippage * 100, 100);

//     const { amountOut, minAmountOut, currentPrice, executionPrice, priceImpact, fee } = Liquidity.computeAmountOut({
//         poolKeys: pool_keys,
//         poolInfo: pool_info,
//         amountIn: amount_in,
//         currencyOut: currency_out,
//         slippage: slipage
//     })

//     return {
//         amount_out: amountOut,
//         min_amount_out: minAmountOut,
//         current_price: currentPrice,
//         execution_price: executionPrice,
//         price_impact: priceImpact,
//         fee: fee,
//         amount_in
//     }
// }

// export async function swap_raydium(amount: number, seller: Signer, mint_from: PublicKey, mint_to: PublicKey, slippage: number = 0.05, priority: boolean = false): Promise<String> {
//     const pool = await load_pool_keys(LIQUIDITY_FILE);
//     const pool_keys = find_pool_info(pool, mint_from, mint_to);

//     return get_raydium_swap_tx(amount, seller, mint_from, mint_to, pool_keys, slippage, priority);
// }