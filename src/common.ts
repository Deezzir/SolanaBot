import { readFileSync } from 'fs';
import { readdir } from 'fs/promises';
import dotenv from 'dotenv';
import path from 'path';
import { Worker } from 'worker_threads';
import { clearLine, cursorTo } from 'readline';
import { PublicKey } from '@solana/web3.js';
dotenv.config();

export interface BotConfig {
    thread_cnt: number;
    buy_interval: number;
    spend_limit: number;
    start_buy: number;
    mcap_threshold: number;
    action: Action;
    token_name: string;
    token_ticker: string;
    collect_address: PublicKey;
    mint: PublicKey | undefined;
}

export function BotConfigDisplay(config: BotConfig) {
    return {
        ...config,
        action: ActionStrings[config.action],
        token_name: config.token_name ? config.token_name : 'N/A',
        token_ticker: config.token_ticker ? config.token_ticker : 'N/A',
        collect_address: config.collect_address.toString(),
        mint: config.mint ? config.mint.toString() : 'N/A'
    };
}

export enum Method {
    Wait = 0,
    Snipe = 1,
}

export const MethodStrings = ['Wait', 'Snipe'];

export enum Action {
    Sell = 0,
    Collect = 1,
}

export const ActionStrings = ['Sell', 'Collect'];

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

export function update_bot_config(config: BotConfig, key: string, value: string) {
    switch (key) {
        case 'thread_cnt':
            if (validate_int(value, 1))
                config.thread_cnt = parseInt(value, 10);
            else
                log_error('Invalid thread count.');
            break;
        case 'buy_interval':
            if (validate_int(value, 1))
                config.buy_interval = parseInt(value, 10);
            else
                log_error('Invalid buy interval.');
            break;
        case 'spend_limit':
            if (validate_float(value, 0.001))
                config.spend_limit = parseFloat(value);
            else
                log_error('Invalid spend limit.');
            break;
        case 'start_buy':
            if (validate_float(value, 0.001))
                config.start_buy = parseFloat(value);
            else
                log_error('Invalid start buy.');
            break;
        case 'return_pubkey':
            if (is_valid_pubkey(value))
                config.collect_address = new PublicKey(value);
            else
                log_error('Invalid return public key.');
            break;
        case 'mcap_threshold':
            if (validate_int(value, 5000))
                config.mcap_threshold = parseInt(value, 10);
            else
                log_error('Invalid market cap threshold.');
            break;
        case 'action':
            value = value.toLowerCase();
            if (value === 'sell')
                config.action = Action.Sell;
            else if (value === 'collect')
                config.action = Action.Collect;
            else
                log_error('Invalid action.');
            break;
        case 'token_name':
            config.token_name = value;
            break;
        case 'token_ticker':
            config.token_ticker = value;
            break;
        case 'mint':
            if (is_valid_pubkey(value))
                config.mint = new PublicKey(value);
            else
                log_error('Invalid mint public key.');
            break;
        default:
            log_error('Invalid key.');
            break;
    }
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

export async function get_keys(to: number, keys_dir: string, from: number = 0): Promise<Uint8Array[]> {
    try {
        const files = natural_sort(await readdir(keys_dir));
        return filter_keys(files).slice(from, to)
            .map(file => get_key(path.join(keys_dir, file)))
            .filter((key): key is Uint8Array => key !== undefined) as Uint8Array[];
    } catch (err) {
        log_error(`[ERROR] failed to process keys: ${err}`);
        return [];
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

function box_muller() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function normal_random(mean: number, std: number) {
    return Math.abs(mean + box_muller() * Math.sqrt(std));
}

export function read_json(file_path: string) {
    try {
        const content = readFileSync(file_path, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        log_error(`[ERROR] failed to read JSON file: ${err}`);
        return undefined;
    }
}