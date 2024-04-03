import { readFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, Signer, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import path from 'path';
import { Worker } from 'worker_threads';
import { clearLine, cursorTo } from 'readline';

export interface BotConfig {
    thread_cnt: number;
    buy_interval: number;
    spend_limit: number;
    return_pubkey: string;
    mcap_threshold: number;
    token_name: string;
    token_ticker: string;
}

export interface WorkerConfig {
    secret: Uint8Array;
    id: number;
    config: BotConfig;
}

export interface WorkerPromise {
    worker: Worker;
    promise: Promise<void>;
}

export interface MintMeta {
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

export async function count_keys(): Promise<number> {
    try {
        const files = await readdir(global.keysDir);
        return filter_keys(files).length;
    } catch (err) {
        log_error(`[ERROR] failed to read keys directory: ${err}`);
        return 0;
    }
}

export function get_key(file: string): Uint8Array | undefined {
    try {
        const content = readFileSync(path.join(global.keysDir, file), 'utf8');
        return new Uint8Array(JSON.parse(content));
    } catch (err) {
        log_error(`[ERROR] failed to read key file: ${err}`);
        return undefined;
    }
}

export async function get_balance(pubkey: PublicKey): Promise<number> {
    return await global.connection.getBalance(pubkey);
}

export async function get_keys(secrets: Uint8Array[], upto: number): Promise<boolean> {
    let ok = true;
    try {
        const files = natural_sort(await readdir(global.keysDir));
        for (const file of filter_keys(files).slice(0, upto)) {
            const key = get_key(file);
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

export async function send_lamports_to(lamports: number, payer: Signer, receiver: PublicKey, max: boolean = false, priority: boolean = false, retries: number = 0): Promise<string> {
    const max_retries = 5;
    const retry_delay = 1000;

    try {
        const { blockhash, lastValidBlockHeight } = await global.connection.getLatestBlockhash('confirmed');
        const tx = new Transaction({
            feePayer: payer.publicKey,
            blockhash: blockhash,
            lastValidBlockHeight: lastValidBlockHeight,
            signatures: [],
        }).add(SystemProgram.transfer({
            fromPubkey: payer.publicKey,
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
            tx.add(modify_cu, priority_fee);
        }
        return await sendAndConfirmTransaction(global.connection, tx, [payer]);
    } catch (err) {
        if (retries <= max_retries - 1) {
            await new Promise(resolve => setTimeout(resolve, retry_delay));
            return send_lamports_to(lamports, payer, receiver, max, priority, retries + 1);
        } else {
            throw new Error(`Max retries reached, failed to send the transaction. Last error: ${err}`);
        }
    }
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