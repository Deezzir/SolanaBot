import { readFileSync } from 'fs';
import { readdir } from 'fs/promises';
import dotenv from 'dotenv';
import path, { basename } from 'path';
import { Worker } from 'worker_threads';
import { clearLine, cursorTo } from 'readline';
import { PublicKey } from '@solana/web3.js';
import { createInterface } from 'readline';
import { CurrencyAmount, TokenAmount as RayTokenAmount } from '@raydium-io/raydium-sdk';
dotenv.config();

export const IPFS = 'https://quicknode.quicknode-ipfs.com/ipfs/'
const IPFS_API = 'https://api.quicknode.com/ipfs/rest/v1/s3/put-object';
const IPSF_API_KEY = process.env.IPFS_API_KEY || '';

export type Priority = "low" | "medium" | "high" | "extreme"

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

export type IPFSMetadata = {
    name: string,
    symbol: string,
    description: string,
    image: string | undefined,
    showName: boolean,
    createdOn: string,
    twitter: string | undefined,
    telegram: string | undefined,
    website: string | undefined,
}

export type RaydiumAmounts = {
    amount_in: RayTokenAmount,
    token_in: PublicKey,
    token_out: PublicKey,
    min_amount_out: CurrencyAmount;
}

export type IPFSResponse = {
    requestid: string,
    status: string,
    created: string,
    pin: {
        cid: string,
        name: string,
        origin: [],
        meta: {},
    }
    info: {
        size: string,
    },
    delegates: string[],
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

export interface MintMeta {
    token_name: string;
    token_symbol: string;
    token_decimals: number;
    mint: PublicKey
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
    total_supply: bigint;
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

export function update_bot_config(config: BotConfig, key: string, value: string): void {
    switch (key) {
        case 'thread_cnt':
            if (validate_int(value, 1))
                config.thread_cnt = parseInt(value, 10);
            else
                error('Invalid thread count.');
            break;
        case 'buy_interval':
            if (validate_int(value, 1))
                config.buy_interval = parseInt(value, 10);
            else
                error('Invalid buy interval.');
            break;
        case 'spend_limit':
            if (validate_float(value, 0.001))
                config.spend_limit = parseFloat(value);
            else
                error('Invalid spend limit.');
            break;
        case 'start_buy':
            if (validate_float(value, 0.001))
                config.start_buy = parseFloat(value);
            else
                error('Invalid start buy.');
            break;
        case 'return_pubkey':
            if (is_valid_pubkey(value))
                config.collect_address = new PublicKey(value);
            else
                error('Invalid return public key.');
            break;
        case 'mcap_threshold':
            if (validate_int(value, 5000))
                config.mcap_threshold = parseInt(value, 10);
            else
                error('Invalid market cap threshold.');
            break;
        case 'action':
            value = value.toLowerCase();
            if (value === 'sell')
                config.action = Action.Sell;
            else if (value === 'collect')
                config.action = Action.Collect;
            else
                error('Invalid action.');
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
                error('Invalid mint public key.');
            break;
        default:
            error('Invalid key.');
            break;
    }
}

export function log(message: string): void {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    console.log(message);
    if (global.rl !== undefined) global.rl.prompt(true);
}

export function error(message: string): void {
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
        error(`[ERROR] failed to read keys directory: ${err}`);
        return 0;
    }
}

export function get_key(file_path: string): Uint8Array | undefined {
    try {
        const content = readFileSync(file_path, 'utf8');
        return new Uint8Array(JSON.parse(content));
    } catch (err) {
        error(`[ERROR] failed to read key file: ${err} (${file_path})`);
        return undefined;
    }
}

export const chunks = <T>(array: T[], chunkSize = 10): T[][] => {
    let res: T[][] = [];
    for (let currentChunk = 0; currentChunk < array.length; currentChunk += chunkSize) {
        res.push(array.slice(currentChunk, currentChunk + chunkSize));
    }
    return res;
};

export async function get_keys(to: number, keys_dir: string, from: number = 0): Promise<Uint8Array[]> {
    try {
        const files = natural_sort(await readdir(keys_dir));
        return filter_keys(files).slice(from, to)
            .map(file => get_key(path.join(keys_dir, file)))
            .filter((key): key is Uint8Array => key !== undefined) as Uint8Array[];
    } catch (err) {
        error(`[ERROR] failed to process keys: ${err}`);
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

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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

export function shuffle(array: Array<any>): void {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

export function natural_sort(files: string[]): string[] {
    return files.sort((a, b) => {
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });
}

function box_muller(): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function normal_random(mean: number, std: number): number {
    return Math.abs(mean + box_muller() * Math.sqrt(std));
}

export function read_json(file_path: string): any | undefined {
    try {
        const content = readFileSync(file_path, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        error(`[ERROR] failed to read JSON file: ${err}`);
        return undefined;
    }
}

export async function fetch_ipfs_json(cid: string): Promise<any> {
    const url = `${IPFS}${cid}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        return data;
    } catch (error) {
        throw new Error(`Failed to fetch IPFS JSON: ${error}`);
    }
}

export async function upload_ipfs(data: any, content_type: string, file_name: string): Promise<IPFSResponse | undefined> {
    var headers = new Headers();
    headers.append("x-api-key", IPSF_API_KEY);

    var body_data: BodyInit;
    const form_data = new FormData();

    if (content_type.includes("json")) {
        form_data.append("Key", file_name);
        form_data.append("Content-Type", "application/json; charset=utf-8");
        const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
        form_data.append("Body", blob, "filename.json");
        body_data = form_data;
    } else {
        if (data instanceof File) {
            form_data.append("Body", data, file_name);
        } else {
            console.error("The provided data is not a file.");
            return;
        }
        form_data.append("Key", file_name);
        form_data.append("ContentType", content_type);
        body_data = form_data;
    }

    const requestOptions: RequestInit = {
        method: 'POST',
        headers: headers,
        body: body_data,
        redirect: 'follow'
    };

    try {
        const response = await fetch(IPFS_API, requestOptions);
        const data = await response.json();
        return data as IPFSResponse;
    } catch (error) {
        console.error('Error:', error);
    }
}

export async function create_metadata(meta: IPFSMetadata, image_path: string): Promise<string | undefined> {
    const image_file = new File([readFileSync(image_path)], basename(image_path));
    const resp = await upload_ipfs(image_file, image_file.type, image_file.name);
    if (!resp || resp.status !== 'pinned') {
        console.error('Failed to upload image to IPFS');
        return;
    }
    const cid = resp.pin.cid;
    meta.image = `${IPFS}${cid}`;

    const meta_resp = await upload_ipfs(meta, 'application/json', 'metadata.json');
    if (!meta_resp || meta_resp.status !== 'pinned') {
        console.error('Failed to upload metadata to IPFS');
        return;
    }
    return meta_resp.pin.cid;
}

export function setup_readline(): void {
    global.rl = createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

export function round_two(num: number): number {
    return Math.round((num + Number.EPSILON) * 100) / 100;
}