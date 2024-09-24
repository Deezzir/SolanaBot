import { Keypair, LAMPORTS_PER_SOL, PublicKey, Signer, TokenAmount, TransactionInstruction } from '@solana/web3.js';
import * as common from './common.js'
import * as trade_common from './trade_common.js'
import { createAssociatedTokenAccountInstruction } from '@solana/spl-token';

const CURVE_TOKEN_DECIMALS = 6;
const BONDING_ADDR = new Uint8Array([98, 111, 110, 100, 105, 110, 103, 45, 99, 117, 114, 118, 101]);
const META_ADDR = new Uint8Array([109, 101, 116, 97, 100, 97, 116, 97]);

const CURVE_STATE_SIGNATURE = Uint8Array.from([0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60]);
const PUMP_TRADE_PROGRAM_ID = new PublicKey(process.env.PUMP_TRADE_PROGRAM_ID || '');
const GLOBAL_ACCOUNT = new PublicKey(process.env.GLOBAL_ACCOUNT || '');
const FEE_RECIPIENT_ACCOUNT = new PublicKey(process.env.FEE_RECIPIENT_ACCOUNT || '');
const EVENT_AUTHORITUY_ACCOUNT = new PublicKey(process.env.EVENT_AUTHORITUY_ACCOUNT || '');
const MINT_AUTHORITY_ACCOUNT = new PublicKey(process.env.MINT_AUTHORITY_ACCOUNT || '');

const METAPLEX_TOKEN_META = new PublicKey(process.env.METAPLEX_TOKEN_META || 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const TOKEN_PROGRAM_ID = new PublicKey(process.env.TOKEN_PROGRAM_ID || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(process.env.ASSOCIATED_TOKEN_PROGRAM_ID || 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM_ID = new PublicKey(process.env.SYSTEM_PROGRAM_ID || '11111111111111111111111111111111');
const RENT_PROGRAM_ID = new PublicKey(process.env.RENT_PROGRAM_ID || 'SysvarRent111111111111111111111111111111111');

const FETCH_MINT_API_URL = process.env.FETCH_MINT_API_URL || '';

export type PumpTokenMeta = {
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

export function is_pump_meta(obj: any): obj is PumpTokenMeta {
    return (
        typeof obj === 'object' &&
        obj !== null &&
        typeof obj.mint === 'string' &&
        typeof obj.raydium_pool === 'string' &&
        typeof obj.market_cap === 'number' &&
        typeof obj.usd_market_cap === 'number' &&
        typeof obj.bonding_curve === 'string' &&
        typeof obj.associated_bonding_curve === 'string'
    )
}

const CURVE_STATE_SIZE = 0x29;
const CURVE_STATE_OFFSETS = {
    VIRTUAL_TOKEN_RESERVES: 0x08,
    VIRTUAL_SOL_RESERVES: 0x10,
    REAL_TOKEN_RESERVES: 0x18,
    REAL_SOL_RESERVES: 0x20,
    TOKEN_TOTAL_SUPPLY: 0x28,
    COMPLETE: 0x30,
};

interface CurveState {
    virtual_token_reserves: bigint
    virtual_sol_reserves: bigint
    real_token_reserves: bigint
    real_sol_reserves: bigint
    token_total_supply: bigint
    complete: boolean
}

export async function fetch_mint(mint: string): Promise<PumpTokenMeta> {
    return fetch(`${FETCH_MINT_API_URL}/coins/${mint}`)
        .then(response => response.json())
        .then(data => {
            if (!data || data.statusCode !== undefined) return {} as PumpTokenMeta;
            return data as PumpTokenMeta;
        })
        .catch(err => {
            common.error(`[ERROR] Failed fetching the mint: ${err}`);
            return {} as PumpTokenMeta;
        });
}

export async function fetch_random_mints(count: number): Promise<PumpTokenMeta[]> {
    const limit = 50;
    const offset = Array.from({ length: 20 }, (_, i) => i * limit).sort(() => 0.5 - Math.random())[0];
    return fetch(`${FETCH_MINT_API_URL}/coins?offset=${offset}&limit=${limit}&sort=last_trade_timestamp&order=DESC&includeNsfw=false`)
        .then(response => response.json())
        .then((data: any) => {
            if (!data || data.statusCode !== undefined) return [] as PumpTokenMeta[];
            const shuffled = data.sort(() => 0.5 - Math.random());
            return shuffled.slice(0, count) as PumpTokenMeta[];
        })
        .catch(err => {
            common.error(`[ERROR] Failed fetching the mints: ${err}`);
            return [] as PumpTokenMeta[];
        });
}

export async function get_curve_state(bond_curve_addr: PublicKey): Promise<CurveState> {
    const acc_info = await global.CONNECTION.getAccountInfo(bond_curve_addr, 'confirmed');
    if (!acc_info || !acc_info.data || acc_info.data.byteLength < CURVE_STATE_SIGNATURE.byteLength + CURVE_STATE_SIZE) {
        throw new Error('unexpected curve state');
    }

    const idl_signature = common.read_bytes(acc_info.data, 0, CURVE_STATE_SIGNATURE.byteLength);
    if (idl_signature.compare(CURVE_STATE_SIGNATURE) !== 0) {
        throw new Error('unexpected curve state IDL signature');
    }

    return {
        virtual_token_reserves: common.read_biguint_le(acc_info.data, CURVE_STATE_OFFSETS.VIRTUAL_TOKEN_RESERVES, 8),
        virtual_sol_reserves: common.read_biguint_le(acc_info.data, CURVE_STATE_OFFSETS.VIRTUAL_SOL_RESERVES, 8),
        real_token_reserves: common.read_biguint_le(acc_info.data, CURVE_STATE_OFFSETS.REAL_TOKEN_RESERVES, 8),
        real_sol_reserves: common.read_biguint_le(acc_info.data, CURVE_STATE_OFFSETS.REAL_SOL_RESERVES, 8),
        token_total_supply: common.read_biguint_le(acc_info.data, CURVE_STATE_OFFSETS.TOKEN_TOTAL_SUPPLY, 8),
        complete: common.read_bool(acc_info.data, CURVE_STATE_OFFSETS.COMPLETE, 1),
    };
}

export function calc_token_bonding_curve(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([BONDING_ADDR, mint.toBuffer()], PUMP_TRADE_PROGRAM_ID);
}

export function calc_token_assoc_bonding_curve(mint: PublicKey, bonding: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([bonding.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function calculate_curve_price(virtual_sol_reserves: bigint, virtual_token_reserves: bigint): number {
    if (virtual_token_reserves <= 0 || virtual_sol_reserves <= 0) throw new RangeError('curve state contains invalid reserve data');
    return (Number(virtual_sol_reserves) / LAMPORTS_PER_SOL) / (Number(virtual_token_reserves) / 10 ** CURVE_TOKEN_DECIMALS);
}

export function calculate_token_mc(sol_price: number, token_price_sol: number, token_total_supply: bigint): { sol_mc: number, usd_mc: number } {
    const sol_mc = token_price_sol * Number(token_total_supply) / 10 ** CURVE_TOKEN_DECIMALS;
    const usd_mc = sol_mc * sol_price;
    return { sol_mc, usd_mc };
}

function get_token_amount_raw(sol_amount: number, token: Partial<PumpTokenMeta>): number {
    if (!token.virtual_sol_reserves || !token.virtual_token_reserves) return 0;
    const token_price = calculate_curve_price(token.virtual_sol_reserves, token.virtual_token_reserves);
    return Math.round(sol_amount / token_price * 10 ** CURVE_TOKEN_DECIMALS);
}

function get_solana_amount_raw(token_amount: number, token: Partial<PumpTokenMeta>): number {
    if (!token.virtual_sol_reserves || !token.virtual_token_reserves) return 0;
    const token_price = calculate_curve_price(token.virtual_sol_reserves, token.virtual_token_reserves);
    return token_amount * token_price;
}

function calc_slippage_up(sol_amount: number, slippage: number): number {
    const lamports = sol_amount * LAMPORTS_PER_SOL;
    return Math.round(lamports * (1 + slippage));
}

function calc_slippage_down(sol_amount: number, slippage: number): number {
    if (slippage >= 1) throw new RangeError('Slippage must be less than 1');
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

async function get_buy_token_instructions(
    sol_amount: number, buyer: Signer, mint_meta: Partial<PumpTokenMeta>, slippage: number = 0.05
): Promise<TransactionInstruction[]> {
    if (!mint_meta.mint || !mint_meta.bonding_curve || !mint_meta.associated_bonding_curve) {
        throw new Error(`[ERROR]: Failed to get the mint meta.`);
    }

    const mint = new PublicKey(mint_meta.mint);
    const bonding_curve = new PublicKey(mint_meta.bonding_curve);
    const assoc_bonding_curve = new PublicKey(mint_meta.associated_bonding_curve);

    const token_amount = get_token_amount_raw(sol_amount, mint_meta);
    const instruction_data = buy_data(sol_amount, token_amount, slippage);
    const assoc_address = await trade_common.calc_assoc_token_addr(buyer.publicKey, mint);
    const exists = await trade_common.check_account_exists(assoc_address);
    // TODO: Create account in advance
    // TODO: Make a transfer to bloxroute for obfuscation

    let instructions: TransactionInstruction[] = [];
    if (!exists) {
        instructions.push(createAssociatedTokenAccountInstruction(
            buyer.publicKey,
            assoc_address,
            buyer.publicKey,
            mint,
        ));
    }
    instructions.push(new TransactionInstruction({
        keys: [
            { pubkey: GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
            { pubkey: FEE_RECIPIENT_ACCOUNT, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bonding_curve, isSigner: false, isWritable: true },
            { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
            { pubkey: assoc_address, isSigner: false, isWritable: true },
            { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: RENT_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: EVENT_AUTHORITUY_ACCOUNT, isSigner: false, isWritable: false },
            { pubkey: PUMP_TRADE_PROGRAM_ID, isSigner: false, isWritable: false }
        ],
        programId: PUMP_TRADE_PROGRAM_ID,
        data: instruction_data,
    }));

    return instructions;
}

export async function buy_token(
    sol_amount: number, buyer: Signer, mint_meta: PumpTokenMeta, slippage: number = 0.05,
    priority?: common.PriorityLevel
): Promise<String> {
    let instructions = await get_buy_token_instructions(sol_amount, buyer, mint_meta, slippage);
    if (priority) {
        return await trade_common.create_and_send_tx(
            instructions, [buyer],
            { priority_level: priority, accounts: [PUMP_TRADE_PROGRAM_ID.toString()] }
        );
    } else {
        return await trade_common.create_and_send_smart_tx(instructions, [buyer]);
    }
}

async function get_sell_token_instructions(
    token_amount: TokenAmount, seller: Signer, mint_meta: Partial<PumpTokenMeta>, slippage: number = 0.05
): Promise<TransactionInstruction[]> {
    if (!mint_meta.mint || !mint_meta.bonding_curve || !mint_meta.associated_bonding_curve) {
        throw new Error(`[ERROR]: Failed to get the mint meta.`);
    }

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
    const assoc_address = await trade_common.calc_assoc_token_addr(seller.publicKey, mint);

    let instructions: TransactionInstruction[] = [];
    instructions.push(new TransactionInstruction({
        keys: [
            { pubkey: GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
            { pubkey: FEE_RECIPIENT_ACCOUNT, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bonding_curve, isSigner: false, isWritable: true },
            { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
            { pubkey: assoc_address, isSigner: false, isWritable: true },
            { pubkey: seller.publicKey, isSigner: true, isWritable: true },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: EVENT_AUTHORITUY_ACCOUNT, isSigner: false, isWritable: false },
            { pubkey: PUMP_TRADE_PROGRAM_ID, isSigner: false, isWritable: false }
        ],
        programId: PUMP_TRADE_PROGRAM_ID,
        data: instruction_data,
    }));

    return instructions;
}

export async function sell_token(
    token_amount: TokenAmount, seller: Signer, mint_meta: Partial<PumpTokenMeta>,
    slippage: number = 0.05, priority?: common.PriorityLevel
): Promise<String> {
    let instructions = await get_sell_token_instructions(token_amount, seller, mint_meta, slippage);
    if (priority) {
        return await trade_common.create_and_send_tx(
            instructions, [seller],
            { priority_level: priority, accounts: [PUMP_TRADE_PROGRAM_ID.toString()] }
        );
    } else {
        return await trade_common.create_and_send_smart_tx(instructions, [seller]);
    }
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

async function get_create_token_instructions(
    creator: Signer, meta: common.IPFSMetadata, cid: string, mint: Keypair,
): Promise<TransactionInstruction[]> {
    const meta_link = `${common.IPFS}${cid}`;
    const instruction_data = create_data(meta.name, meta.symbol, meta_link);
    const [bonding] = calc_token_bonding_curve(mint.publicKey);
    const [assoc_bonding] = calc_token_assoc_bonding_curve(mint.publicKey, bonding);
    const [metaplex] = PublicKey.findProgramAddressSync([META_ADDR, METAPLEX_TOKEN_META.toBuffer(), mint.publicKey.toBuffer()], METAPLEX_TOKEN_META);

    let instructions: TransactionInstruction[] = [];
    instructions.push(new TransactionInstruction({
        keys: [
            { pubkey: mint.publicKey, isSigner: true, isWritable: true },
            { pubkey: MINT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
            { pubkey: bonding, isSigner: false, isWritable: true },
            { pubkey: assoc_bonding, isSigner: false, isWritable: true },
            { pubkey: GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
            { pubkey: METAPLEX_TOKEN_META, isSigner: false, isWritable: false },
            { pubkey: metaplex, isSigner: false, isWritable: true },
            { pubkey: creator.publicKey, isSigner: true, isWritable: true },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: RENT_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: EVENT_AUTHORITUY_ACCOUNT, isSigner: false, isWritable: false },
            { pubkey: PUMP_TRADE_PROGRAM_ID, isSigner: false, isWritable: false }
        ],
        programId: PUMP_TRADE_PROGRAM_ID,
        data: instruction_data,
    }));

    return instructions;
}

export async function create_token_with_buy(
    creator: Signer, meta: common.IPFSMetadata, cid: string,
    mint: Keypair = Keypair.generate(), sol_amount?: number, priority: common.PriorityLevel = common.PriorityLevel.MEDIUM
): Promise<[String, PublicKey]> {
    let instructions = await get_create_token_instructions(creator, meta, cid, mint);

    const token_meta: Partial<PumpTokenMeta> = {
        mint: mint.publicKey.toString(),
        bonding_curve: instructions[0].keys[2].pubkey.toString(),
        associated_bonding_curve: instructions[0].keys[3].pubkey.toString(),
        market_cap: 27.95,
        total_supply: BigInt(1_000_000_000_000_000), // 1 * 10**9 * 10**6
    };

    if (sol_amount && sol_amount > 0) {
        const buy_instructions = await get_buy_token_instructions(sol_amount, creator, token_meta, 0.05);
        instructions = instructions.concat(buy_instructions);
    }

    let create_sig: String;

    try {
        const priority_options = { priority_level: priority, accounts: [PUMP_TRADE_PROGRAM_ID.toString()] };
        create_sig = await trade_common.create_and_send_tx(instructions, [creator, mint], priority_options);
    } catch (err) {
        throw new Error(`${err}`);
    }

    return [create_sig, mint.publicKey];
}

export async function create_token(
    creator: Signer, meta: common.IPFSMetadata, cid: string, priority?: common.PriorityLevel
): Promise<[String, PublicKey]> {
    const mint = Keypair.generate();
    const instructions = await get_create_token_instructions(creator, meta, cid, mint);
    const sig = await trade_common.create_and_send_tx(
        instructions, [creator, mint],
        { priority_level: priority || common.PriorityLevel.MEDIUM, accounts: ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'] }
    );
    return [sig, mint.publicKey];
}
