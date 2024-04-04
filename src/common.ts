import { readFileSync } from 'fs';
import { readdir } from 'fs/promises';
import dotenv from 'dotenv';
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Signer, SystemProgram, TokenAmount, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountInstruction, createTransferInstruction, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import path from 'path';
import { Worker } from 'worker_threads';
import { clearLine, cursorTo } from 'readline';
dotenv.config();

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(process.env.ASSOCIATED_TOKEN_PROGRAM_ID || 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const TRADE_PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || '');
const ACCOUNT_0 = new PublicKey(process.env.ACCOUNT_0 || '');
const ACCOUNT_1 = new PublicKey(process.env.ACCOUNT_1 || '');

const SYSTEM_PROGRAM_ID = new PublicKey(process.env.SYSTEM_PROGRAM_ID || '11111111111111111111111111111111');
const TOKEN_PROGRAM_ID = new PublicKey(process.env.TOKEN_PROGRAM_ID || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const RENT_PROGRAM_ID = new PublicKey(process.env.RENT_PROGRAM_ID || 'SysvarRent111111111111111111111111111111111');

export interface BotConfig {
    thread_cnt: number;
    buy_interval: number;
    spend_limit: number;
    start_buy: number;
    return_pubkey: PublicKey;
    mcap_threshold: number;
    token_name: string;
    token_ticker: string;
    mint: PublicKey;
}

export interface WorkerConfig {
    secret: Uint8Array;
    id: number;
    inputs: BotConfig;
}

export interface WorkerPromise {
    worker: Worker;
    promise: Promise<void>;
}

export interface TokenMeta {
    mint: string;
    name: string;
    symbol: string;
    description: string;
    image_uri: string;
    metadata_uri: string;
    twitter: string | null;
    telegram: string | null;
    bonding_curve: string;
    associated_bonding_curve: string;
    creator: string;
    created_timestamp: number;
    raydium_pool: string | null;
    complete: boolean;
    virtual_sol_reserves: number;
    virtual_token_reserves: number;
    total_supply: number;
    website: string | null;
    show_name: boolean
    king_of_the_hill_timestamp: number | null;
    market_cap: number;
    reply_count: number;
    last_reply: number | null;
    nsfw: boolean;
    market_id: string | null;
    inverted: boolean | null;
    usd_market_cap: number;
}

export function log(message: string): void {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    console.log(message);
    if (global.rl !== undefined) global.rl.prompt(true);
}

export function log_error(message: string): void {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    console.error(message);
    if (global.rl !== undefined) global.rl.prompt(true);
}

export function filter_keys(files: string[]): string[] {
    return files.filter(file => path.extname(file) === '.json' && /key[0-9]+/.test(path.basename(file)));
}

export async function count_keys(keys_dir: string): Promise<number> {
    try {
        const files = await readdir(keys_dir);
        return filter_keys(files).length;
    } catch (err) {
        log_error(`[ERROR] failed to read keys directory: ${err}`);
        return 0;
    }
}

export function get_key(file_path: string): Uint8Array | undefined {
    try {
        const content = readFileSync(file_path, 'utf8');
        return new Uint8Array(JSON.parse(content));
    } catch (err) {
        log_error(`[ERROR] failed to read key file: ${err}`);
        return undefined;
    }
}

export async function get_balance(pubkey: PublicKey): Promise<number> {
    return await global.connection.getBalance(pubkey);
}

export async function get_keys(secrets: Uint8Array[], upto: number, keys_dir: string): Promise<boolean> {
    let ok = true;
    try {
        const files = natural_sort(await readdir(keys_dir));
        for (const file of filter_keys(files).slice(0, upto)) {
            const key = get_key(path.join(keys_dir, file));
            if (!key) continue;
            const keypair = Keypair.fromSecretKey(key);
            const balance = await get_balance(keypair.publicKey) / LAMPORTS_PER_SOL;
            if (balance === 0) {
                log_error(`File: ${file.padEnd(10, ' ')} | Address: ${keypair.publicKey.toString().padEnd(44, ' ')} | Balance: ${balance.toFixed(9)} SOL`);
                ok = false;
            }
            secrets.push(key);
        }
        if (!ok) log_error('[ERROR] Some accounts are empty.');
        return ok;
    } catch (err) {
        log_error(`[ERROR] failed to process keys: ${err}`);
        return false;
    }
}

export async function clear_lines_up(lines: number): Promise<void> {
    process.stdout.moveCursor(0, -lines);
    process.stdout.clearScreenDown();
}

export function is_valid_pubkey(input: string): boolean {
    if (!/[a-zA-Z0-9]{43,44}/.test(input)) return false;
    try {
        new PublicKey(input);
        return true;
    } catch (err) {
        return false;
    }
}

export function validate_int(input: string, min: number = -Infinity, max: number = Infinity): boolean {
    const num = parseInt(input, 10);
    if (isNaN(num) || num < min || num > max) return false;
    return true;
}

export function validate_float(input: string, min: number = -Infinity, max: number = Infinity): boolean {
    const num = parseFloat(input);
    if (isNaN(num) || num <= min || num > max) return false;
    return true;
}

export function shuffle(array: Array<any>) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

export function natural_sort(files: string[]) {
    return files.sort((a, b) => {
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });
}

export async function send_lamports(lamports: number, sender: Signer, receiver: PublicKey, max: boolean = false, priority: boolean = false, retries: number = 0): Promise<string> {
    const max_retries = 5;
    const retry_delay = 1000;

    try {
        const { blockhash, lastValidBlockHeight } = await global.connection.getLatestBlockhash('confirmed');
        const tx = new Transaction({
            feePayer: sender.publicKey,
            blockhash: blockhash,
            lastValidBlockHeight: lastValidBlockHeight,
            signatures: [],
        }).add(SystemProgram.transfer({
            fromPubkey: sender.publicKey,
            toPubkey: receiver,
            lamports: lamports - (max ? 5000 : 0) - (priority ? 100000 : 0),
        }));
        if (priority) {
            const modify_cu = ComputeBudgetProgram.setComputeUnitLimit({
                units: 1000000,
            });
            const priority_fee = ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: 100000,
            });
            tx.add(modify_cu);
            tx.add(priority_fee);
        }
        return await sendAndConfirmTransaction(global.connection, tx, [sender]);
    } catch (err) {
        if (retries <= max_retries - 1) {
            await new Promise(resolve => setTimeout(resolve, retry_delay));
            return send_lamports(lamports, sender, receiver, max, priority, retries + 1);
        } else {
            throw new Error(`Max retries reached, failed to send the transaction. Last error: ${err}`);
        }
    }
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
        log_error(`[ERROR] Failed to get the transaction fee: ${err}`);
        return 0;
    }
}

async function calc_assoc_token_addr(owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
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

async function check_assoc_token_addr(assoc_address: PublicKey): Promise<boolean> {
    const accountInfo = await connection.getAccountInfo(assoc_address);
    return accountInfo !== null;
}

function get_token_amount_raw(amount: number, token: TokenMeta): number {
    return Math.floor(amount * token.total_supply / token.market_cap);
}

function calc_slippage(sol_amount: number, slippage: number): number {
    const lamports = sol_amount * LAMPORTS_PER_SOL;
    return lamports * (1 + slippage) + lamports * (1 + slippage) / 100;
}

function buy_data(sol_amount: number, token_amount: number, slippage: number): Buffer {
    const instruction_buf = Buffer.from('66063d1201daebea', 'hex');
    const token_amount_buf = Buffer.alloc(8);
    token_amount_buf.writeBigUInt64LE(BigInt(token_amount), 0);
    const slippage_buf = Buffer.alloc(8);
    slippage_buf.writeBigUInt64LE(BigInt(calc_slippage(sol_amount, slippage)), 0);
    return Buffer.concat([instruction_buf, token_amount_buf, slippage_buf]);
}

export async function get_token_balance(pubkey: PublicKey, mint: PublicKey): Promise<TokenAmount> {
    const assoc_addres = await calc_assoc_token_addr(pubkey, mint);
    const account_info = await global.connection.getTokenAccountBalance(assoc_addres);
    return account_info.value || 0;
}

export async function send_tokens(tokens: number, sender: Signer, receiver: PublicKey, owner: PublicKey, priority: boolean = false, retries: number = 0): Promise<string> {
    const max_retries = 5;
    const retry_delay = 1000;

    try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
        const tx = new Transaction({
            feePayer: sender.publicKey,
            blockhash: blockhash,
            lastValidBlockHeight: lastValidBlockHeight,
            signatures: [],
        });
        if (priority) {
            const modify_cu = ComputeBudgetProgram.setComputeUnitLimit({
                units: 1000000,
            });
            const priority_fee = ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: 100000,
            });
            tx.add(modify_cu);
            tx.add(priority_fee);
        }
        tx.add(createTransferInstruction(
            sender.publicKey,
            receiver,
            owner,
            tokens
        ));
        return await sendAndConfirmTransaction(global.connection, tx, [sender]);
    } catch (err) {
        if (retries <= max_retries - 1) {
            await new Promise(resolve => setTimeout(resolve, retry_delay));
            return send_tokens(tokens, sender, receiver, owner, priority, retries + 1);
        } else {
            throw new Error(`Max retries reached, failed to send the transaction. Last error: ${err}`);
        }
    }
}

export async function create_assoc_token_account(payer: Signer, owner: PublicKey, mint: PublicKey, retries: number = 0): Promise<PublicKey> {
    const max_retries = 10;
    const retry_delay = 1000

    try {
        let account = await getOrCreateAssociatedTokenAccount(global.connection, payer, mint, owner);
        return account.address;
    } catch (err) {
        if (retries <= max_retries - 1) {
            await new Promise(resolve => setTimeout(resolve, retry_delay));
            return create_assoc_token_account(payer, owner, mint, retries + 1);
        } else {
            throw new Error(`Max retries reached, failed to get associated token account. Last error: ${err}`);
        }
    }
}

export async function buy_token(sol_amount: number, slippage: number, buyer: Signer, mint_meta: TokenMeta, priority: boolean = false, retries: number = 0): Promise<string> {
    const max_retries = 5;
    const retry_delay = 1000;

    const mint = new PublicKey(mint_meta.mint);
    const bonding_curve = new PublicKey(mint_meta.bonding_curve);
    const assoc_bonding_curve = new PublicKey(mint_meta.associated_bonding_curve);

    const token_amount = get_token_amount_raw(sol_amount, mint_meta);
    const instruction_data = buy_data(sol_amount, token_amount, slippage);

    try {
        const assoc_address = await calc_assoc_token_addr(buyer.publicKey, mint);
        const is_assoc = await check_assoc_token_addr(assoc_address);

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
        const tx = new Transaction({
            feePayer: buyer.publicKey,
            blockhash: blockhash,
            lastValidBlockHeight: lastValidBlockHeight,
            signatures: [],
        });
        if (priority) {
            const modify_cu = ComputeBudgetProgram.setComputeUnitLimit({
                units: 1000000,
            });
            const priority_fee = ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: 100000,
            });
            tx.add(modify_cu);
            tx.add(priority_fee);
        }
        if (!is_assoc) {
            tx.add(createAssociatedTokenAccountInstruction(
                buyer.publicKey,
                assoc_address,
                buyer.publicKey,
                mint,
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID,
            ));
        }
        tx.add(new TransactionInstruction({
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
            ],
            programId: TRADE_PROGRAM_ID,
            data: instruction_data,
        }));
        return await sendAndConfirmTransaction(global.connection, tx, [buyer]);
    } catch (err) {
        if (retries <= max_retries - 1) {
            await new Promise(resolve => setTimeout(resolve, retry_delay));
            return buy_token(sol_amount, slippage, buyer, mint_meta, priority, retries + 1);
        } else {
            throw new Error(`Max retries reached, failed to send the transaction. Last error: ${err}`);
        }
    }
}