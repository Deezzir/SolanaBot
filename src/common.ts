import { createReadStream, readdirSync, readFileSync, statSync } from 'fs';
import { readdir } from 'fs/promises';
import dotenv from 'dotenv';
import path, { basename } from 'path';
import { Worker } from 'worker_threads';
import { clearLine, cursorTo } from 'readline';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createInterface } from 'readline';
import { CurrencyAmount, TokenAmount as RayTokenAmount } from '@raydium-io/raydium-sdk';
import { parse } from 'csv-parse';
import base58 from 'bs58';
dotenv.config();

export const WALLETS_FILE = process.env.KEYS_FILE || 'keys.csv';
export const KEYS_FILE_HEADERS = ['name', 'key', 'is_reserve']
export const IPFS = 'https://quicknode.quicknode-ipfs.com/ipfs/'

const IPFS_API = 'https://api.quicknode.com/ipfs/rest/v1/s3/put-object';
const IPSF_API_KEY = process.env.IPFS_API_KEY || '';
const FETCH_MINT_API_URL = 'https://frontend-api.pump.fun';

export type Wallet = {
    name: string;
    keypair: Keypair;
    id: number;
    is_reserve: boolean;
};

export enum PriorityLevel {
    MIN = 'Min',
    LOW = 'Low',
    MEDIUM = 'Medium',
    HIGH = 'High',
    VERY_HIGH = 'VeryHigh',
    UNSAFE_MAX = 'UnsafeMax',
    DEFAULT = 'Default'
}

export type PriorityOptions = {
    accounts?: string[];
    priority_level: PriorityLevel;
}

export interface BotConfig {
    thread_cnt: number;
    buy_interval: number;
    spend_limit: number;
    start_buy: number;
    mcap_threshold: number;
    is_bump: boolean;
    is_buy_once: boolean;
    start_interval: number | undefined;
    action: Action;
    token_name: string | undefined;
    token_ticker: string | undefined;
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

export enum Program {
    Pump = 'pump',
    Moonshot = 'moonshot',
}

export type WorkerConfig = {
    secret: Uint8Array;
    id: number;
    inputs: BotConfig;
}

export type WorkerJob = {
    worker: Worker;
    index: number;
    job: Promise<void>;
}

export type MintMeta = {
    token_name: string;
    token_symbol: string;
    token_decimals: number;
    mint: PublicKey
}

export function bot_conf_display(config: BotConfig) {
    return {
        ...config,
        action: ActionStrings[config.action],
        token_name: config.token_name ? config.token_name : 'N/A',
        token_ticker: config.token_ticker ? config.token_ticker : 'N/A',
        collect_address: config.collect_address.toString(),
        start_interval: config.start_interval ? config.start_interval : 0,
        mint: config.mint ? config.mint.toString() : 'N/A'
    };
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
        case 'is_bump':
            config.is_bump = value === 'true';
            break;
        case 'is_buy_once':
            config.is_buy_once = value === 'true';
            break;
        case 'start_interval':
            if (validate_int(value, 0))
                config.start_interval = parseInt(value, 10);
            else
                error('Invalid start interval.');
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
    if (global.RL !== undefined) global.RL.prompt(true);
}

export function error(message: string): void {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    console.error(message);
    if (global.RL !== undefined) global.RL.prompt(true);
}

export function check_reserve_exists(keys: Wallet[]): boolean {
    return keys.some(wallet => wallet.is_reserve);
}

export function filter_wallets(wallet: Wallet[], from?: number, to?: number, list?: number[]): Wallet[] {
    return list ? wallet.filter((wallet) => list.includes(wallet.id)) : wallet.slice(from, to);
}

export async function get_wallets(keys_csv_path: string): Promise<Wallet[]> {
    const rows: Wallet[] = [];
    let index = 1;
    try {
        const parser = createReadStream(keys_csv_path)
            .pipe(parse({ columns: true, trim: true }));

        for await (const data of parser) {
            const is_reserve = data.is_reserve === 'true'
            const name = data.name;
            const keypair = Keypair.fromSecretKey(base58.decode(data.key));
            const id = is_reserve ? 0 : index++;
            const row: Wallet = {
                name: name,
                id: id,
                keypair: keypair,
                is_reserve: is_reserve,
            };
            rows.push(row);
        }
        return rows;
    } catch (err) {
        error(`[ERROR] failed to process keys: ${err}`);
        return [];
    }
}

export function get_keypair_from_private_key(private_key: string): Keypair | undefined {
    try {
        return Keypair.fromSecretKey(base58.decode(private_key));
    } catch (err) {
        error(`[ERROR] failed to parse the private key: ${err}`);
        return;
    }
}

export function get_wallet(index: number, wallets: Wallet[]): Wallet | undefined {
    return wallets.find((wallet) => wallet.id == index)
}

export function chunks<T>(array: T[], chunkSize = 10): T[][] {
    let res: T[][] = [];
    for (let currentChunk = 0; currentChunk < array.length; currentChunk += chunkSize) {
        res.push(array.slice(currentChunk, currentChunk + chunkSize));
    }
    return res;
};

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
    headers.append('x-api-key', IPSF_API_KEY);

    var body_data: BodyInit;
    const form_data = new FormData();

    if (content_type.includes('json')) {
        form_data.append('Key', file_name);
        form_data.append('Content-Type', 'application/json; charset=utf-8');
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        form_data.append('Body', blob, 'filename.json');
        body_data = form_data;
    } else {
        if (data instanceof File) {
            form_data.append('Body', data, file_name);
        } else {
            console.error('The provided data is not a file.');
            return;
        }
        form_data.append('Key', file_name);
        form_data.append('ContentType', content_type);
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
    global.RL = createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

export function round_two(num: number): number {
    return Math.round((num + Number.EPSILON) * 100) / 100;
}

export const fetch_sol_price = async (): Promise<number> => {
    return fetch(`${FETCH_MINT_API_URL}/sol-price`)
        .then(response => response.json())
        .then(data => {
            if (!data || data.statusCode !== undefined) return 0.0;
            return data.solPrice;
        })
        .catch(err => {
            console.error(`[ERROR] Failed fetching the SOL price: ${err}`);
            return 0.0;
        });
}

export function validate_bot_config(json: any): BotConfig | undefined {
    const required_fields = [
        'thread_cnt',
        'buy_interval',
        'spend_limit',
        'start_buy',
        'mcap_threshold',
        'action',
        'collect_address'
    ];

    for (const field of required_fields) {
        if (!(field in json)) {
            return;
        }
    }

    const { token_name, token_ticker, mint } = json;

    if (mint === undefined && token_name === undefined && token_ticker === undefined) {
        error('[ERROR] Missing mint or token name and token ticker.');
        return;
    }

    if (mint !== undefined && (token_name !== undefined || token_ticker !== undefined)) {
        error('[ERROR] Mint and token name/token ticker are mutually exclusive. Choose one.');
        return;
    }

    if (token_name === undefined && token_ticker !== undefined || token_name !== undefined && token_ticker === undefined) {
        error('[ERROR] Both token name and token ticker are required.');
        return;
    }

    if (!('is_bump' in json)) json.is_bump = false;
    if (!('is_buy_once' in json)) json.is_buy_once = false;
    if (!('start_interval' in json)) json.start_interval = undefined;
    if (json.mint) json.mint = new PublicKey(json.mint);
    json.collect_address = new PublicKey(json.collect_address);

    return json as BotConfig;
}

export function read_bytes(buf: Buffer, offset: number, length: number): Buffer {
    const end = offset + length;
    if (buf.byteLength < end) throw new RangeError('range out of bounds');
    return buf.subarray(offset, end);
}

export function read_biguint_le(buf: Buffer, offset: number, length: number): bigint {
    switch (length) {
        case 1: return BigInt(buf.readUint8(offset));
        case 2: return BigInt(buf.readUint16LE(offset));
        case 4: return BigInt(buf.readUint32LE(offset));
        case 8: return buf.readBigUint64LE(offset);
    }
    throw new Error(`unsupported data size (${length} bytes)`);
}

export function read_bool(buf: Buffer, offset: number, length: number): boolean {
    const data = read_bytes(buf, offset, length);
    for (const b of data) {
        if (b) return true;
    }
    return false;
}
