import { readdirSync, readFileSync, statSync } from 'fs';
import { readdir } from 'fs/promises';
import dotenv from 'dotenv';
import path, { basename } from 'path';
import { Worker } from 'worker_threads';
import { clearLine, cursorTo } from 'readline';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createInterface } from 'readline';
import { CurrencyAmount, TokenAmount as RayTokenAmount } from '@raydium-io/raydium-sdk';
// import fetch from 'node-fetch';
dotenv.config();

export const KEYS_DIR = process.env.KEYS_DIR || './keys';
export const RESERVE_KEY_FILE = process.env.RESERVE_KEY_FILE || 'key0.json';
export const RESERVE_KEY_PATH = path.join(KEYS_DIR, RESERVE_KEY_FILE);

export const IPFS = 'https://quicknode.quicknode-ipfs.com/ipfs/'
const IPFS_API = 'https://api.quicknode.com/ipfs/rest/v1/s3/put-object';
const IPSF_API_KEY = process.env.IPFS_API_KEY || '';
const FETCH_MINT_API_URL = process.env.FETCH_MINT_API_URL || '';

export enum EConfigKeys {
    ReserveKeypair = 'ReserveKeypair'
}

export interface IConfig {
    [EConfigKeys.ReserveKeypair]?: Keypair;
}

export class Config {
    public static config: IConfig = {};

    static init(config: IConfig) {
        Config.config = config;
    }

    /**
     * Validator hook to ensure that all passed keys are defined in the Config class
     * @param validateKeys - array of keys to validate. Should have a corresponding getter in Config class
     * @returns 
     */
    public static validatorHook(validateKeys: EConfigKeys[]) {
        return () => {
            for (const key of validateKeys) {
                const getMethod = Config[key];
                if (!getMethod) {
                    throw new Error(`[ERROR] Config key ${key} is not defined.`);
                }
            }
        };
    }

    /**
     * Initialize a config value and store it in the cache.
     * @param key - Key to store the config value, should be a key of IConfig
     * @param initMethod - Method to initialize the config value, should return the value
     * @returns
     */
    private static configCacheBoilerplate(key: keyof IConfig, initMethod: () => any) {
        if (Config.config[key]) {
            return Config.config[key];
        }

        Config.config[key] = initMethod();
        return Config.config[key];
    }

    public static get ReserveKeypair() {
        return <Keypair>this.configCacheBoilerplate(EConfigKeys.ReserveKeypair, () => {
            const RESERVE_KEY_PATH = path.join(KEYS_DIR, RESERVE_KEY_FILE);
            const reserve_keypair = get_keypair(RESERVE_KEY_PATH);

            if (!reserve_keypair) {
                error(`[ERROR] Failed to read the reserve key file: ${RESERVE_KEY_PATH}`);
                process.exit(1);
            }

            return reserve_keypair;
        });
    }
}

export type Key = {
    file_name: string;
    keypair: Keypair;
    index: number;
    is_reserve: boolean;
};

export enum PriorityLevel {
    MIN = "Min",
    LOW = "Low",
    MEDIUM = "Medium",
    HIGH = "High",
    VERY_HIGH = "VeryHigh",
    UNSAFE_MAX = "UnsafeMax",
    DEFAULT = "Default"
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

export type TokenMeta = {
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
    virtual_sol_reserves: bigint;
    virtual_token_reserves: bigint;
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
    username: string;
    profile_image: string | null;
    is_currently_live: boolean;
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

export function get_keypair(file_path: string): Keypair | undefined {
    try {
        const content = readFileSync(file_path, 'utf8');
        return Keypair.fromSecretKey(new Uint8Array(JSON.parse(content)));
    } catch (err) {
        error(`[ERROR] Failed to read key file: ${err} (${file_path})`);
        return undefined;
    }
}

export async function get_rescue_keys(keys_dir: string, keys_list: Key[] = []): Promise<Key[]> {
    const is_valid_key_path = (file_path: string): boolean => {
        if (path.extname(file_path) !== '.json') return false;
        if (!/^key\d+_\d+\.json$/.test(path.basename(file_path))) return false;
        return true;
    }

    const extract_index = (value: string): number => {
        const match = value.match(/(\d+)_(\d+)/);
        if (!match || match.length !== 3) return 0;
        return parseInt(match[1] + match[2], 10);
    }

    try {
        const files = readdirSync(keys_dir);

        files.forEach(file => {
            const file_path = path.join(keys_dir, file);
            const stat = statSync(file_path);

            if (stat.isDirectory()) {
                get_rescue_keys(file_path, keys_list);
            } else if (stat.isFile() && is_valid_key_path(file_path)) {
                const keypair = get_keypair(file_path);
                if (!keypair) return;
                keys_list.push({
                    file_name: file,
                    keypair: keypair,
                    index: extract_index(file),
                    is_reserve: false
                });
            }
        });
        return keys_list;
    } catch (err) {
        error(`[ERROR] failed to read keys directory: ${err}`);
        return []
    }

}

export async function get_keys(keys_dir: string, from?: number, to?: number): Promise<Key[]> {
    const extract_index = (value: string): number => {
        const match = value.match(/\d+/);
        return match ? parseInt(match[0], 10) : 0;
    }

    try {
        const files = natural_sort(await readdir(keys_dir));
        return filter_keys(files).slice(from, to)
            .map(file_name => {
                return {
                    file_name: file_name,
                    keypair: get_keypair(path.join(keys_dir, file_name)),
                    index: extract_index(file_name),
                    is_reserve: file_name === RESERVE_KEY_FILE
                };
            })
            .filter((key) => key.keypair !== undefined) as Key[]
    } catch (err) {
        error(`[ERROR] failed to process keys: ${err}`);
        return [];
    }
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

export async function fetch_mint(mint: string): Promise<TokenMeta> {
    return fetch(`${FETCH_MINT_API_URL}/coins/${mint}`)
        .then(response => response.json())
        .then(data => {
            if (!data || data.statusCode !== undefined) return {} as TokenMeta;
            return data as TokenMeta;
        })
        .catch(err => {
            error(`[ERROR] Failed fetching the mint: ${err}`);
            return {} as TokenMeta;
        });
}

export async function fetch_random_mints(count: number): Promise<TokenMeta[]> {
    const limit = 50;
    const offset = Array.from({ length: 20 }, (_, i) => i * limit).sort(() => 0.5 - Math.random())[0];
    return fetch(`${FETCH_MINT_API_URL}/coins?offset=${offset}&limit=${limit}&sort=last_trade_timestamp&order=DESC&includeNsfw=false`)
        .then(response => response.json())
        .then((data: any) => {
            if (!data || data.statusCode !== undefined) return [] as TokenMeta[];
            const shuffled = data.sort(() => 0.5 - Math.random());
            return shuffled.slice(0, count) as TokenMeta[];
        })
        .catch(err => {
            error(`[ERROR] Failed fetching the mints: ${err}`);
            return [] as TokenMeta[];
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
    if (buf.byteLength < end) throw new RangeError("range out of bounds");
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