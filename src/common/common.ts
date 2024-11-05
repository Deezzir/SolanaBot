import { createReadStream, readFileSync } from 'fs';
import dotenv from 'dotenv';
import { basename } from 'path';
import { clearLine, cursorTo } from 'readline';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createInterface } from 'readline';
import { parse } from 'csv-parse';
import base58 from 'bs58';
dotenv.config();

export const WALLETS_FILE = process.env.KEYS_FILE || 'keys.csv';
export const KEYS_FILE_HEADERS = ['name', 'key', 'is_reserve'];
export const IPFS = 'https://quicknode.quicknode-ipfs.com/ipfs/';

const IPFS_API = 'https://api.quicknode.com/ipfs/rest/v1/s3/put-object';
const IPSF_API_KEY = process.env.IPFS_API_KEY || '';
const FETCH_MINT_API_URL = 'https://frontend-api.pump.fun';

export function staticImplements<T>() {
    return <U extends T>(constructor: U) => {
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
    Moonshot = 'moonshot'
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

export async function get_wallets(keys_csv_path: string): Promise<Wallet[]> {
    const rows: Wallet[] = [];
    let index = 1;
    try {
        const parser = createReadStream(keys_csv_path).pipe(parse({ columns: true, trim: true }));

        for await (const data of parser) {
            const is_reserve = data.is_reserve === 'true';
            const name = data.name;
            const keypair = Keypair.fromSecretKey(base58.decode(data.key));
            const id = is_reserve ? 0 : index++;
            const row: Wallet = {
                name: name,
                id: id,
                keypair: keypair,
                is_reserve: is_reserve
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

function box_muller(): number {
    let u = 0,
        v = 0;
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

async function upload_ipfs(data: any, content_type: string, file_name: string): Promise<IPFSResponse | undefined> {
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
        .then((response) => response.json())
        .then((data) => {
            if (!data || data.statusCode !== undefined) return 0.0;
            return data.solPrice;
        })
        .catch((err) => {
            console.error(`[ERROR] Failed fetching the SOL price: ${err}`);
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
    publicKey: 44,
    solBalance: 14,
    allocation: 10,
    tokenBalance: 18
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

function format_column(content: string, width: number, align: 'left' | 'right' = 'left'): string {
    if (align === 'left') {
        return content.padEnd(width, ' ');
    }
    return content.padStart(width, ' ');
}

export function print_header(columns: { title: string; width: number; align?: 'left' | 'right' }[]) {
    const top_border = columns.map((col) => BORDER_CHARS.horizontal.repeat(col.width + 2)).join(BORDER_CHARS.topMiddle);

    const header = columns
        .map((col) => ` ${format_column(col.title, col.width, col.align)} `)
        .join(`${BORDER_CHARS.vertical}`);

    const separator = columns.map((col) => BORDER_CHARS.horizontal.repeat(col.width + 2)).join(BORDER_CHARS.middle);

    log(`${BORDER_CHARS.topLeft}${top_border}${BORDER_CHARS.topRight}`);
    log(`${BORDER_CHARS.vertical}${header}${BORDER_CHARS.vertical}`);
    log(`${BORDER_CHARS.horizontalLeft}${separator}${BORDER_CHARS.horizontalRight}`);
}

export function print_row(columns: { content: string; width: number; align?: 'left' | 'right' }[]) {
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
