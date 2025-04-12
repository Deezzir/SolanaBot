import { readFileSync } from 'fs';
import { basename } from 'path';
import { clearLine, cursorTo } from 'readline';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createInterface } from 'readline';
import { parse } from 'csv-parse/sync';
import {
    COMMANDS_DELAY_MS,
    COMMANDS_MAX_RETRIES,
    IPFS_API,
    IPSF_API_KEY,
    PUMP_FETCH_API_URL,
    WALLETS_FILE_HEADERS
} from '../constants.js';
import base58 from 'bs58';

export function staticImplements<T>() {
    return <U extends T>(constructor: U) => {
        red;
        constructor;
    };
}

export type Wallet = {
    name: string;
    keypair: Keypair;
    id: number;
    is_reserve: boolean;
};

export type IPFSMetadata = {
    name: string;
    symbol: string;
    description: string;
    image: string | undefined;
    showName: boolean;
    createdOn: string;
    twitter: string | undefined;
    telegram: string | undefined;
    website: string | undefined;
};

type IPFSResponse = {
    requestid: string;
    status: string;
    created: string;
    pin: {
        cid: string;
        name: string;
        origin: [];
        meta: {};
    };
    info: {
        size: string;
    };
    delegates: string[];
};

export enum Program {
    Pump = 'pump',
    Moonshot = 'moonshot',
    Generic = 'generic'
}

export function bold(message: string): string {
    const boldStart = '\x1b[1m';
    const boldEnd = '\x1b[0m';
    return `${boldStart}${message}${boldEnd}`;
}

export function red(str: string) {
    return `\x1b[31m${str}\x1b[0m`;
}

export function green(str: string) {
    return `\x1b[32m${str}\x1b[0m`;
}

export function yellow(str: string) {
    return `\x1b[33m${str}\x1b[0m`;
}

export function blue(str: string) {
    return `\x1b[34m${str}\x1b[0m`;
}

export function format_currency(value: number): string {
    return value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
    const reserveCount = keys.filter((wallet) => wallet.is_reserve).length;
    return reserveCount === 1;
}

export function filter_wallets(wallet: Wallet[], from?: number, to?: number, list?: number[]): Wallet[] {
    return list ? wallet.filter((wallet) => list.includes(wallet.id)) : wallet.slice(from, to);
}

export async function to_confirm(message: string) {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout
    });

    await new Promise<void>((resolve) => rl.question(green(message), () => resolve()));

    rl.close();
}

export function get_wallets(keys_csv_path: string): Wallet[] {
    const rows: Wallet[] = [];
    let index = 1;
    try {
        const content = readFileSync(keys_csv_path);
        const records = parse(content, {
            delimiter: ',',
            trim: true,
            columns: WALLETS_FILE_HEADERS,
            skip_empty_lines: true,
            from_line: 2
        });

        records.forEach((record: any) => {
            const is_reserve = record.is_reserve === 'true';
            const name = record.name;
            const keypair = Keypair.fromSecretKey(base58.decode(record.private_key));
            const id = is_reserve ? 0 : index++;
            rows.push({
                name: name,
                id: id,
                keypair: keypair,
                is_reserve: is_reserve
            });
        });
        return rows;
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Failed to process wallets in ${keys_csv_path}: ${error.message}`);
        } else {
            throw new Error(`Failed to process wallets in ${keys_csv_path}: ${error}`);
        }
    }
}

export function get_wallet(index: number, wallets: Wallet[]): Wallet | undefined {
    return wallets.find((wallet) => wallet.id == index);
}

export function chunks<T>(array: T[], chunkSize = 10): T[][] {
    let res: T[][] = [];
    for (let currentChunk = 0; currentChunk < array.length; currentChunk += chunkSize) {
        res.push(array.slice(currentChunk, currentChunk + chunkSize));
    }
    return res;
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
    return new Promise((resolve) => setTimeout(resolve, ms));
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

export function random_amounts(total_amount: number, count: number): number[] {
    const mean = total_amount / count;
    const std = mean * 0.51;
    let amounts = Array.from({ length: count }, () => normal_random(mean, std));
    const sum = amounts.reduce((acc, curr) => acc + curr, 0);
    amounts = amounts.map((amount) => (amount / sum) * total_amount);

    amounts = amounts.map((amount) => Math.max(0, amount));

    const adjusted_sum = amounts.reduce((acc, curr) => acc + curr, 0);
    const correction = total_amount - adjusted_sum;
    amounts[0] += correction;
    amounts = amounts.map((amount) => parseFloat(amount.toFixed(3)));

    return amounts;
}

function box_muller(): number {
    let u = 0,
        v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function normal_random(mean: number, std: number): number {
    return Math.abs(mean + box_muller() * std);
}

export function uniform_random(min: number, max: number): number {
    return Math.random() * (max - min) + min;
}

export function read_json(file_path: string): object {
    try {
        const content = readFileSync(file_path, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        throw new Error(`[ERROR] failed to read JSON file: ${err}`);
    }
}

export async function fetch_ipfs_json(cid: string): Promise<any> {
    const url = `${IPFS_API}${cid}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        return data;
    } catch (error) {
        throw new Error(`[ERROR] Failed to fetch IPFS JSON: ${error}`);
    }
}

async function upload_ipfs(data: any, content_type: string, file_name: string): Promise<IPFSResponse> {
    var headers = new Headers();
    headers.append('x-api-key', IPSF_API_KEY);

    var body_data: BodyInit;
    const form_data = new FormData();

    if (content_type.includes('json')) {
        form_data.append('Key', file_name);
        form_data.append('Content-Type', 'application/json; charset=utf-8');
        const blob = new Blob([JSON.stringify(data)], {
            type: 'application/json'
        });
        form_data.append('Body', blob, 'filename.json');
        body_data = form_data;
    } else {
        if (data instanceof File) {
            form_data.append('Body', data, file_name);
        } else {
            throw new Error('The provided data is not a file.');
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
        throw new Error(`Failed to upload to IPFS: ${error}`);
    }
}

export async function create_metadata(meta: IPFSMetadata, image_path: string): Promise<string> {
    try {
        const image_file = new File([readFileSync(image_path)], basename(image_path));
        const resp = await upload_ipfs(image_file, image_file.type, image_file.name);
        if (resp.status !== 'pinned') throw new Error('Failed to upload image to IPFS');
        const cid = resp.pin.cid;
        meta.image = `${IPFS_API}${cid}`;

        const meta_resp = await upload_ipfs(meta, 'application/json', 'metadata.json');
        if (meta_resp.status !== 'pinned') throw new Error('Failed to upload metadata to IPFS');
        return meta_resp.pin.cid;
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`[ERROR] Failed to create metadata: ${error.message}`);
        } else {
            throw new Error(`[ERROR] Failed to create metadata: ${error}`);
        }
    }
}

export function setup_readline(): void {
    if (global.RL) return;
    global.RL = createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

export function close_readline(): void {
    if (!global.RL) return;
    global.RL.prompt(false);
    global.RL.pause().removeAllListeners('line').removeAllListeners('close').close();
    cursorTo(process.stdout, 0);
    clearLine(process.stdout, 0);
}

export function round_two(num: number): number {
    return Math.round((num + Number.EPSILON) * 100) / 100;
}

export const fetch_sol_price = async (): Promise<number> => {
    return fetch(`${PUMP_FETCH_API_URL}/sol-price`)
        .then((response) => response.json())
        .then((data) => {
            if (!data || data.statusCode !== undefined) return 0.0;
            return data.solPrice;
        })
        .catch((err) => {
            error(`[ERROR] Failed fetching the SOL price: ${err}`);
            return 0.0;
        });
};

export function read_bytes(buf: Buffer, offset: number, length: number): Buffer {
    const end = offset + length;
    if (buf.byteLength < end) throw new RangeError('range out of bounds');
    return buf.subarray(offset, end);
}

export function read_biguint_le(buf: Buffer, offset: number, length: number): bigint {
    switch (length) {
        case 1:
            return BigInt(buf.readUint8(offset));
        case 2:
            return BigInt(buf.readUint16LE(offset));
        case 4:
            return BigInt(buf.readUint32LE(offset));
        case 8:
            return buf.readBigUint64LE(offset);
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

export const COLUMN_WIDTHS = {
    id: 5,
    name: 12,
    symbol: 7,
    publicKey: 44,
    solBalance: 14,
    allocation: 10,
    tokenBalance: 20,
    parameter: 20
};

const BORDER_CHARS = {
    topLeft: '╭',
    topRight: '╮',
    bottomLeft: '╰',
    bottomRight: '╯',
    horizontal: '─',
    vertical: '│',
    middle: '┼',
    topMiddle: '┬',
    bottomMiddle: '┴',
    horizontalLeft: '├',
    horizontalRight: '┤'
};

export function format_name(name: string): string {
    return name.length > COLUMN_WIDTHS.name ? name.slice(0, COLUMN_WIDTHS.name - 3) + '...' : name;
}

function format_column(content: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
    if (align === 'left') {
        return content.padEnd(width, ' ');
    }
    if (align === 'right') {
        return content.padStart(width, ' ');
    }
    const padStart = Math.floor((width - content.length) / 2);
    return content.padStart(padStart + content.length, ' ').padEnd(width, ' ');
}

export function print_header(columns: { title: string; width: number; align?: 'left' | 'right' | 'center' }[]) {
    const top_border = columns.map((col) => BORDER_CHARS.horizontal.repeat(col.width + 2)).join(BORDER_CHARS.topMiddle);

    const header = columns
        .map((col) => ` ${format_column(col.title, col.width, col.align)} `)
        .join(`${BORDER_CHARS.vertical}`);

    const separator = columns.map((col) => BORDER_CHARS.horizontal.repeat(col.width + 2)).join(BORDER_CHARS.middle);

    log(`${BORDER_CHARS.topLeft}${top_border}${BORDER_CHARS.topRight}`);
    log(`${BORDER_CHARS.vertical}${header}${BORDER_CHARS.vertical}`);
    log(`${BORDER_CHARS.horizontalLeft}${separator}${BORDER_CHARS.horizontalRight}`);
}

export function print_row(columns: { content: string; width: number; align?: 'left' | 'right' | 'center' }[]) {
    const row = columns
        .map((col) => format_column(col.content, col.width, col.align))
        .join(` ${BORDER_CHARS.vertical} `);
    log(`${BORDER_CHARS.vertical} ${row} ${BORDER_CHARS.vertical}`);
}

export function print_footer(columns: { width: number }[]) {
    const bottomBorder = columns
        .map((col) => BORDER_CHARS.horizontal.repeat(col.width + 2))
        .join(BORDER_CHARS.bottomMiddle);
    log(`${BORDER_CHARS.bottomLeft}${bottomBorder}${BORDER_CHARS.bottomRight}`);
}

export async function retry_with_backoff<T>(
    operation: () => Promise<T>,
    retries = COMMANDS_MAX_RETRIES,
    delay = COMMANDS_DELAY_MS
): Promise<T> {
    try {
        await sleep(delay);
        return await operation();
    } catch (error: any) {
        if (retries === 0 || !error.toString().includes('429')) {
            throw error;
        }
        return retry_with_backoff(operation, retries - 1, delay * 3);
    }
}
