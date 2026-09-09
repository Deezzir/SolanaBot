import {
    AddressLookupTableAccount,
    AccountInfo,
    Commitment,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    SystemProgram,
    TokenAmount,
    TransactionInstruction
} from '@solana/web3.js';
import * as common from '../common/common';
import * as trade from '../common/trade_common';
import {
    COMMITMENT,
    IPFS,
    METAPLEX_META_SEED,
    METAPLEX_PROGRAM_ID,
    METEORA_DAMM_V2_API_URL,
    METEORA_CONFIG_HEADER,
    METEORA_DBC_CLAIM_CREATOR_FEE_DISCRIMINATOR,
    METEORA_DBC_CREATE_DISCRIMINATOR,
    METEORA_DBC_CREATE_TOKEN_2022_DISCRIMINATOR,
    METEORA_DAMM_V2_PROGRAM_ID,
    METEORA_DAMM_V2_CLAIM_POSITION_FEE_DISCRIMINATOR,
    METEORA_DAMM_V2_CLAIM_REWARD_DISCRIMINATOR,
    METEORA_DAMM_V2_STATE_HEADER,
    METEORA_DBC_EVENT_AUTHORITY,
    METEORA_DBC_POOL_AUTHORITY,
    METEORA_DBC_PARAMS,
    METEORA_DBC_POOL_SEED,
    METEORA_DBC_VAULT_SEED,
    METEORA_DBC_PROGRAM_ID,
    METEORA_DBC_STATE_HEADER,
    METEORA_LTA_ACCOUNT,
    METEORA_SWAP_DISCRIMINATOR,
    PriorityLevel,
    SOL_MINT,
    TOKEN_METADATA_MAX_BYTES,
    PROGRAM_COMPUTE_UNIT_LIMITS
} from '../constants';
import base58 from 'bs58';
import {
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    createSyncNativeInstruction,
    decode_token_account,
    decode_mint_account,
    getMint,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID
} from '../common/token';
import {
    bytes,
    define_decoder_struct,
    discriminator,
    pubkey,
    skip,
    u128,
    u16,
    u32,
    u8,
    u64
} from '../common/struct_decoder';
import {
    BASIS_POINT_MAX,
    DYNAMIC_FEE_ROUNDING_OFFSET,
    DYNAMIC_FEE_SCALING_FACTOR,
    FEE_DENOMINATOR,
    ONE_Q64,
    ONE_Q128,
    pow_q64,
    quote_exact_in,
    TradeDirection
} from './damm_math';

const METEORA_COMPUTE_UNIT_LIMIT = PROGRAM_COMPUTE_UNIT_LIMITS[common.Program.Meteora];

class MeteoraMintMeta implements trade.IMintMeta {
    mint!: string;
    name: string = 'Unknown';
    symbol: string = 'Unknown';
    pool!: string;

    sol_reserves: bigint = 0n;
    token_reserves: bigint = 0n;
    total_supply: bigint = 0n;
    usd_market_cap: number = 0;
    market_cap: number = 0;
    complete: boolean = false;
    token_decimal: number = 9;
    fee: number = 0;
    token_program_id!: string;

    dbc_data?: DBCData;
    damm_v2_data?: DAMMV2Data;

    constructor(data: Partial<MeteoraMintMeta> = {}) {
        Object.assign(this, data);
    }

    public get token_name(): string {
        return this.name;
    }

    public get token_mint(): string {
        return this.mint.toString();
    }

    public get token_symbol(): string {
        return this.symbol;
    }

    public get token_usd_mc(): number {
        return this.usd_market_cap;
    }

    public get migrated(): boolean {
        return this.damm_v2_data !== undefined;
    }

    public get platform_fee(): number {
        return 0.001;
    }

    public get mint_pubkey(): PublicKey {
        return new PublicKey(this.mint);
    }

    public get token_program(): PublicKey {
        return new PublicKey(this.token_program_id);
    }

    public serialize(): trade.SerializedMintMeta {
        return {
            token_usd_mc: this.token_usd_mc,
            mint_pubkey: this.mint_pubkey.toBase58(),
            token_program: this.token_program.toBase58(),
            migrated: this.migrated,
            platform_fee: this.platform_fee,
            token_name: this.token_name,
            token_symbol: this.token_symbol,
            token_mint: this.token_mint,

            mint: this.mint,
            name: this.name,
            symbol: this.symbol,
            pool: this.pool,
            sol_reserves: this.sol_reserves.toString(),
            token_reserves: this.token_reserves.toString(),
            total_supply: this.total_supply.toString(),
            complete: this.complete,
            usd_market_cap: this.usd_market_cap,
            market_cap: this.market_cap,
            token_decimal: this.token_decimal,
            fee: this.fee,
            token_program_id: this.token_program_id,
            dbc_data: this.dbc_data,
            damm_v2_data: this.damm_v2_data
        };
    }

    public static deserialize(data: trade.SerializedMintMeta): MeteoraMintMeta {
        return new MeteoraMintMeta({
            mint: data.mint as string,
            name: data.name as string,
            symbol: data.symbol as string,
            pool: data.pool as string,
            sol_reserves: BigInt(data.sol_reserves as string),
            token_reserves: BigInt(data.token_reserves as string),
            total_supply: BigInt(data.total_supply as string),
            complete: data.complete as boolean,
            usd_market_cap: data.usd_market_cap as number,
            market_cap: data.market_cap as number,
            token_decimal: data.token_decimal as number,
            fee: data.fee as number,
            token_program_id: data.token_program_id as string,
            dbc_data: data.dbc_data as DBCData,
            damm_v2_data: data.damm_v2_data as DAMMV2Data
        });
    }
}

const DAMMV2StateStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from(METEORA_DAMM_V2_STATE_HEADER)),
    base_fee_data: bytes(32),
    base_fee_padding: skip(8),
    protocol_fee_percent: u8(),
    pool_fee_padding_0: skip(1),
    referral_fee_percent: u8(),
    pool_fee_padding_1: skip(3),
    compounding_fee_bps: u16(),
    dynamic_fee_initialized: u8(),
    dynamic_fee_padding: skip(7),
    dynamic_fee_max_volatility_accumulator: skip(4),
    dynamic_fee_variable_fee_control: u32(),
    dynamic_fee_bin_step: u16(),
    dynamic_fee_padding_0: skip(14),
    dynamic_fee_price_references: skip(32),
    dynamic_fee_volatility_accumulator: u128(),
    dynamic_fee_padding_1: skip(16),
    init_sqrt_price: u128(),
    token_a_mint: pubkey(),
    token_b_mint: pubkey(),
    token_a_vault: pubkey(),
    token_b_vault: pubkey(),
    whitelisted_vault: skip(32),
    pool_padding_0: skip(32),
    liquidity: u128(),
    pool_padding_1: skip(16),
    protocol_a_fee: skip(8),
    protocol_b_fee: skip(8),
    pool_padding_2: skip(16),
    sqrt_min_price: u128(),
    sqrt_max_price: u128(),
    sqrt_price: u128(),
    activation_point: u64(),
    activation_type: u8(),
    pool_status: u8(),
    token_a_flag: u8(),
    token_b_flag: u8(),
    collect_fee_mode: u8(),
    pool_type: skip(1),
    fee_version: u8(),
    pool_padding_3: skip(1),
    fee_a_per_liquidity: bytes(32),
    fee_b_per_liquidity: bytes(32),
    permanent_lock_liquidity: skip(16),
    metrics: skip(80),
    creator: skip(32),
    token_a_amount: u64(),
    token_b_amount: u64(),
    layout_version: u8(),
    pool_padding_4: skip(7),
    pool_padding_5: skip(24),
    reward_infos: bytes(384)
});

const DAMMV2PositionStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from([170, 188, 143, 228, 122, 64, 247, 208])),
    pool: pubkey(),
    nft_mint: pubkey(),
    fee_a_checkpoint: bytes(32),
    fee_b_checkpoint: bytes(32),
    fee_a_pending: u64(),
    fee_b_pending: u64(),
    unlocked_liquidity: u128(),
    vested_liquidity: u128(),
    permanent_locked_liquidity: u128(),
    metrics: skip(16),
    reward_infos: bytes(96),
    padding: skip(96)
});
const DBCCurvePointStruct = define_decoder_struct({ sqrt_price: u128(), liquidity: u128() });

const DBCConfigStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from(METEORA_CONFIG_HEADER)),
    quote_mint: pubkey(),
    fee_claimer: skip(32),
    leftover_receiver: skip(32),
    cliff_fee_numerator: u64(),
    period_frequency: skip(8),
    reduction_factor: u64(),
    number_of_periods: u16(),
    base_fee_mode: u8(),
    base_fee_padding: skip(5),
    dynamic_fee_initialized: u8(),
    dynamic_fee_padding: skip(7),
    max_volatility_accumulator: u32(),
    variable_fee_control: u32(),
    bin_step: skip(2),
    filter_period: u16(),
    decay_period: u16(),
    dynamic_reduction_factor: u16(),
    dynamic_fee_padding_2: skip(8),
    bin_step_u128: skip(16),
    liquidity_vesting_padding: skip(48),
    collect_fee_mode: u8(),
    migration_option: u8(),
    activation_type: skip(1),
    token_decimal: u8(),
    version: skip(1),
    token_type: u8(),
    quote_token_flag: u8(),
    partner_locked_lp_percentage: skip(1),
    partner_lp_percentage: skip(1),
    creator_locked_lp_percentage: skip(1),
    creator_lp_percentage: skip(1),
    migration_fee_option: skip(1),
    fixed_token_supply_flag: u8(),
    creator_trading_fee_percentage: skip(1),
    config_padding: skip(10),
    swap_base_amount: u64(),
    migration_quote_threshold: u64(),
    migration_base_threshold: u64(),
    migration_sqrt_price: u128(),
    vesting_amount_per_period: u64(),
    vesting_cliff_duration: skip(8),
    vesting_frequency: skip(8),
    vesting_number_of_periods: u64(),
    vesting_cliff_unlock_amount: u64(),
    vesting_padding: skip(8),
    pre_migration_token_supply: u64(),
    post_migration_token_supply: skip(8),
    config_padding_3: skip(5),
    enable_first_swap_with_min_fee: u8(),
    config_padding_4: skip(26),
    sqrt_start_price: u128(),
    curve: {
        size: METEORA_DBC_PARAMS.curve_points * DBCCurvePointStruct.get_size(),
        decode: (data: Buffer, offset: number) => {
            const curve: ReturnType<typeof DBCCurvePointStruct.decode>[] = [];
            for (let i = 0; i < METEORA_DBC_PARAMS.curve_points; i++) {
                const point = DBCCurvePointStruct.decode(data.subarray(offset + i * DBCCurvePointStruct.get_size()));
                if (point.liquidity === 0n || point.sqrt_price === 0n) break;
                curve.push(point);
            }
            return curve;
        }
    }
});

const DBCStateStruct = define_decoder_struct({
    discriminator: discriminator(Buffer.from(METEORA_DBC_STATE_HEADER)),
    state_padding: skip(64),
    config: pubkey(),
    creator: pubkey(),
    base_mint: pubkey(),
    base_vault: pubkey(),
    quote_vault: pubkey(),
    base_reserve: u64(),
    quote_reserve: u64(),
    protocol_base_fee: skip(8),
    protocol_quote_fee: skip(8),
    partner_base_fee: skip(8),
    partner_quote_fee: skip(8),
    sqrt_price: bytes(16),
    activation_point: skip(8),
    pool_type: skip(1),
    is_migrated: u8(),
    state_flags: skip(5),
    state_padding_2: skip(33),
    finish_curve_timestamp: skip(8),
    creator_base_fee: u64(),
    creator_quote_fee: u64()
});
type DBCState = {
    pool: PublicKey;
    token_decimals: number;
    total_supply: bigint;
    base_mint: PublicKey;
    config: PublicKey;
    quote_mint: PublicKey;
    base_vault: PublicKey;
    quote_vault: PublicKey;
    base_reserve: bigint;
    quote_reserve: bigint;
    sqrt_price: bigint;
    creator: PublicKey;
    is_migrated: boolean;
};
type DAMMV2Data = {
    token_a_mint: string;
    token_b_mint: string;
    token_a_vault: string;
    token_b_vault: string;
    token_a_amount: bigint;
    token_b_amount: bigint;
    fee_numerator: bigint;
};

type DBCData = {
    sqrt_price: bigint;
    config: string;
    base_vault: string;
    quote_vault: string;
    creation?: {
        config: ReturnType<typeof DBCConfigStruct.decode>;
        first_swap: boolean;
        volatility_accumulator: bigint;
        sqrt_price_reference: bigint;
        has_swap_timestamp: boolean;
    };
};

type MeteoraClaimableAsset = trade.ClaimableAsset & {
    pool: PublicKey;
    kind?: 'damm_fee' | 'damm_reward';
    state?: ReturnType<typeof DBCStateStruct.decode>;
    config?: ReturnType<typeof DBCConfigStruct.decode>;
    damm_state?: ReturnType<typeof DAMMV2StateStruct.decode>;
    position?: PublicKey;
    position_nft_account?: PublicKey;
    reward_index?: number;
    token_program?: PublicKey;
};

export class Trader implements trade.IProgramTrader {
    public get_name(): string {
        return common.Program.Meteora;
    }

    public get_lta_addresses(): PublicKey[] {
        return [METEORA_LTA_ACCOUNT];
    }

    public deserialize_mint_meta(data: trade.SerializedMintMeta): MeteoraMintMeta {
        return MeteoraMintMeta.deserialize(data);
    }

    public async get_trader_fees(trader: Keypair): Promise<MeteoraClaimableAsset[]> {
        const pools = await trade.get_program_accounts_v2(METEORA_DBC_PROGRAM_ID, [
            { memcmp: { offset: DBCStateStruct.get_offset('creator'), bytes: trader.publicKey.toBase58() } },
            { memcmp: { offset: 0, bytes: base58.encode(METEORA_DBC_STATE_HEADER) } }
        ]);

        const assets = await Promise.all(
            pools.map(async ({ pubkey, account }) => {
                const state = DBCStateStruct.decode(account.data);
                if (state.creator_base_fee === 0n && state.creator_quote_fee === 0n) return [];

                const config_info = await global.CONNECTION.getAccountInfo(state.config, COMMITMENT);
                if (!config_info) {
                    // common.warn('DBC configuration account is missing.');
                    return [];
                }

                const config = DBCConfigStruct.decode(config_info.data);
                if (config.token_type !== 0 || config.quote_token_flag !== 0) {
                    // common.warn('DBC Token-2022 or transfer-hook creator-fee claims are not supported.');
                    return [];
                }
                const claimable: MeteoraClaimableAsset[] = [];
                if (state.creator_base_fee > 0n) {
                    const supply = await trade.get_token_supply(state.base_mint);
                    claimable.push({
                        mint: state.base_mint,
                        raw_amount: state.creator_base_fee,
                        decimals: supply.decimals,
                        source: 'creator_reward' as const,
                        state,
                        config,
                        pool: pubkey
                    });
                }
                if (state.creator_quote_fee > 0n) {
                    const supply = await trade.get_token_supply(config.quote_mint);
                    claimable.push({
                        mint: config.quote_mint,
                        raw_amount: state.creator_quote_fee,
                        decimals: config.quote_mint.equals(SOL_MINT) ? 9 : supply.decimals,
                        source: 'creator_reward' as const,
                        state,
                        config,
                        pool: pubkey
                    });
                }
                return claimable;
            })
        );
        return [...assets.flat(), ...(await this.get_damm_v2_position_rewards(trader))];
    }

    public async claim_trader_fees(
        trader: Keypair,
        assets: MeteoraClaimableAsset[],
        priority?: PriorityLevel
    ): Promise<String> {
        if (assets.length === 0) throw new Error(`No assets were provided`);

        const created_atas = new Set<string>();
        const add_ata = async (mint: PublicKey) => {
            const ata = await trade.calc_ata(trader.publicKey, mint);
            if (!created_atas.has(ata.toBase58())) {
                instructions.push(
                    createAssociatedTokenAccountIdempotentInstruction(trader, ata, trader.publicKey, mint)
                );
                created_atas.add(ata.toBase58());
            }
            return ata;
        };

        const instructions: TransactionInstruction[] = [];

        const claimed_pools = new Set<string>();
        const claimed_positions = new Set<string>();
        for (const asset of assets) {
            if (asset.kind) {
                if (!asset.damm_state || !asset.position || !asset.position_nft_account) continue;
                if (asset.kind === 'damm_fee') {
                    if (claimed_positions.has(asset.position.toBase58())) continue;
                    claimed_positions.add(asset.position.toBase58());
                }
                const state = asset.damm_state;
                const token_a_program = await this.get_token_program(state.token_a_mint);
                const token_b_program = await this.get_token_program(state.token_b_mint);
                const token_a_ata = await trade.calc_ata(trader.publicKey, state.token_a_mint, token_a_program);
                const token_b_ata = await trade.calc_ata(trader.publicKey, state.token_b_mint, token_b_program);
                for (const [mint, ata, program] of [
                    [state.token_a_mint, token_a_ata, token_a_program],
                    [state.token_b_mint, token_b_ata, token_b_program]
                ] as const) {
                    if (!created_atas.has(ata.toBase58())) {
                        instructions.push(
                            createAssociatedTokenAccountIdempotentInstruction(
                                trader,
                                ata,
                                trader.publicKey,
                                mint,
                                program
                            )
                        );
                        created_atas.add(ata.toBase58());
                    }
                }
                const [pool_authority] = await PublicKey.findProgramAddress(
                    [Buffer.from('pool_authority')],
                    METEORA_DAMM_V2_PROGRAM_ID
                );
                const [event_authority] = await PublicKey.findProgramAddress(
                    [Buffer.from('__event_authority')],
                    METEORA_DAMM_V2_PROGRAM_ID
                );
                if (asset.kind === 'damm_fee') {
                    instructions.push(
                        new TransactionInstruction({
                            programId: METEORA_DAMM_V2_PROGRAM_ID,
                            data: Buffer.from(METEORA_DAMM_V2_CLAIM_POSITION_FEE_DISCRIMINATOR),
                            keys: [
                                { pubkey: pool_authority, isSigner: false, isWritable: false },
                                { pubkey: asset.pool, isSigner: false, isWritable: false },
                                { pubkey: asset.position, isSigner: false, isWritable: true },
                                { pubkey: token_a_ata, isSigner: false, isWritable: true },
                                { pubkey: token_b_ata, isSigner: false, isWritable: true },
                                { pubkey: state.token_a_vault, isSigner: false, isWritable: true },
                                { pubkey: state.token_b_vault, isSigner: false, isWritable: true },
                                { pubkey: state.token_a_mint, isSigner: false, isWritable: false },
                                { pubkey: state.token_b_mint, isSigner: false, isWritable: false },
                                { pubkey: asset.position_nft_account, isSigner: false, isWritable: false },
                                { pubkey: trader.publicKey, isSigner: true, isWritable: false },
                                { pubkey: token_a_program, isSigner: false, isWritable: false },
                                { pubkey: token_b_program, isSigner: false, isWritable: false },
                                { pubkey: event_authority, isSigner: false, isWritable: false },
                                { pubkey: METEORA_DAMM_V2_PROGRAM_ID, isSigner: false, isWritable: false }
                            ]
                        })
                    );
                } else if (asset.reward_index !== undefined && asset.token_program) {
                    const reward_ata = await trade.calc_ata(trader.publicKey, asset.mint, asset.token_program);
                    if (!created_atas.has(reward_ata.toBase58())) {
                        instructions.push(
                            createAssociatedTokenAccountIdempotentInstruction(
                                trader,
                                reward_ata,
                                trader.publicKey,
                                asset.mint,
                                asset.token_program
                            )
                        );
                        created_atas.add(reward_ata.toBase58());
                    }
                    const data = Buffer.from([...METEORA_DAMM_V2_CLAIM_REWARD_DISCRIMINATOR, asset.reward_index, 0]);
                    const reward = this.damm_reward_info(state.reward_infos, asset.reward_index);
                    instructions.push(
                        new TransactionInstruction({
                            programId: METEORA_DAMM_V2_PROGRAM_ID,
                            data,
                            keys: [
                                { pubkey: pool_authority, isSigner: false, isWritable: false },
                                { pubkey: asset.pool, isSigner: false, isWritable: true },
                                { pubkey: asset.position, isSigner: false, isWritable: true },
                                { pubkey: reward.vault, isSigner: false, isWritable: true },
                                { pubkey: asset.mint, isSigner: false, isWritable: false },
                                { pubkey: reward_ata, isSigner: false, isWritable: true },
                                { pubkey: asset.position_nft_account, isSigner: false, isWritable: false },
                                { pubkey: trader.publicKey, isSigner: true, isWritable: false },
                                { pubkey: asset.token_program, isSigner: false, isWritable: false },
                                { pubkey: event_authority, isSigner: false, isWritable: false },
                                { pubkey: METEORA_DAMM_V2_PROGRAM_ID, isSigner: false, isWritable: false }
                            ]
                        })
                    );
                }
                continue;
            }
            if (claimed_pools.has(asset.pool.toBase58())) continue;
            claimed_pools.add(asset.pool.toBase58());
            const state = asset.state!;
            const config = asset.config!;

            const base_ata = await add_ata(state.base_mint);
            const quote_ata = await add_ata(config.quote_mint);
            const data = Buffer.alloc(24);
            Buffer.from(METEORA_DBC_CLAIM_CREATOR_FEE_DISCRIMINATOR).copy(data);
            data.writeBigUInt64LE(state.creator_base_fee, 8);
            data.writeBigUInt64LE(state.creator_quote_fee, 16);
            instructions.push(
                new TransactionInstruction({
                    programId: METEORA_DBC_PROGRAM_ID,
                    data,
                    keys: [
                        { pubkey: METEORA_DBC_POOL_AUTHORITY, isSigner: false, isWritable: false },
                        { pubkey: asset.pool, isSigner: false, isWritable: true },
                        { pubkey: base_ata, isSigner: false, isWritable: true },
                        { pubkey: quote_ata, isSigner: false, isWritable: true },
                        { pubkey: state.base_vault, isSigner: false, isWritable: true },
                        { pubkey: state.quote_vault, isSigner: false, isWritable: true },
                        { pubkey: state.base_mint, isSigner: false, isWritable: false },
                        { pubkey: config.quote_mint, isSigner: false, isWritable: false },
                        { pubkey: trader.publicKey, isSigner: true, isWritable: false },
                        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                        { pubkey: METEORA_DBC_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                        { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: false }
                    ]
                })
            );
            if (config.quote_mint.equals(SOL_MINT))
                instructions.push(createCloseAccountInstruction(quote_ata, trader.publicKey, trader.publicKey));
        }

        if (instructions.length === 0) throw new Error('Invalid assets were provided, no tx was derived');
        return await trade.send_tx(
            instructions,
            [trader],
            priority,
            undefined,
            false,
            undefined,
            METEORA_COMPUTE_UNIT_LIMIT
        );
    }

    private damm_u256_le(data: Buffer): bigint {
        let value = 0n;
        for (let i = 31; i >= 0; i--) value = (value << 8n) + BigInt(data[i]);
        return value;
    }

    private damm_reward_info(
        data: Buffer,
        index: number
    ): {
        initialized: boolean;
        mint: PublicKey;
        vault: PublicKey;
        end: bigint;
        rate: bigint;
        stored: bigint;
        last_update: bigint;
    } {
        const offset = index * 192;
        return {
            initialized: data.readUInt8(offset) !== 0,
            mint: new PublicKey(data.subarray(offset + 16, offset + 48)),
            vault: new PublicKey(data.subarray(offset + 48, offset + 80)),
            end: data.readBigUInt64LE(offset + 120),
            rate: data.readBigUInt64LE(offset + 128) + (data.readBigUInt64LE(offset + 136) << 64n),
            stored: this.damm_u256_le(data.subarray(offset + 144, offset + 176)),
            last_update: data.readBigUInt64LE(offset + 176)
        };
    }

    private async get_damm_v2_position_rewards(trader: Keypair): Promise<MeteoraClaimableAsset[]> {
        const nft_accounts = await global.CONNECTION.getTokenAccountsByOwner(
            trader.publicKey,
            { programId: TOKEN_2022_PROGRAM_ID },
            COMMITMENT
        );
        const positions = await Promise.all(
            nft_accounts.value
                .filter(({ account }) => decode_token_account(account).amount === 1n)
                .map(async ({ pubkey, account }) => {
                    const nft_mint = decode_token_account(account).mint;
                    const [position] = await PublicKey.findProgramAddress(
                        [Buffer.from('position'), nft_mint.toBytes()],
                        METEORA_DAMM_V2_PROGRAM_ID
                    );
                    return { position, nft_account: pubkey };
                })
        );
        if (positions.length === 0) return [];

        const position_infos = await global.CONNECTION.getMultipleAccountsInfo(
            positions.map(({ position }) => position),
            COMMITMENT
        );
        const decoded_positions = positions.flatMap(({ position, nft_account }, index) => {
            const info = position_infos[index];
            if (!info || !info.owner.equals(METEORA_DAMM_V2_PROGRAM_ID)) return [];
            try {
                return [{ position, nft_account, state: DAMMV2PositionStruct.decode(info.data) }];
            } catch {
                return [];
            }
        });
        const pools = [...new Map(decoded_positions.map(({ state }) => [state.pool.toBase58(), state.pool])).values()];
        const pool_infos = await global.CONNECTION.getMultipleAccountsInfo(pools, COMMITMENT);
        const pool_states = new Map<string, ReturnType<typeof DAMMV2StateStruct.decode>>();
        for (let i = 0; i < pools.length; i++) {
            const info = pool_infos[i];
            if (!info || !info.owner.equals(METEORA_DAMM_V2_PROGRAM_ID)) continue;
            try {
                pool_states.set(pools[i].toBase58(), DAMMV2StateStruct.decode(info.data));
            } catch {}
        }
        if (pool_states.size === 0) return [];
        const slot = await global.CONNECTION.getSlot(COMMITMENT);
        const current_time = BigInt((await global.CONNECTION.getBlockTime(slot)) ?? 0);
        const assets: MeteoraClaimableAsset[] = [];
        for (const { position, nft_account, state: position_state } of decoded_positions) {
            const pool_state = pool_states.get(position_state.pool.toBase58());
            if (!pool_state) continue;
            const liquidity =
                position_state.unlocked_liquidity +
                position_state.vested_liquidity +
                position_state.permanent_locked_liquidity;
            const fee_a =
                position_state.fee_a_pending +
                ((liquidity *
                    (this.damm_u256_le(pool_state.fee_a_per_liquidity) -
                        this.damm_u256_le(position_state.fee_a_checkpoint))) >>
                    128n);
            const fee_b =
                position_state.fee_b_pending +
                ((liquidity *
                    (this.damm_u256_le(pool_state.fee_b_per_liquidity) -
                        this.damm_u256_le(position_state.fee_b_checkpoint))) >>
                    128n);
            if (fee_a > 0n || fee_b > 0n) {
                const [a_supply, b_supply] = await Promise.all([
                    trade.get_token_supply(pool_state.token_a_mint),
                    trade.get_token_supply(pool_state.token_b_mint)
                ]);
                if (fee_a > 0n)
                    assets.push({
                        mint: pool_state.token_a_mint,
                        raw_amount: fee_a,
                        decimals: a_supply.decimals,
                        source: 'position_reward',
                        kind: 'damm_fee',
                        pool: position_state.pool,
                        damm_state: pool_state,
                        position,
                        position_nft_account: nft_account
                    });
                if (fee_b > 0n)
                    assets.push({
                        mint: pool_state.token_b_mint,
                        raw_amount: fee_b,
                        decimals: b_supply.decimals,
                        source: 'position_reward',
                        kind: 'damm_fee',
                        pool: position_state.pool,
                        damm_state: pool_state,
                        position,
                        position_nft_account: nft_account
                    });
            }
            for (let index = 0; index < 2; index++) {
                const reward = this.damm_reward_info(pool_state.reward_infos, index);
                if (!reward.initialized || liquidity === 0n) continue;
                const checkpoint = this.damm_u256_le(position_state.reward_infos.subarray(index * 48, index * 48 + 32));
                const pending = position_state.reward_infos.readBigUInt64LE(index * 48 + 32);
                const stored =
                    reward.stored +
                    (((BigInt.asUintN(64, current_time < reward.end ? current_time : reward.end) - reward.last_update) *
                        reward.rate) <<
                        128n) /
                        pool_state.liquidity;
                const amount = pending + ((liquidity * (stored - checkpoint)) >> 192n);
                if (amount <= 0n) continue;
                const token_program = await this.get_token_program(reward.mint);
                const supply = await trade.get_token_supply(reward.mint);
                assets.push({
                    mint: reward.mint,
                    raw_amount: amount,
                    decimals: supply.decimals,
                    source: 'position_reward',
                    kind: 'damm_reward',
                    pool: position_state.pool,
                    damm_state: pool_state,
                    position,
                    position_nft_account: nft_account,
                    reward_index: index,
                    token_program
                });
            }
        }
        return assets;
    }

    public async buy_token(
        sol_amount: number,
        buyer: Keypair,
        mint_meta: MeteoraMintMeta,
        slippage: number,
        priority?: PriorityLevel,
        protection_tip?: number,
        mev_protect: boolean = false
    ): Promise<String> {
        const [instructions, ltas] = await this.buy_token_instructions(sol_amount, buyer, mint_meta, slippage);
        return await trade.send_tx(
            instructions,
            [buyer],
            priority,
            protection_tip,
            mev_protect,
            ltas,
            METEORA_COMPUTE_UNIT_LIMIT
        );
    }

    public async sell_token(
        token_amount: TokenAmount,
        seller: Keypair,
        mint_meta: MeteoraMintMeta,
        slippage: number,
        priority?: PriorityLevel,
        protection_tip?: number,
        mev_protect: boolean = false
    ): Promise<String> {
        const [instructions, ltas] = await this.sell_token_instructions(token_amount, seller, mint_meta, slippage);
        return await trade.send_tx(
            instructions,
            [seller],
            priority,
            protection_tip,
            mev_protect,
            ltas,
            METEORA_COMPUTE_UNIT_LIMIT
        );
    }

    public async buy_token_instructions(
        sol_amount: number,
        buyer: Keypair,
        mint_meta: MeteoraMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        trade.validate_trade_parameters(sol_amount, slippage);
        const lta = await trade.get_ltas([METEORA_LTA_ACCOUNT]);
        if (mint_meta.migrated) {
            if (!mint_meta.damm_v2_data) throw new Error('Missing DAMM v2 pool data.');
            return [await this.get_buy_damm_v2_instructions(sol_amount, buyer, mint_meta, slippage), lta];
        }
        return [await this.get_buy_dbc_instructions(sol_amount, buyer, mint_meta, slippage), lta];
    }

    public async sell_token_instructions(
        token_amount: TokenAmount,
        seller: Keypair,
        mint_meta: MeteoraMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        trade.validate_trade_parameters(token_amount, slippage);
        const lta = await trade.get_ltas([METEORA_LTA_ACCOUNT]);
        if (mint_meta.migrated) {
            if (!mint_meta.damm_v2_data) throw new Error('Missing DAMM v2 pool data.');
            return [await this.get_sell_damm_v2_instructions(token_amount, seller, mint_meta, slippage), lta];
        }
        return [await this.get_sell_dbc_instructions(token_amount, seller, mint_meta, slippage), lta];
    }

    public async buy_sell_instructions(
        sol_amount: number,
        trader: Keypair,
        mint_meta: MeteoraMintMeta,
        slippage: number
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]> {
        trade.validate_trade_parameters(sol_amount, slippage);
        const sol_amount_raw = common.sol_to_lamports(sol_amount);
        let buy_instructions: TransactionInstruction[];
        let lta: AddressLookupTableAccount[] | undefined;
        let token_amount_raw: bigint;
        if (mint_meta.migrated) {
            const result = await this.get_damm_v2_swap_instructions(sol_amount_raw, trader, mint_meta, true, slippage);
            buy_instructions = result.instructions;
            token_amount_raw = result.output_amount;
            lta = await trade.get_ltas([METEORA_LTA_ACCOUNT]);
        } else {
            [buy_instructions, lta] = await this.buy_token_instructions(sol_amount, trader, mint_meta, slippage);
            token_amount_raw = this.calc_dbc_token_amount_raw(sol_amount_raw, mint_meta.dbc_data!);
        }
        let [sell_instructions] = await this.sell_token_instructions(
            {
                uiAmount: Number(token_amount_raw) / 10 ** mint_meta.token_decimal,
                amount: token_amount_raw.toString(),
                decimals: mint_meta.token_decimal
            },
            trader,
            mint_meta,
            slippage
        );
        return [buy_instructions, sell_instructions, lta];
    }

    public async buy_sell_bundle(
        sol_amount: number,
        trader: Keypair,
        mint_meta: MeteoraMintMeta,
        tip: number,
        slippage: number,
        priority?: PriorityLevel
    ): Promise<String> {
        const [buy_instructions, sell_instructions, lta] = await this.buy_sell_instructions(
            sol_amount,
            trader,
            mint_meta,
            slippage
        );
        return await trade.send_bundle(
            [buy_instructions, sell_instructions],
            [[trader], [trader]],
            tip,
            priority,
            lta,
            METEORA_COMPUTE_UNIT_LIMIT
        );
    }

    public async buy_sell(
        sol_amount: number,
        trader: Keypair,
        mint_meta: MeteoraMintMeta,
        slippage: number,
        interval_ms?: number,
        priority?: PriorityLevel,
        protection_tip?: number,
        mev_protect: boolean = false
    ): Promise<[String, String]> {
        const [buy_instructions, sell_instructions, ltas] = await this.buy_sell_instructions(
            sol_amount,
            trader,
            mint_meta,
            slippage
        );

        if (interval_ms && interval_ms > 0) {
            const buy_signature = await trade.send_tx(
                buy_instructions,
                [trader],
                priority,
                protection_tip,
                mev_protect,
                ltas,
                METEORA_COMPUTE_UNIT_LIMIT
            );
            await common.sleep(interval_ms);
            const sell_signature = await trade.retry_send_tx(
                sell_instructions,
                [trader],
                priority,
                protection_tip,
                mev_protect,
                ltas,
                METEORA_COMPUTE_UNIT_LIMIT
            );
            return [buy_signature, sell_signature];
        }

        const signature = await trade.send_tx(
            [...buy_instructions, ...sell_instructions],
            [trader],
            priority,
            protection_tip,
            mev_protect,
            ltas,
            METEORA_COMPUTE_UNIT_LIMIT
        );
        return [signature, signature];
    }

    public async create_token(
        mint: Keypair,
        creator: Keypair,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        sol_amount: number = 0,
        traders?: [Keypair, number][],
        bundle_tip?: number,
        priority?: PriorityLevel,
        config?: object
    ): Promise<String> {
        trade.validate_create_token_parameters(sol_amount, traders, bundle_tip);
        const config_address = (config as { config?: string } | undefined)?.config;
        if (typeof config_address !== 'string')
            throw new Error('Meteora creation requires a DBC config address in config.config.');
        const config_pubkey = new PublicKey(config_address);
        const account = await global.CONNECTION.getAccountInfo(config_pubkey, COMMITMENT);
        if (!account || !account.owner.equals(METEORA_DBC_PROGRAM_ID))
            throw new Error('Invalid Meteora DBC config account.');
        const config_data = DBCConfigStruct.decode(account.data);
        if (!config_data.quote_mint.equals(SOL_MINT) || config_data.quote_token_flag !== 0)
            throw new Error('Only SOL-quoted DBC configs are supported.');
        if (config_data.token_type !== 0 && config_data.token_type !== 1)
            throw new Error('Unsupported DBC token type.');
        if (config_data.base_fee_mode !== 0 && config_data.base_fee_mode !== 1)
            throw new Error('New DBC pools require a linear or exponential fee scheduler.');
        if (config_data.migration_option !== 1) throw new Error('New DBC pools require DAMM v2 migration.');

        let mint_meta = await this.default_mint_meta(mint.publicKey, 0, {
            name: token_name,
            symbol: token_symbol,
            config: config_address,
            config_data
        });
        const create_instructions = await this.get_create_token_instructions(
            creator,
            token_name,
            token_symbol,
            meta_cid,
            mint,
            mint_meta
        );
        if (sol_amount > 0)
            create_instructions.push(...(await this.get_buy_dbc_instructions(sol_amount, creator, mint_meta, 0.05)));
        const ltas = await trade.get_ltas(this.get_lta_addresses());
        if (!traders)
            return trade.retry_send_tx(
                create_instructions,
                [creator, mint],
                priority,
                undefined,
                false,
                ltas,
                METEORA_COMPUTE_UNIT_LIMIT
            );

        if (sol_amount > 0) mint_meta = this.update_mint_meta_reserves(mint_meta, sol_amount);
        // Only a swap in the pool-creation transaction qualifies for the first-swap discount.
        mint_meta.dbc_data!.creation!.first_swap = false;
        const buy_instructions: TransactionInstruction[][] = [];
        const bundle_signers: Keypair[][] = [];
        const chunk_size = Math.ceil(traders.length / (trade.get_bundle_size() - 1));
        for (const group of common.chunks(traders, chunk_size)) {
            const instructions: TransactionInstruction[] = [];
            for (const [buyer, amount] of group) {
                instructions.push(...(await this.get_buy_dbc_instructions(amount, buyer, mint_meta, 0.05)));
                mint_meta = this.update_mint_meta_reserves(mint_meta, amount);
            }
            buy_instructions.push(instructions);
            bundle_signers.push(group.map(([buyer]) => buyer));
        }
        const generated_lta = await trade.generate_trade_lta(
            creator,
            traders.map(([buyer]) => buyer),
            mint.publicKey
        );
        return trade.retry_send_bundle(
            [create_instructions, ...buy_instructions],
            [[creator, mint], ...bundle_signers],
            bundle_tip!,
            priority,
            [generated_lta, ...ltas],
            METEORA_COMPUTE_UNIT_LIMIT
        );
    }

    private async get_create_token_instructions(
        creator: Keypair,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        mint: Keypair,
        mint_meta: MeteoraMintMeta
    ): Promise<TransactionInstruction[]> {
        const info = mint_meta.dbc_data!;
        const token_2022 = mint_meta.token_program.equals(TOKEN_2022_PROGRAM_ID);
        const metadata = token_2022
            ? undefined
            : (
                  await PublicKey.findProgramAddress(
                      [METAPLEX_META_SEED, METAPLEX_PROGRAM_ID.toBytes(), mint.publicKey.toBytes()],
                      METAPLEX_PROGRAM_ID
                  )
              )[0];
        return [
            new TransactionInstruction({
                programId: METEORA_DBC_PROGRAM_ID,
                data: this.create_data(token_name, token_symbol, `${IPFS}${meta_cid}`, token_2022),
                keys: [
                    { pubkey: new PublicKey(info.config), isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_POOL_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: creator.publicKey, isSigner: true, isWritable: false },
                    { pubkey: mint.publicKey, isSigner: true, isWritable: true },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: new PublicKey(mint_meta.pool), isSigner: false, isWritable: true },
                    { pubkey: new PublicKey(info.base_vault), isSigner: false, isWritable: true },
                    { pubkey: new PublicKey(info.quote_vault), isSigner: false, isWritable: true },
                    ...(metadata
                        ? [
                              { pubkey: metadata, isSigner: false, isWritable: true },
                              { pubkey: METAPLEX_PROGRAM_ID, isSigner: false, isWritable: false }
                          ]
                        : []),
                    { pubkey: creator.publicKey, isSigner: true, isWritable: true },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: mint_meta.token_program, isSigner: false, isWritable: false },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: false }
                ]
            })
        ];
    }

    private create_data(name: string, symbol: string, uri: string, token_2022: boolean): Buffer {
        const string = (value: string, max_length: number) => {
            const length = Buffer.byteLength(value);
            if (length > max_length) throw new Error(`Token metadata exceeds ${max_length} bytes.`);
            const data = Buffer.alloc(4 + length);
            data.writeUInt32LE(length);
            data.write(value, 4);
            return data;
        };
        return Buffer.concat([
            Buffer.from(token_2022 ? METEORA_DBC_CREATE_TOKEN_2022_DISCRIMINATOR : METEORA_DBC_CREATE_DISCRIMINATOR),
            string(name, TOKEN_METADATA_MAX_BYTES.name),
            string(symbol, TOKEN_METADATA_MAX_BYTES.symbol),
            string(uri, TOKEN_METADATA_MAX_BYTES.uri)
        ]);
    }

    public create_token_metadata(meta: common.IPFSMetadata, image_path: string): Promise<string> {
        return common.upload_metadata_ipfs(meta, image_path);
    }

    public async get_random_mints(count: number): Promise<MeteoraMintMeta[]> {
        if (!Number.isSafeInteger(count) || count <= 0) return [];
        const graduated_count = Math.floor((count + 1) * Math.random());
        return (
            await Promise.all([
                this.get_random_graduated_mints(graduated_count),
                this.get_random_ungraduated_mints(count - graduated_count)
            ])
        ).flat();
    }

    private async get_random_ungraduated_mints(count: number): Promise<MeteoraMintMeta[]> {
        if (count <= 0) return [];
        const limit = Math.min(100, Math.max(20, count * 3));
        try {
            const pools = await trade.get_program_accounts_v2(
                METEORA_DBC_PROGRAM_ID,
                [
                    { memcmp: { offset: 0, bytes: base58.encode(METEORA_DBC_STATE_HEADER) } },
                    {
                        memcmp: {
                            offset: DBCStateStruct.get_offset('is_migrated'),
                            bytes: base58.encode(Buffer.from([0]))
                        }
                    }
                ],
                { offset: DBCStateStruct.get_offset('base_mint'), length: 32 },
                limit
            );
            return trade.resolve_random_mints(
                pools.map((pool) => new PublicKey(pool.account.data).toBase58()),
                count,
                async (mint) => {
                    const meta = await this.get_mint_meta(mint);
                    return meta && !meta.migrated && meta.sol_reserves > 0n && meta.token_reserves > 0n
                        ? meta
                        : undefined;
                }
            );
        } catch (error) {
            common.error(common.red(`Failed fetching DBC mints: ${error}`));
            return [];
        }
    }

    private async get_random_graduated_mints(count: number): Promise<MeteoraMintMeta[]> {
        if (count <= 0) return [];
        const limit = Math.min(100, Math.max(20, count * 3));
        const sol = SOL_MINT.toBase58();
        const sources = await Promise.allSettled(
            ['token_x', 'token_y'].map(async (field) => {
                const url = new URL(`${METEORA_DAMM_V2_API_URL}/pools`);
                url.searchParams.set('page_size', String(limit));
                url.searchParams.set('filter_by', `${field}=${sol}&&tvl>0`);
                const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
                const data = await response.json();
                if (!response.ok || !Array.isArray(data.data)) throw new Error('DAMM v2 mint discovery failed.');
                return data.data.flatMap((pool: { token_x: { address: string }; token_y: { address: string } }) =>
                    pool.token_x.address === sol
                        ? [pool.token_y.address]
                        : pool.token_y.address === sol
                          ? [pool.token_x.address]
                          : []
                ) as string[];
            })
        );
        const candidates: string[] = [];
        for (const source of sources) {
            if (source.status === 'fulfilled') candidates.push(...source.value);
            else common.error(common.red(`Failed fetching Meteora mints: ${source.reason}`));
        }
        return trade.resolve_random_mints(candidates, count, async (mint) => {
            const meta = await this.get_mint_meta(mint);
            return meta && meta.migrated && meta.sol_reserves > 0n && meta.token_reserves > 0n ? meta : undefined;
        });
    }

    public async get_mint_meta(mint: PublicKey, sol_price?: number): Promise<MeteoraMintMeta | undefined> {
        try {
            let mint_meta = await this.default_mint_meta(mint, sol_price);
            mint_meta = await this.update_mint_meta(mint_meta, sol_price);
            return mint_meta;
        } catch (error) {
            console.error(`Error fetching mint meta: ${error}`);
            return undefined;
        }
    }

    public async subscribe_mint_meta(
        mint_meta: MeteoraMintMeta,
        callback: (mint_meta: MeteoraMintMeta) => void,
        sol_price: number = 0,
        commitment: Commitment = COMMITMENT
    ): Promise<() => void> {
        let dbc_sub: number | undefined;
        let damm_sub: number | undefined;
        let stopped = false;
        let current_mint_meta = mint_meta;
        let latest_slot = 0n;
        let damm_started = false;

        const publish = (update: MeteoraMintMeta, slot: bigint = 0n) => {
            if (stopped || (slot && slot < latest_slot)) return;
            if (slot) latest_slot = slot;
            current_mint_meta = update;
            callback(update);
        };
        const unsubscribe = (id: number | undefined) => {
            if (id !== undefined) global.CONNECTION.removeAccountChangeListener(id).catch(() => {});
        };
        const subscribe_damm = (pool: trade.ProgramAccount, slot: bigint = 0n) => {
            if (damm_started) return;
            damm_started = true;
            publish(this.damm_v2_mint_meta(current_mint_meta, pool, sol_price), slot);
            damm_sub = global.CONNECTION.onAccountChange(
                pool.pubkey,
                (account, context) => {
                    if (stopped) return;
                    publish(
                        this.damm_v2_mint_meta(current_mint_meta, { pubkey: pool.pubkey, account }, sol_price),
                        context.slot
                    );
                },
                { commitment }
            );
        };
        const mint = new PublicKey(mint_meta.mint);
        const damm = await this.get_damm_from_mint(mint);
        if (damm) {
            subscribe_damm(damm);
        } else {
            const dbc_pool = new PublicKey(mint_meta.pool);
            const process_dbc = async (account: AccountInfo<Uint8Array>, slot: bigint = 0n) => {
                if (stopped || (slot && slot < latest_slot)) return;
                const state = DBCStateStruct.decode(account.data);
                const metrics = this.get_dbc_token_metrics({
                    pool: dbc_pool,
                    base_mint: mint,
                    config: state.config,
                    quote_mint: SOL_MINT,
                    token_decimals: current_mint_meta.token_decimal,
                    total_supply: current_mint_meta.total_supply,
                    base_vault: state.base_vault,
                    quote_vault: state.quote_vault,
                    base_reserve: state.base_reserve,
                    quote_reserve: state.quote_reserve,
                    sqrt_price: common.read_biguint_le(state.sqrt_price, 0, 16),
                    is_migrated: state.is_migrated === 1,
                    creator: new PublicKey(Buffer.alloc(32))
                });
                publish(
                    new MeteoraMintMeta({
                        ...current_mint_meta,
                        pool: dbc_pool.toBase58(),
                        sol_reserves: state.quote_reserve,
                        token_reserves: state.base_reserve,
                        dbc_data: {
                            sqrt_price: common.read_biguint_le(state.sqrt_price, 0, 16),
                            base_vault: state.base_vault.toBase58(),
                            quote_vault: state.quote_vault.toBase58(),
                            config: state.config.toBase58()
                        },
                        complete: false,
                        market_cap: metrics.mcap_sol,
                        usd_market_cap: metrics.mcap_sol * sol_price
                    }),
                    slot
                );
                if (state.is_migrated !== 1 || damm_started) return;
                const migrated = await this.get_damm_from_mint(mint);
                if (!migrated || (slot && slot < latest_slot)) return;
                unsubscribe(dbc_sub);
                dbc_sub = undefined;
                subscribe_damm(migrated, slot);
            };

            dbc_sub = global.CONNECTION.onAccountChange(
                dbc_pool,
                (account, context) => void process_dbc(account, context.slot),
                { commitment }
            );
            const response = await global.CONNECTION.getAccountInfoAndContext(dbc_pool, commitment);
            if (response.value) await process_dbc(response.value, response.context.slot);
        }
        return () => {
            stopped = true;
            unsubscribe(dbc_sub);
            unsubscribe(damm_sub);
        };
    }

    public async update_mint_meta(mint_meta: MeteoraMintMeta, sol_price: number = 0): Promise<MeteoraMintMeta> {
        try {
            const mint = new PublicKey(mint_meta.mint);
            const dbc_pool = await this.get_dbc_pool_from_mint(mint);
            if (dbc_pool) {
                const state = await this.get_dbc_state(mint);
                if (!state.is_migrated) {
                    const metrics = this.get_dbc_token_metrics(state);
                    return new MeteoraMintMeta({
                        ...mint_meta,
                        dbc_data: {
                            sqrt_price: state.sqrt_price,
                            base_vault: state.base_vault.toString(),
                            quote_vault: state.quote_vault.toString(),
                            config: state.config.toString()
                        },
                        damm_v2_data: undefined,
                        sol_reserves: state.quote_reserve,
                        token_reserves: state.base_reserve,
                        total_supply: state.total_supply,
                        token_decimal: state.token_decimals,
                        pool: state.pool.toString(),
                        complete: false,
                        usd_market_cap: metrics.mcap_sol * sol_price,
                        market_cap: metrics.mcap_sol
                    });
                }
            }

            const damm = await this.get_damm_from_mint(mint);
            if (damm) return this.damm_v2_mint_meta(mint_meta, damm, sol_price);

            if (dbc_pool) {
                const state = await this.get_dbc_state(mint);
                const metrics = this.get_dbc_token_metrics(state);
                return new MeteoraMintMeta({
                    ...mint_meta,
                    dbc_data: {
                        sqrt_price: state.sqrt_price,
                        base_vault: state.base_vault.toString(),
                        quote_vault: state.quote_vault.toString(),
                        config: state.config.toString()
                    },
                    sol_reserves: state.quote_reserve,
                    token_reserves: state.base_reserve,
                    total_supply: state.total_supply,
                    token_decimal: state.token_decimals,
                    pool: state.pool.toString(),
                    complete: state.is_migrated,
                    usd_market_cap: metrics.mcap_sol * sol_price,
                    market_cap: metrics.mcap_sol
                });
            }

            throw new Error('Meteora DBC or DAMM v2 pool not found.');
        } catch (error) {
            throw new Error(`Failed to update mint meta reserves: ${error}`);
        }
    }

    public update_mint_meta_reserves(mint_meta: MeteoraMintMeta, amount: number | TokenAmount): MeteoraMintMeta {
        const info = mint_meta.dbc_data;
        if (!info?.creation || typeof amount !== 'number') return mint_meta;
        const quote = this.calc_dbc_creation_buy_quote(common.sol_to_lamports(amount), info);
        const creation = info.creation;
        const config = creation.config;
        if (config.dynamic_fee_initialized) {
            const delta_bins = (a: bigint, b: bigint) => {
                const upper = a > b ? a : b;
                const lower = a > b ? b : a;
                return (((upper * ONE_Q64) / lower - ONE_Q64) / METEORA_DBC_PARAMS.bin_step_u128) * 2n;
            };
            // Creation and its bundle execute in one slot, so only the initial reference reset applies.
            if (!creation.has_swap_timestamp || config.filter_period === 0)
                creation.sqrt_price_reference = info.sqrt_price;
            const reference =
                creation.has_swap_timestamp && config.filter_period === 0 && config.decay_period > 0
                    ? (creation.volatility_accumulator * BigInt(config.dynamic_reduction_factor)) / BASIS_POINT_MAX
                    : 0n;
            const volatility =
                reference + delta_bins(quote.sqrt_price, creation.sqrt_price_reference) * BASIS_POINT_MAX;
            creation.volatility_accumulator =
                volatility < BigInt(config.max_volatility_accumulator)
                    ? volatility
                    : BigInt(config.max_volatility_accumulator);
            if (delta_bins(quote.sqrt_price, info.sqrt_price) > 0n) creation.has_swap_timestamp = true;
        }
        info.sqrt_price = quote.sqrt_price;
        creation.first_swap = false;
        mint_meta.sol_reserves += quote.quote_amount;
        mint_meta.token_reserves -= quote.base_amount;
        mint_meta.complete = mint_meta.sol_reserves >= config.migration_quote_threshold;
        return mint_meta;
    }

    public async default_mint_meta(mint: PublicKey, sol_price: number = 0, data?: object): Promise<MeteoraMintMeta> {
        const decoded = data as Record<string, unknown> | undefined;
        const config_data = decoded?.config_data as ReturnType<typeof DBCConfigStruct.decode> | undefined;
        if (config_data && typeof decoded?.config === 'string') {
            const config = new PublicKey(decoded.config);
            const mints = [Buffer.from(mint.toBytes()), Buffer.from(SOL_MINT.toBytes())].sort(Buffer.compare).reverse();
            const [pool] = await PublicKey.findProgramAddress(
                [METEORA_DBC_POOL_SEED, config.toBytes(), ...mints],
                METEORA_DBC_PROGRAM_ID
            );
            const [[base_vault], [quote_vault]] = await Promise.all(
                [mint, SOL_MINT].map((token) =>
                    PublicKey.findProgramAddress(
                        [METEORA_DBC_VAULT_SEED, token.toBytes(), pool.toBytes()],
                        METEORA_DBC_PROGRAM_ID
                    )
                )
            );
            const curve = config_data.curve;
            if (curve.length === 0 || config_data.sqrt_start_price === 0n)
                throw new Error('Invalid DBC creation curve.');
            let supply = config_data.pre_migration_token_supply;
            if (config_data.fixed_token_supply_flag === 0) {
                let curve_amount = 0n;
                let sqrt_price = config_data.sqrt_start_price;
                for (const point of curve) {
                    const denominator = sqrt_price * point.sqrt_price;
                    curve_amount +=
                        (point.liquidity * (point.sqrt_price - sqrt_price) + denominator - 1n) / denominator;
                    sqrt_price = point.sqrt_price;
                }
                const buffered_amount =
                    config_data.swap_base_amount +
                    (config_data.swap_base_amount * METEORA_DBC_PARAMS.swap_buffer_percentage) / 100n;
                supply =
                    (buffered_amount < curve_amount ? buffered_amount : curve_amount) +
                    config_data.migration_base_threshold +
                    config_data.vesting_amount_per_period * config_data.vesting_number_of_periods +
                    config_data.vesting_cliff_unlock_amount;
            }
            const market_cap =
                (this.calc_token_price(config_data.sqrt_start_price) * Number(supply)) / LAMPORTS_PER_SOL;
            return new MeteoraMintMeta({
                mint: mint.toBase58(),
                pool: pool.toBase58(),
                name: typeof decoded.name === 'string' ? decoded.name : 'Unknown',
                symbol: typeof decoded.symbol === 'string' ? decoded.symbol : 'Unknown',
                total_supply: supply,
                token_reserves: supply,
                sol_reserves: 0n,
                token_decimal: config_data.token_decimal,
                token_program_id: (config_data.token_type === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID).toBase58(),
                market_cap,
                usd_market_cap: market_cap * sol_price,
                fee: Number(config_data.cliff_fee_numerator) / Number(FEE_DENOMINATOR),
                dbc_data: {
                    config: config.toBase58(),
                    base_vault: base_vault.toBase58(),
                    quote_vault: quote_vault.toBase58(),
                    sqrt_price: config_data.sqrt_start_price,
                    creation: {
                        config: config_data,
                        first_swap: true,
                        volatility_accumulator: 0n,
                        sqrt_price_reference: config_data.sqrt_start_price,
                        has_swap_timestamp: false
                    }
                }
            });
        }
        const meta = decoded
            ? {
                  token_name: typeof decoded.name === 'string' ? decoded.name : 'Unknown',
                  token_symbol: typeof decoded.symbol === 'string' ? decoded.symbol : 'Unknown',
                  token_supply: 10 ** 18,
                  token_decimal: 9,
                  token_program: TOKEN_PROGRAM_ID
              }
            : await trade.get_token_meta(mint).catch(() => {
                  return {
                      token_name: 'Unknown',
                      token_symbol: 'Unknown',
                      token_supply: 10 ** 18,
                      token_decimal: 9,
                      token_program: TOKEN_PROGRAM_ID
                  };
              });

        return new MeteoraMintMeta({
            mint: mint.toString(),
            pool: typeof decoded?.pool === 'string' ? decoded.pool : undefined,
            symbol: meta.token_symbol,
            name: meta.token_name,
            complete: false,
            market_cap: 135,
            usd_market_cap: 135 * sol_price,
            sol_reserves: 0n,
            token_reserves: 1000000000000000000n,
            total_supply: BigInt(meta.token_supply),
            token_decimal: meta.token_decimal,
            token_program_id: meta.token_program.toString()
        });
    }

    private get_dbc_token_metrics(state: DBCState): trade.TokenMetrics {
        const price_sol = this.calc_token_price(state.sqrt_price);
        const mcap_sol = (price_sol * Number(state.total_supply)) / LAMPORTS_PER_SOL;
        return { price_sol, mcap_sol };
    }

    private calc_token_price(sqrt_price: bigint): number {
        const PRECISION = 10n ** 18n;

        const numerator = sqrt_price * sqrt_price * PRECISION;
        return Number(numerator / ONE_Q128) / 1e18;
    }

    private async get_dbc_state(mint: PublicKey): Promise<DBCState> {
        const pool = await this.get_dbc_pool_from_mint(mint);
        if (!pool) throw new Error('Pool not found');
        const pool_state = DBCStateStruct.decode(pool.account.data);
        const config_info = await global.CONNECTION.getAccountInfo(pool_state.config, COMMITMENT);
        if (!config_info) throw new Error('Unexpected config state');
        const config_state = DBCConfigStruct.decode(config_info.data);
        if (!config_state.quote_mint.equals(SOL_MINT)) throw new Error('Only SOL-quoted DBC pools are supported.');

        return {
            pool: pool.pubkey,
            base_mint: mint,
            quote_mint: config_state.quote_mint,
            config: pool_state.config,
            token_decimals: config_state.token_decimal,
            total_supply: config_state.pre_migration_token_supply,
            base_vault: pool_state.base_vault,
            quote_vault: pool_state.quote_vault,
            base_reserve: pool_state.base_reserve,
            quote_reserve: pool_state.quote_reserve,
            sqrt_price: common.read_biguint_le(pool_state.sqrt_price, 0, 16),
            is_migrated: pool_state.is_migrated === 1,
            creator: pool_state.creator
        };
    }

    private async get_dbc_pool_from_mint(mint: PublicKey): Promise<trade.ProgramAccount | null> {
        try {
            const [pool] = await trade.get_program_accounts_v2(METEORA_DBC_PROGRAM_ID, [
                { memcmp: { offset: DBCStateStruct.get_offset('base_mint'), bytes: mint.toBase58() } },
                { memcmp: { offset: 0, bytes: base58.encode(METEORA_DBC_STATE_HEADER) } }
            ]);
            return pool;
        } catch (error) {
            return null;
        }
    }

    private calc_slippage_up(sol_amount: bigint, slippage: number): bigint {
        trade.validate_slippage(slippage);
        return sol_amount + (sol_amount * BigInt(Math.floor(slippage * Number(BASIS_POINT_MAX)))) / BASIS_POINT_MAX;
    }

    private calc_slippage_down(sol_amount: bigint, slippage: number): bigint {
        trade.validate_slippage(slippage);
        return sol_amount - (sol_amount * BigInt(Math.floor(slippage * Number(BASIS_POINT_MAX)))) / BASIS_POINT_MAX;
    }

    private calc_dbc_token_amount_raw(sol_amount_raw: bigint, info: DBCData): bigint {
        if (sol_amount_raw <= 0) return 0n;
        if (info.creation) return this.calc_dbc_creation_buy_quote(sol_amount_raw, info).output_amount;

        const price = info.sqrt_price * info.sqrt_price;
        return (sol_amount_raw * ONE_Q128) / price;
    }

    private calc_dbc_creation_buy_quote(
        sol_amount: bigint,
        info: DBCData
    ): {
        output_amount: bigint;
        base_amount: bigint;
        quote_amount: bigint;
        sqrt_price: bigint;
    } {
        const creation = info.creation!;
        const config = creation.config;
        let fee_numerator = config.cliff_fee_numerator;
        if (creation.first_swap && config.enable_first_swap_with_min_fee) {
            const periods = BigInt(config.number_of_periods);
            fee_numerator =
                config.base_fee_mode === 0
                    ? fee_numerator - periods * config.reduction_factor
                    : (fee_numerator *
                          pow_q64(ONE_Q64 - (config.reduction_factor * ONE_Q64) / BASIS_POINT_MAX, periods)) /
                      ONE_Q64;
        } else if (config.dynamic_fee_initialized) {
            const volatility = creation.volatility_accumulator * METEORA_DBC_PARAMS.bin_step;
            fee_numerator +=
                (volatility * volatility * BigInt(config.variable_fee_control) + DYNAMIC_FEE_ROUNDING_OFFSET) /
                DYNAMIC_FEE_SCALING_FACTOR;
        }
        if (fee_numerator > METEORA_DBC_PARAMS.max_fee_numerator) fee_numerator = METEORA_DBC_PARAMS.max_fee_numerator;
        const fee = (amount: bigint) => (amount * fee_numerator + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR;
        const quote_amount = config.collect_fee_mode === 0 ? sol_amount - fee(sol_amount) : sol_amount;
        let remaining = quote_amount;
        let sqrt_price = info.sqrt_price;
        let base_amount = 0n;
        for (const point of config.curve) {
            const target =
                point.sqrt_price < config.migration_sqrt_price ? point.sqrt_price : config.migration_sqrt_price;
            if (target <= sqrt_price) continue;
            const max_input = (point.liquidity * (target - sqrt_price) + ONE_Q128 - 1n) / ONE_Q128;
            const input = remaining < max_input ? remaining : max_input;
            const next = remaining < max_input ? sqrt_price + (input * ONE_Q128) / point.liquidity : target;
            base_amount += (point.liquidity * (next - sqrt_price)) / (sqrt_price * next);
            sqrt_price = next;
            remaining -= input;
            if (remaining === 0n || sqrt_price === config.migration_sqrt_price) break;
        }
        if (remaining > 0n) throw new Error('Initial buy exceeds the remaining DBC curve liquidity.');
        const output_amount = config.collect_fee_mode === 0 ? base_amount : base_amount - fee(base_amount);
        if (output_amount <= 0n) throw new Error('Initial buy produces no tokens.');
        return { output_amount, base_amount, quote_amount, sqrt_price };
    }

    private calc_dbc_sol_amount_raw(token_amount_raw: bigint, info: DBCData): bigint {
        if (token_amount_raw <= 0) return 0n;

        const price = info.sqrt_price * info.sqrt_price;
        return (token_amount_raw * price) / ONE_Q128;
    }

    private async get_damm_from_mint(mint: PublicKey): Promise<trade.ProgramAccount | null> {
        try {
            const pools = await Promise.all(
                ['token_a_mint', 'token_b_mint'].map((field) =>
                    trade.get_program_accounts_v2(METEORA_DAMM_V2_PROGRAM_ID, [
                        { memcmp: { offset: DAMMV2StateStruct.get_offset(field), bytes: mint.toBase58() } },
                        { memcmp: { offset: 0, bytes: base58.encode(METEORA_DAMM_V2_STATE_HEADER) } }
                    ])
                )
            );
            return (
                pools.flat().find((pool) => {
                    const state = DAMMV2StateStruct.decode(pool.account.data);
                    return state.token_a_mint.equals(SOL_MINT) || state.token_b_mint.equals(SOL_MINT);
                }) ?? null
            );
        } catch {
            return null;
        }
    }

    private damm_v2_mint_meta(
        mint_meta: MeteoraMintMeta,
        pool: trade.ProgramAccount,
        sol_price: number
    ): MeteoraMintMeta {
        const state = DAMMV2StateStruct.decode(pool.account.data);
        this.validate_damm_v2_state(state);
        const mint_is_token_a = state.token_a_mint.equals(mint_meta.mint_pubkey);
        const sol_mint = mint_is_token_a ? state.token_b_mint : state.token_a_mint;
        if (!sol_mint.equals(SOL_MINT)) throw new Error('DAMM v2 pool does not pair the token with SOL.');
        const token_reserves = mint_is_token_a ? state.token_a_amount : state.token_b_amount;
        const sol_reserves = mint_is_token_a ? state.token_b_amount : state.token_a_amount;
        const price_sol = Number(sol_reserves) / Number(token_reserves);
        const market_cap = (price_sol * Number(mint_meta.total_supply)) / LAMPORTS_PER_SOL;

        return new MeteoraMintMeta({
            ...mint_meta,
            pool: pool.pubkey.toBase58(),
            complete: true,
            sol_reserves,
            token_reserves,
            market_cap,
            usd_market_cap: market_cap * sol_price,
            damm_v2_data: {
                token_a_mint: state.token_a_mint.toBase58(),
                token_b_mint: state.token_b_mint.toBase58(),
                token_a_vault: state.token_a_vault.toBase58(),
                token_b_vault: state.token_b_vault.toBase58(),
                token_a_amount: state.token_a_amount,
                token_b_amount: state.token_b_amount,
                fee_numerator: state.base_fee_data.readBigUInt64LE(0)
            }
        });
    }

    private validate_damm_v2_state(state: ReturnType<typeof DAMMV2StateStruct.decode>): void {
        if (state.pool_status !== 0) throw new Error('DAMM v2 pool is disabled.');
        if (state.layout_version !== 1) throw new Error('DAMM v2 pool layout version is not supported.');
        if (state.collect_fee_mode > 2) throw new Error('Unsupported DAMM v2 fee collection mode.');
        if (state.fee_version > 1) throw new Error('Unsupported DAMM v2 fee version.');
    }

    private async get_token_program(mint: PublicKey): Promise<PublicKey> {
        if (mint.equals(SOL_MINT)) return TOKEN_PROGRAM_ID;
        const mint_info = await global.CONNECTION.getAccountInfo(mint, COMMITMENT);
        if (!mint_info || (!mint_info.owner.equals(TOKEN_PROGRAM_ID) && !mint_info.owner.equals(TOKEN_2022_PROGRAM_ID)))
            throw new Error(`Unsupported token program for mint ${mint}.`);
        if (mint_info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
            const { extensions } = decode_mint_account(mint_info);
            if (
                extensions.__option === 'Some' &&
                extensions.value.some((extension) => extension.__kind === 'TransferHook')
            )
                throw new Error('Meteora transfer-hook tokens are not supported.');
        }
        return mint_info.owner;
    }

    private async quote_damm_v2_exact_in(
        amount_in: bigint,
        input_is_token_a: boolean,
        state: ReturnType<typeof DAMMV2StateStruct.decode>,
        slot: bigint
    ) {
        this.validate_damm_v2_state(state);
        const current_point =
            state.activation_type === 0 ? BigInt(slot) : BigInt((await global.CONNECTION.getBlockTime(slot)) ?? 0);
        if (current_point < state.activation_point) throw new Error('DAMM v2 pool is not active.');
        return quote_exact_in(
            state,
            amount_in,
            input_is_token_a ? TradeDirection.AtoB : TradeDirection.BtoA,
            current_point
        );
    }

    private async get_damm_v2_transfer_fee(
        mint: PublicKey,
        program: PublicKey,
        amount: bigint,
        epoch: bigint
    ): Promise<bigint> {
        if (!program.equals(TOKEN_2022_PROGRAM_ID) || amount === 0n) return 0n;
        const { extensions } = await getMint(global.CONNECTION, mint, COMMITMENT, program);
        const transfer_fee_config =
            extensions.__option === 'Some'
                ? extensions.value.find((extension) => extension.__kind === 'TransferFeeConfig')
                : undefined;
        if (!transfer_fee_config) return 0n;
        const fee =
            epoch >= transfer_fee_config.newerTransferFee.epoch
                ? transfer_fee_config.newerTransferFee
                : transfer_fee_config.olderTransferFee;
        const calculated = (amount * BigInt(fee.transferFeeBasisPoints) + 9999n) / 10000n;
        return calculated > fee.maximumFee ? fee.maximumFee : calculated;
    }

    private damm_v2_swap_data(amount_in: bigint, minimum_amount_out: bigint): Buffer {
        const data = Buffer.alloc(25);
        Buffer.from([65, 75, 63, 76, 235, 91, 91, 136]).copy(data);
        data.writeBigUInt64LE(amount_in, 8);
        data.writeBigUInt64LE(minimum_amount_out, 16);
        data.writeUInt8(0, 24);
        return data;
    }

    private swap_data(amount_in: bigint, minimum_amount_out: bigint): Buffer {
        const instruction_buf = Buffer.from(METEORA_SWAP_DISCRIMINATOR);
        const sol_amount_buf = Buffer.alloc(8);
        sol_amount_buf.writeBigUInt64LE(amount_in, 0);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(minimum_amount_out, 0);
        return Buffer.concat([instruction_buf, sol_amount_buf, token_amount_buf]);
    }

    private async get_buy_dbc_instructions(
        sol_amount: number,
        buyer: Keypair,
        mint_meta: Partial<MeteoraMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (!mint_meta.mint || !mint_meta.dbc_data || !mint_meta.pool)
            throw new Error(`Incomplete mint meta data for buy instructions.`);

        const mint = new PublicKey(mint_meta.mint);
        const pool = new PublicKey(mint_meta.pool);
        const config = new PublicKey(mint_meta.dbc_data.config);
        const base_vault = new PublicKey(mint_meta.dbc_data.base_vault);
        const quote_vault = new PublicKey(mint_meta.dbc_data.quote_vault);

        const sol_amount_raw = common.sol_to_lamports(sol_amount);
        if (
            mint_meta.dbc_data.creation &&
            (mint_meta.complete ||
                (mint_meta.sol_reserves ?? 0n) >= mint_meta.dbc_data.creation.config.migration_quote_threshold)
        )
            throw new Error('Initial buys have completed the DBC curve.');
        const token_amount_raw = this.calc_slippage_down(
            this.calc_dbc_token_amount_raw(sol_amount_raw, mint_meta.dbc_data),
            slippage
        );

        const instruction_data = this.swap_data(sol_amount_raw, token_amount_raw);
        const token_program = mint_meta.dbc_data.creation
            ? new PublicKey(mint_meta.token_program_id!)
            : await this.get_token_program(mint);
        const token_ata = await trade.calc_ata(buyer.publicKey, mint, token_program);
        const wsol_ata = await trade.calc_ata(buyer.publicKey, SOL_MINT);

        return [
            createAssociatedTokenAccountIdempotentInstruction(buyer, token_ata, buyer.publicKey, mint, token_program),
            createAssociatedTokenAccountIdempotentInstruction(buyer, wsol_ata, buyer.publicKey, SOL_MINT),
            SystemProgram.transfer({
                fromPubkey: buyer.publicKey,
                toPubkey: wsol_ata,
                lamports: this.calc_slippage_up(sol_amount_raw, slippage)
            }),
            createSyncNativeInstruction(wsol_ata),
            new TransactionInstruction({
                keys: [
                    { pubkey: METEORA_DBC_POOL_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: config, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: buyer.publicKey, isSigner: true, isWritable: false },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: true },
                    { pubkey: METEORA_DBC_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: false },
                    ...(mint_meta.dbc_data.creation
                        ? [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }]
                        : [])
                ],
                programId: METEORA_DBC_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, buyer.publicKey, buyer.publicKey)
        ];
    }

    private async get_sell_dbc_instructions(
        token_amount: TokenAmount,
        seller: Keypair,
        mint_meta: Partial<MeteoraMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (!mint_meta.mint || !mint_meta.dbc_data || !mint_meta.pool)
            throw new Error(`Incomplete mint meta data for sell instructions.`);
        if (token_amount.amount === null) throw new Error(`Invalid token amount: ${token_amount.amount}`);

        const mint = new PublicKey(mint_meta.mint);
        const pool = new PublicKey(mint_meta.pool);
        const config = new PublicKey(mint_meta.dbc_data.config);
        const base_vault = new PublicKey(mint_meta.dbc_data.base_vault);
        const quote_vault = new PublicKey(mint_meta.dbc_data.quote_vault);

        const token_amount_raw = BigInt(token_amount.amount);
        const sol_amount_raw = this.calc_slippage_down(
            this.calc_dbc_sol_amount_raw(token_amount_raw, mint_meta.dbc_data),
            slippage
        );

        const instruction_data = this.swap_data(token_amount_raw, sol_amount_raw);
        const token_program = await this.get_token_program(mint);
        const token_ata = await trade.calc_ata(seller.publicKey, mint, token_program);
        const wsol_ata = await trade.calc_ata(seller.publicKey, SOL_MINT);

        return [
            createAssociatedTokenAccountIdempotentInstruction(seller, wsol_ata, seller.publicKey, SOL_MINT),
            new TransactionInstruction({
                keys: [
                    { pubkey: METEORA_DBC_POOL_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: config, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: seller.publicKey, isSigner: true, isWritable: false },
                    { pubkey: token_program, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: true },
                    { pubkey: METEORA_DBC_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DBC_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: METEORA_DBC_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, seller.publicKey, seller.publicKey)
        ];
    }

    private async get_buy_damm_v2_instructions(
        sol_amount: number,
        buyer: Keypair,
        mint_meta: MeteoraMintMeta,
        slippage: number
    ): Promise<TransactionInstruction[]> {
        const result = await this.get_damm_v2_swap_instructions(
            common.sol_to_lamports(sol_amount),
            buyer,
            mint_meta,
            true,
            slippage
        );
        return result.instructions;
    }

    private async get_sell_damm_v2_instructions(
        token_amount: TokenAmount,
        seller: Keypair,
        mint_meta: MeteoraMintMeta,
        slippage: number
    ): Promise<TransactionInstruction[]> {
        if (token_amount.amount === null) throw new Error(`Invalid token amount: ${token_amount.amount}`);
        return (
            await this.get_damm_v2_swap_instructions(BigInt(token_amount.amount), seller, mint_meta, false, slippage)
        ).instructions;
    }

    private async get_damm_v2_swap_instructions(
        amount_in: bigint,
        trader: Keypair,
        mint_meta: MeteoraMintMeta,
        buy: boolean,
        slippage: number
    ): Promise<{ instructions: TransactionInstruction[]; output_amount: bigint }> {
        if (!mint_meta.pool || !mint_meta.damm_v2_data) throw new Error('Incomplete DAMM v2 pool data.');
        if (amount_in <= 0n) throw new RangeError('DAMM v2 swap amount must be positive.');

        const pool = new PublicKey(mint_meta.pool);
        const pool_response = await global.CONNECTION.getAccountInfoAndContext(pool, COMMITMENT);
        if (!pool_response.value) throw new Error('DAMM v2 pool not found.');
        const state = DAMMV2StateStruct.decode(pool_response.value.data);
        const input_mint = buy ? SOL_MINT : mint_meta.mint_pubkey;
        const output_mint = buy ? mint_meta.mint_pubkey : SOL_MINT;
        const input_program = await this.get_token_program(input_mint);
        const output_program = await this.get_token_program(output_mint);
        if (!state.token_a_mint.equals(input_mint) && !state.token_b_mint.equals(input_mint))
            throw new Error('DAMM v2 pool does not contain the input mint.');
        if (!state.token_a_mint.equals(output_mint) && !state.token_b_mint.equals(output_mint))
            throw new Error('DAMM v2 pool does not contain the output mint.');
        const input_is_token_a = state.token_a_mint.equals(input_mint);
        const input_ata = await trade.calc_ata(trader.publicKey, input_mint, input_program);
        const output_ata = await trade.calc_ata(trader.publicKey, output_mint, output_program);
        const epoch =
            input_program.equals(TOKEN_2022_PROGRAM_ID) || output_program.equals(TOKEN_2022_PROGRAM_ID)
                ? (await global.CONNECTION.getEpochInfo(COMMITMENT)).epoch
                : 0n;
        const actual_amount_in =
            amount_in - (await this.get_damm_v2_transfer_fee(input_mint, input_program, amount_in, epoch));
        const quote = await this.quote_damm_v2_exact_in(
            actual_amount_in,
            input_is_token_a,
            state,
            pool_response.context.slot
        );
        const output_amount =
            quote.output_amount -
            (await this.get_damm_v2_transfer_fee(output_mint, output_program, quote.output_amount, epoch));
        const minimum_amount_out = this.calc_slippage_down(output_amount, slippage);
        const [pool_authority] = await PublicKey.findProgramAddress(
            [Buffer.from('pool_authority')],
            METEORA_DAMM_V2_PROGRAM_ID
        );
        const [event_authority] = await PublicKey.findProgramAddress(
            [Buffer.from('__event_authority')],
            METEORA_DAMM_V2_PROGRAM_ID
        );
        const instructions: TransactionInstruction[] = [
            createAssociatedTokenAccountIdempotentInstruction(
                trader,
                output_ata,
                trader.publicKey,
                output_mint,
                output_program
            ),
            createAssociatedTokenAccountIdempotentInstruction(
                trader,
                input_ata,
                trader.publicKey,
                input_mint,
                input_program
            )
        ];
        if (buy) {
            instructions.push(
                SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: input_ata, lamports: amount_in }),
                createSyncNativeInstruction(input_ata)
            );
        }
        instructions.push(
            new TransactionInstruction({
                keys: [
                    { pubkey: pool_authority, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: input_ata, isSigner: false, isWritable: true },
                    { pubkey: output_ata, isSigner: false, isWritable: true },
                    { pubkey: state.token_a_vault, isSigner: false, isWritable: true },
                    { pubkey: state.token_b_vault, isSigner: false, isWritable: true },
                    { pubkey: state.token_a_mint, isSigner: false, isWritable: false },
                    { pubkey: state.token_b_mint, isSigner: false, isWritable: false },
                    { pubkey: trader.publicKey, isSigner: true, isWritable: false },
                    {
                        pubkey: state.token_a_mint.equals(input_mint) ? input_program : output_program,
                        isSigner: false,
                        isWritable: false
                    },
                    {
                        pubkey: state.token_b_mint.equals(input_mint) ? input_program : output_program,
                        isSigner: false,
                        isWritable: false
                    },
                    { pubkey: METEORA_DAMM_V2_PROGRAM_ID, isSigner: false, isWritable: true },
                    { pubkey: event_authority, isSigner: false, isWritable: false },
                    { pubkey: METEORA_DAMM_V2_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: METEORA_DAMM_V2_PROGRAM_ID,
                data: this.damm_v2_swap_data(amount_in, minimum_amount_out)
            }),
            createCloseAccountInstruction(buy ? input_ata : output_ata, trader.publicKey, trader.publicKey)
        );
        return { instructions, output_amount };
    }
}
