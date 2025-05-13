import {
    AddressLookupTableAccount,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    Signer,
    SystemProgram,
    TokenAmount,
    TransactionInstruction
} from '@solana/web3.js';
import * as common from '../common/common.js';
import * as trade from '../common/trade_common.js';
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    createSyncNativeInstruction,
    TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import {
    COMMITMENT,
    IPFS,
    METAPLEX_PROGRAM_ID,
    PUMP_AMM_EVENT_AUTHORITY_ACCOUNT,
    PUMP_AMM_FEE_ACCOUNT,
    PUMP_AMM_GLOBAL_ACCOUNT,
    PUMP_AMM_PROGRAM_ID,
    PUMP_BONDING_SEED,
    PUMP_STATE_HEADER,
    PUMP_CURVE_TOKEN_DECIMALS,
    PUMP_EVENT_AUTHORITUY_ACCOUNT,
    PUMP_FEE_PERCENTAGE,
    PUMP_FEE_ACCOUNT,
    PUMP_FETCH_API_URL,
    PUMP_GLOBAL_ACCOUNT,
    PUMP_META_SEED,
    PUMP_MINT_AUTHORITY_ACCOUNT,
    PUMP_PROGRAM_ID,
    SOL_MINT,
    SYSTEM_PROGRAM_ID,
    PUMP_AMM_FEE_TOKEN_ACCOUNT,
    PUMP_BUY_DISCRIMINATOR,
    PUMP_SELL_DISCRIMINATOR,
    PUMP_SWAP_PERCENTAGE,
    PriorityLevel,
    PUMP_CREATE_DISCRIMINATOR,
    PUMP_IPFS_API_URL,
    TRADE_RAYDIUM_SWAP_TAX,
    PUMP_AMM_STATE_HEADER,
    PUMP_LTA_ACCOUNT,
    TRADE_MAX_SLIPPAGE,
    PUMP_AMM_CREATOR_VAULT_SEED,
    RENT_PROGRAM_ID,
    PUMP_CREATOR_VAULT_SEED,
    PUMP_EXTEND_DISCRIMINATOR,
    TRADE_MAX_WALLETS_PER_CREATE_BUNDLE,
    TRADE_MAX_WALLETS_PER_CREATE_TX
} from '../constants.js';
import {
    get_raydium_amm_from_mint,
    get_raydium_token_metrics,
    swap_raydium_instructions
} from '../common/trade_dex.js';
import { readFileSync } from 'fs';
import { basename } from 'path';
import base58 from 'bs58';

export class PumpMintMeta implements trade.IMintMeta {
    mint!: string;
    name: string = 'Unknown';
    symbol: string = 'Unknown';
    base_vault!: string;
    quote_vault!: string;
    creator_vault!: string;
    creator_vault_ata!: string;
    raydium_pool: string | null = null;
    pumpswap_pool: string | null = null;
    sol_reserves: bigint = BigInt(0);
    token_reserves: bigint = BigInt(0);
    total_supply: bigint = BigInt(0);
    usd_market_cap: number = 0;
    market_cap: number = 0;
    complete: boolean = false;
    fee: number = PUMP_FEE_PERCENTAGE;

    constructor(data: Partial<PumpMintMeta> = {}) {
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
        if (this.raydium_pool || this.pumpswap_pool) return true;
        return false;
    }

    public get platform_fee(): number {
        return this.fee;
    }

    public get mint_pubkey(): PublicKey {
        return new PublicKey(this.mint);
    }
}

const PUMP_AMM_STATE_SIZE = 0xd3;
const PUMP_AMM_STATE_OFFSETS = {
    POOL_BUMP: 0x08,
    INDEX: 0x09,
    CREATOR: 0x0b,
    BASE_MINT: 0x2b,
    QOTE_MINT: 0x4b,
    LP_MINT: 0x6b,
    BASE_VAULT: 0x8b,
    QUOTE_VAULT: 0xab,
    LP_SUPPLY: 0xcb,
    COIN_CREATOR: 0xd3
};

type PumpAmmState = {
    quote_mint: PublicKey;
    base_vault: PublicKey;
    quote_vault: PublicKey;
    base_vault_balance: bigint;
    quote_vault_balance: bigint;
    creator: PublicKey;
};

const PUMP_STATE_SIZE = 0x51;
const PUMP_STATE_OFFSETS = {
    VIRTUAL_TOKEN_RESERVES: 0x08,
    VIRTUAL_SOL_RESERVES: 0x10,
    REAL_TOKEN_RESERVES: 0x18,
    REAL_SOL_RESERVES: 0x20,
    TOKEN_TOTAL_SUPPLY: 0x28,
    COMPLETE: 0x30,
    COIN_CREATOR: 0x31
};

type PumpState = {
    virtual_token_reserves: bigint;
    virtual_sol_reserves: bigint;
    real_token_reserves: bigint;
    real_sol_reserves: bigint;
    supply: bigint;
    complete: boolean;
    creator: PublicKey;
};

@common.staticImplements<trade.IProgramTrader>()
export class Trader {
    public static get_name(): string {
        return 'Pump';
    }

    public static async buy_token(
        sol_amount: number,
        buyer: Signer,
        mint_meta: PumpMintMeta,
        slippage: number = 0.05,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<String> {
        const [instructions, ltas] = await this.buy_token_instructions(sol_amount, buyer, mint_meta, slippage);
        return await trade.send_tx(instructions, [buyer], priority, protection_tip, ltas);
    }

    public static async buy_token_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: PumpMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const pump_amm = this.get_amm(mint_meta);
        const ray_amm = this.get_raydium_amm(mint_meta);
        if (ray_amm) {
            const sol_token_amount = trade.get_sol_token_amount(sol_amount);
            const mint = new PublicKey(mint_meta.mint);
            return swap_raydium_instructions(sol_token_amount, buyer, ray_amm, mint, slippage);
        }
        const lta = await trade.get_ltas([PUMP_LTA_ACCOUNT]);
        if (pump_amm) {
            const instructions = await this.get_buy_amm_instructions(sol_amount, buyer, mint_meta, slippage);
            return [instructions, lta];
        }
        const instructions = await this.get_buy_instructions(sol_amount, buyer, mint_meta, slippage);
        return [instructions, lta];
    }

    public static async sell_token(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: PumpMintMeta,
        slippage: number = 0.05,
        priority: PriorityLevel,
        protection_tip?: number
    ): Promise<String> {
        const [instructions, ltas] = await this.sell_token_instructions(token_amount, seller, mint_meta, slippage);
        return await trade.send_tx(instructions, [seller], priority, protection_tip, ltas);
    }

    public static async sell_token_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: PumpMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const ray_amm = this.get_raydium_amm(mint_meta);
        const pump_amm = this.get_amm(mint_meta);
        if (ray_amm) {
            return swap_raydium_instructions(token_amount, seller, ray_amm, SOL_MINT, slippage);
        }
        const lta = await trade.get_ltas([PUMP_LTA_ACCOUNT]);
        if (pump_amm) {
            const instructions = await this.get_sell_amm_instructions(token_amount, seller, mint_meta, slippage);
            return [instructions, lta];
        }
        const instructions = await this.get_sell_instructions(token_amount, seller, mint_meta, slippage);
        return [instructions, lta];
    }

    public static async buy_sell_instructions(
        sol_amount: number,
        trader: Signer,
        mint_meta: PumpMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const sol_amount_raw = BigInt(Math.floor(sol_amount * LAMPORTS_PER_SOL));
        const sol_amount_raw_after_fee = (sol_amount_raw * (10000n - BigInt(mint_meta.fee * 10000))) / 10000n;
        const token_amount_raw = this.get_token_amount_raw(sol_amount_raw_after_fee, mint_meta);
        let [buy_instructions, lta] = await this.buy_token_instructions(sol_amount, trader, mint_meta, slippage);
        let [sell_instructions] = await this.sell_token_instructions(
            {
                uiAmount: Number(token_amount_raw) / 10 ** PUMP_CURVE_TOKEN_DECIMALS,
                amount: token_amount_raw.toString(),
                decimals: PUMP_CURVE_TOKEN_DECIMALS
            },
            trader,
            mint_meta,
            slippage
        );
        return [buy_instructions, sell_instructions, lta];
    }

    public static async get_mint_meta(mint: PublicKey, sol_price: number = 0): Promise<PumpMintMeta | undefined> {
        try {
            let mint_meta = await this.default_mint_meta(mint, sol_price);
            mint_meta = await this.update_mint_meta(mint_meta, sol_price);

            return mint_meta;
        } catch (error) {
            return undefined;
        }
    }

    public static async get_random_mints(count: number): Promise<PumpMintMeta[]> {
        const graduated_length = Math.floor(count * Math.random());
        const ungraduated_length = count - graduated_length;
        return (
            await Promise.all([
                this.get_random_graduated_mints(graduated_length),
                this.get_random_ungraduated_mints(ungraduated_length)
            ])
        ).flat();
    }

    public static async create_token(
        creator: Signer,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        sol_amount: number = 0.0,
        mint?: Keypair,
        traders?: [Signer, number][],
        bundle_tip?: number,
        priority?: PriorityLevel
    ): Promise<[String, PublicKey]> {
        if ((traders && !bundle_tip) || (!traders && bundle_tip))
            throw new Error(`Invalid parameters: traders and bundle_tip must be set together`);
        if (traders && (traders.length > TRADE_MAX_WALLETS_PER_CREATE_BUNDLE || traders.length < 1))
            throw new Error(`Invalid parameters: traders must be less than ${TRADE_MAX_WALLETS_PER_CREATE_BUNDLE}`);

        if (!mint) mint = Keypair.generate();
        let mint_meta = await this.default_mint_meta(mint.publicKey);
        mint_meta.creator_vault = this.calc_creator_vault(creator.publicKey)[0].toString();

        const create_instructions = await this.get_create_token_instructions(
            creator,
            token_name,
            token_symbol,
            meta_cid,
            mint
        );
        if (sol_amount > 0) {
            const buy_instructions = await this.get_buy_instructions(sol_amount, creator, mint_meta, 0.05);
            create_instructions.push(...buy_instructions);
        }

        const ltas = await trade.get_ltas([PUMP_LTA_ACCOUNT]);
        if (!traders) {
            const sig = await trade.send_tx(create_instructions, [creator, mint], priority, undefined, ltas);
            return [sig, mint.publicKey];
        }

        mint_meta = this.update_mint_meta_reserves(mint_meta, sol_amount);
        const txs = common.chunks(traders, TRADE_MAX_WALLETS_PER_CREATE_TX);
        const buy_instructions: TransactionInstruction[][] = [];
        const bundle_signers: Signer[][] = [];
        for (const tx of txs) {
            const instructions: TransactionInstruction[] = [];
            for (const trader of tx) {
                const [buyer, buy_amount] = trader;
                instructions.push(...(await this.get_buy_instructions(buy_amount, buyer, mint_meta, 0.05)));
                mint_meta = this.update_mint_meta_reserves(mint_meta, buy_amount);
            }
            buy_instructions.push(instructions);
            bundle_signers.push(tx.map((trader) => trader[0]));
        }
        const sig = await trade.send_bundle(
            [create_instructions, ...buy_instructions],
            [[creator, mint], ...bundle_signers],
            bundle_tip!,
            priority,
            ltas
        );
        return [sig, mint.publicKey];
    }

    public static async default_mint_meta(mint: PublicKey, sol_price: number = 0): Promise<PumpMintMeta> {
        const meta = await trade.get_token_meta(mint).catch(() => {
            return { token_name: 'Unknown', token_symbol: 'Unknown', creator: undefined };
        });
        const [bonding, bonding_ata] = this.calc_bonding_curve(mint);

        let creator_vault: PublicKey | undefined;
        let creator_vault_ata: PublicKey | undefined;
        if (meta.creator) [creator_vault, creator_vault_ata] = this.calc_creator_vault(meta.creator);

        return new PumpMintMeta({
            mint: mint.toString(),
            symbol: meta.token_symbol,
            name: meta.token_name,
            raydium_pool: null,
            pumpswap_pool: null,
            base_vault: bonding.toString(),
            quote_vault: bonding_ata.toString(),
            market_cap: 27.95,
            usd_market_cap: 27.95 * sol_price,
            sol_reserves: BigInt(30000000000),
            token_reserves: BigInt(1073000000000000),
            total_supply: BigInt(1000000000000000),
            fee: PUMP_FEE_PERCENTAGE,
            creator_vault: creator_vault ? creator_vault.toString() : undefined,
            creator_vault_ata: creator_vault_ata ? creator_vault_ata.toString() : undefined
        });
    }

    public static async buy_sell_bundle(
        sol_amount: number,
        trader: Signer,
        mint_meta: PumpMintMeta,
        tip: number,
        slippage: number = 0.05,
        priority?: PriorityLevel
    ): Promise<String> {
        const [buy_instructions, sell_instructions, lta] = await this.buy_sell_instructions(
            sol_amount,
            trader,
            mint_meta,
            slippage
        );
        return await trade.send_bundle([buy_instructions, sell_instructions], [[trader], [trader]], tip, priority, lta);
    }

    public static async buy_sell(
        sol_amount: number,
        trader: Signer,
        mint_meta: PumpMintMeta,
        slippage: number = 0.05,
        interval_ms?: number,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<[String, String]> {
        const [buy_instructions, sell_instructions, ltas] = await this.buy_sell_instructions(
            sol_amount,
            trader,
            mint_meta,
            slippage
        );

        if (interval_ms && interval_ms > 0) {
            const buy_signature = await trade.send_tx(buy_instructions, [trader], priority, protection_tip, ltas);
            await common.sleep(interval_ms);
            const sell_signature = await trade.retry_send_tx(
                sell_instructions,
                [trader],
                priority,
                protection_tip,
                ltas
            );
            return [buy_signature, sell_signature];
        }

        const signature = await trade.send_tx(
            [...buy_instructions, ...sell_instructions],
            [trader],
            priority,
            protection_tip,
            ltas
        );
        return [signature, signature];
    }

    public static update_mint_meta_reserves(mint_meta: PumpMintMeta, amount: number | TokenAmount): PumpMintMeta {
        if (typeof amount === 'number') {
            const sol_amount_raw = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));
            const fee = (sol_amount_raw * BigInt(mint_meta.fee * 10000)) / 10000n;
            const n = mint_meta.sol_reserves * mint_meta.token_reserves;
            mint_meta.sol_reserves = mint_meta.sol_reserves + (sol_amount_raw - fee);
            mint_meta.token_reserves = n / mint_meta.sol_reserves + 1n;
            return mint_meta;
        } else if (typeof amount === 'object') {
            const token_amount_raw = BigInt(amount.amount);
            mint_meta.token_reserves = mint_meta.token_reserves + token_amount_raw;
            const n = (token_amount_raw * mint_meta.sol_reserves) / mint_meta.token_reserves;
            const fee = (n * BigInt(mint_meta.fee * 10000)) / 10000n;
            mint_meta.sol_reserves = mint_meta.sol_reserves - (n - fee);
            return mint_meta;
        }
        throw new Error(`Invalid amount type: ${typeof amount}`);
    }

    public static async update_mint_meta(mint_meta: PumpMintMeta, sol_price: number = 0): Promise<PumpMintMeta> {
        try {
            const mint = new PublicKey(mint_meta.mint);
            const [ray_amm, pump_amm] = await Promise.all([
                get_raydium_amm_from_mint(mint),
                this.get_amm_from_mint(mint)
            ]);
            mint_meta.raydium_pool = ray_amm?.toString() ?? null;
            mint_meta.pumpswap_pool = pump_amm?.toString() ?? null;
            const hasPool = ray_amm || pump_amm;
            if (!hasPool && !mint_meta.complete) {
                const curve_state = await this.get_state(new PublicKey(mint_meta.base_vault));
                const metrics = this.get_token_metrics(curve_state);
                return new PumpMintMeta({
                    ...mint_meta,
                    usd_market_cap: metrics.mcap_sol * sol_price,
                    market_cap: metrics.mcap_sol,
                    total_supply: curve_state.supply,
                    token_reserves: curve_state.virtual_token_reserves,
                    sol_reserves: curve_state.virtual_sol_reserves,
                    complete: curve_state.complete
                });
            }

            if (pump_amm) {
                const amm_state = await this.get_amm_state(pump_amm);
                const metrics = await this.get_amm_token_metrics(amm_state);
                const [creator_vault, creator_vault_ata] = this.calc_amm_creator_vault(amm_state.creator);
                return new PumpMintMeta({
                    ...mint_meta,
                    usd_market_cap: metrics.mcap_sol * sol_price,
                    market_cap: metrics.mcap_sol,
                    total_supply: metrics.supply,
                    base_vault: amm_state.base_vault.toString(),
                    quote_vault: amm_state.quote_vault.toString(),
                    sol_reserves: amm_state.quote_vault_balance,
                    token_reserves: amm_state.base_vault_balance,
                    complete: true,
                    fee: PUMP_SWAP_PERCENTAGE,
                    creator_vault: creator_vault.toString(),
                    creator_vault_ata: creator_vault_ata.toString()
                });
            }

            if (ray_amm) {
                const metrics = await get_raydium_token_metrics(ray_amm);
                return new PumpMintMeta({
                    ...mint_meta,
                    usd_market_cap: metrics.mcap_sol * sol_price,
                    market_cap: metrics.mcap_sol,
                    total_supply: metrics.supply,
                    complete: true,
                    fee: TRADE_RAYDIUM_SWAP_TAX
                });
            }

            return mint_meta;
        } catch (error) {
            throw new Error(`Failed to update mint meta reserves: ${error}`);
        }
    }

    private static get_raydium_amm(mint_meta: PumpMintMeta): PublicKey | undefined {
        if (mint_meta.raydium_pool !== null) return new PublicKey(mint_meta.raydium_pool);
    }

    private static get_amm(mint_meta: PumpMintMeta): PublicKey | undefined {
        if (mint_meta.pumpswap_pool !== null) return new PublicKey(mint_meta.pumpswap_pool);
    }

    private static get_token_amount_raw(sol_amount_raw: bigint, token: Partial<PumpMintMeta>): bigint {
        if (!token.sol_reserves || !token.token_reserves || !token.fee) return 0n;
        if (sol_amount_raw <= 0) return 0n;

        const fee = (sol_amount_raw * BigInt(token.fee * 10000)) / 10000n;
        const n = token.sol_reserves * token.token_reserves;
        const new_sol_reserves = token.sol_reserves + (sol_amount_raw - fee);
        const new_token_reserves = n / new_sol_reserves + 1n;
        return token.token_reserves - new_token_reserves;
    }

    private static get_sol_amount_raw(token_amount_raw: bigint, token: Partial<PumpMintMeta>): bigint {
        if (!token.sol_reserves || !token.token_reserves || !token.fee) return 0n;
        if (token_amount_raw <= 0) return 0n;

        const n = (token_amount_raw * token.sol_reserves) / (token.token_reserves + token_amount_raw);
        const fee = (n * BigInt(token.fee * 10000)) / 10000n;
        return n - fee;
    }

    private static calc_slippage_up(sol_amount: bigint, slippage: number): bigint {
        if (slippage <= 0.0 || slippage >= TRADE_MAX_SLIPPAGE) throw new RangeError('Slippage must be between 0 and 1');
        return sol_amount + (sol_amount * BigInt(Math.floor(slippage * 10000))) / BigInt(10000);
    }

    private static calc_slippage_down(sol_amount: bigint, slippage: number): bigint {
        if (slippage <= 0.0 || slippage >= TRADE_MAX_SLIPPAGE) throw new RangeError('Slippage must be between 0 and 1');
        return sol_amount - (sol_amount * BigInt(Math.floor(slippage * 10000))) / BigInt(10000);
    }

    private static buy_data(sol_amount_raw: bigint, token_amount_raw: bigint, slippage: number): Buffer {
        const instruction_buf = Buffer.from(PUMP_BUY_DISCRIMINATOR);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(token_amount_raw, 0);
        const slippage_buf = Buffer.alloc(8);
        slippage_buf.writeBigUInt64LE(this.calc_slippage_up(sol_amount_raw, slippage), 0);
        return Buffer.concat([instruction_buf, token_amount_buf, slippage_buf]);
    }

    private static sell_data(sol_amount_raw: bigint, token_amount_raw: bigint, slippage: number): Buffer {
        const instruction_buf = Buffer.from(PUMP_SELL_DISCRIMINATOR);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(token_amount_raw, 0);
        const slippage_buf = Buffer.alloc(8);
        slippage_buf.writeBigUInt64LE(this.calc_slippage_down(sol_amount_raw, slippage), 0);
        return Buffer.concat([instruction_buf, token_amount_buf, slippage_buf]);
    }

    private static async get_buy_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: Partial<PumpMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (!mint_meta.mint || !mint_meta.base_vault || !mint_meta.quote_vault || !mint_meta.creator_vault) {
            throw new Error(`Failed to get the mint meta.`);
        }

        const mint = new PublicKey(mint_meta.mint);
        const creator_vault = new PublicKey(mint_meta.creator_vault);
        const bonding_curve = new PublicKey(mint_meta.base_vault);
        const assoc_bonding_curve = new PublicKey(mint_meta.quote_vault);
        const sol_amount_raw = BigInt(Math.floor(sol_amount * LAMPORTS_PER_SOL));

        const token_amount_raw = this.get_token_amount_raw(sol_amount_raw, mint_meta);
        const instruction_data = this.buy_data(sol_amount_raw, token_amount_raw, slippage);
        const token_ata = trade.calc_ata(buyer.publicKey, mint);

        return [
            createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, token_ata, buyer.publicKey, mint),
            new TransactionInstruction({
                keys: [
                    { pubkey: PUMP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_FEE_ACCOUNT, isSigner: false, isWritable: true },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: creator_vault, isSigner: false, isWritable: true },
                    { pubkey: PUMP_EVENT_AUTHORITUY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: PUMP_PROGRAM_ID,
                data: instruction_data
            })
        ];
    }

    private static async get_sell_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: Partial<PumpMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (!mint_meta.mint || !mint_meta.base_vault || !mint_meta.quote_vault || !mint_meta.creator_vault) {
            throw new Error(`Failed to get the mint meta.`);
        }
        if (token_amount.amount === null) throw new Error(`Failed to get the token amount.`);

        const mint = new PublicKey(mint_meta.mint);
        const creator_vault = new PublicKey(mint_meta.creator_vault);
        const bonding_curve = new PublicKey(mint_meta.base_vault);
        const assoc_bonding_curve = new PublicKey(mint_meta.quote_vault);
        const token_amount_raw = BigInt(token_amount.amount);
        const sol_amount_raw = this.get_sol_amount_raw(token_amount_raw, mint_meta);
        const instruction_data = this.sell_data(sol_amount_raw, token_amount_raw, slippage);
        const token_ata = trade.calc_ata(seller.publicKey, mint);

        let instructions: TransactionInstruction[] = [];
        instructions.push(
            new TransactionInstruction({
                keys: [
                    { pubkey: PUMP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_FEE_ACCOUNT, isSigner: false, isWritable: true },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: seller.publicKey, isSigner: true, isWritable: true },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: creator_vault, isSigner: false, isWritable: true },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: PUMP_EVENT_AUTHORITUY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: PUMP_PROGRAM_ID,
                data: instruction_data
            })
        );

        return instructions;
    }

    private static create_data(
        token_name: string,
        token_ticker: string,
        meta_link: string,
        creator: PublicKey
    ): Buffer {
        const instruction_buf = Buffer.from(PUMP_CREATE_DISCRIMINATOR);

        const token_name_buf = Buffer.alloc(4 + token_name.length);
        token_name_buf.writeUInt32LE(token_name.length, 0);
        token_name_buf.write(token_name, 4);

        const token_ticker_buf = Buffer.alloc(4 + token_ticker.length);
        token_ticker_buf.writeUInt32LE(token_ticker.length, 0);
        token_ticker_buf.write(token_ticker, 4);

        const meta_link_buf = Buffer.alloc(4 + meta_link.length);
        meta_link_buf.writeUInt32LE(meta_link.length, 0);
        meta_link_buf.write(meta_link, 4);

        const creator_buf = creator.toBuffer();

        return Buffer.concat([instruction_buf, token_name_buf, token_ticker_buf, meta_link_buf, creator_buf]);
    }

    private static async get_create_token_instructions(
        creator: Signer,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        mint: Keypair
    ): Promise<TransactionInstruction[]> {
        const meta_link = `${IPFS}${meta_cid}`;
        const instruction_data = this.create_data(token_name, token_symbol, meta_link, creator.publicKey);
        const [bonding, assoc_ata] = this.calc_bonding_curve(mint.publicKey);
        const [metaplex] = PublicKey.findProgramAddressSync(
            [PUMP_META_SEED, METAPLEX_PROGRAM_ID.toBuffer(), mint.publicKey.toBuffer()],
            METAPLEX_PROGRAM_ID
        );

        return [
            new TransactionInstruction({
                keys: [
                    { pubkey: mint.publicKey, isSigner: true, isWritable: true },
                    { pubkey: PUMP_MINT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: bonding, isSigner: false, isWritable: true },
                    { pubkey: assoc_ata, isSigner: false, isWritable: true },
                    { pubkey: PUMP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: METAPLEX_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: metaplex, isSigner: false, isWritable: true },
                    { pubkey: creator.publicKey, isSigner: true, isWritable: true },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: RENT_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: PUMP_EVENT_AUTHORITUY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: PUMP_PROGRAM_ID,
                data: instruction_data
            }),
            new TransactionInstruction({
                keys: [
                    { pubkey: bonding, isSigner: false, isWritable: true },
                    { pubkey: creator.publicKey, isSigner: true, isWritable: true },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: PUMP_EVENT_AUTHORITUY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: PUMP_PROGRAM_ID,
                data: Buffer.from(PUMP_EXTEND_DISCRIMINATOR)
            })
        ];
    }

    private static calc_bonding_curve(mint: PublicKey): [PublicKey, PublicKey] {
        const [bonding_curve] = PublicKey.findProgramAddressSync([PUMP_BONDING_SEED, mint.toBuffer()], PUMP_PROGRAM_ID);
        const [bonding_curve_ata] = PublicKey.findProgramAddressSync(
            [bonding_curve.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        return [bonding_curve, bonding_curve_ata];
    }

    private static calc_creator_vault(creator: PublicKey): [PublicKey, PublicKey] {
        const [creator_vault] = PublicKey.findProgramAddressSync(
            [PUMP_CREATOR_VAULT_SEED, creator.toBuffer()],
            PUMP_PROGRAM_ID
        );
        const creator_vault_ata = trade.calc_ata(creator_vault, SOL_MINT);
        return [creator_vault, creator_vault_ata];
    }

    private static calc_amm_creator_vault(creator: PublicKey): [PublicKey, PublicKey] {
        const [creator_vault] = PublicKey.findProgramAddressSync(
            [PUMP_AMM_CREATOR_VAULT_SEED, creator.toBuffer()],
            PUMP_AMM_PROGRAM_ID
        );
        const creator_vault_ata = trade.calc_ata(creator_vault, SOL_MINT);
        return [creator_vault, creator_vault_ata];
    }

    private static calculate_curve_price(virtual_sol_reserves: bigint, virtual_token_reserves: bigint): number {
        if (virtual_token_reserves <= 0 || virtual_sol_reserves <= 0)
            throw new RangeError('Curve state contains invalid reserve data');
        return (
            Number(virtual_sol_reserves) /
            LAMPORTS_PER_SOL /
            (Number(virtual_token_reserves) / 10 ** PUMP_CURVE_TOKEN_DECIMALS)
        );
    }

    private static get_token_metrics(state: PumpState): trade.TokenMetrics {
        const price_sol = this.calculate_curve_price(state.virtual_sol_reserves, state.virtual_token_reserves);

        const mcap_sol = (price_sol * Number(state.supply)) / 10 ** PUMP_CURVE_TOKEN_DECIMALS;
        return { price_sol, mcap_sol, supply: state.supply };
    }

    private static async get_state(bond_curve_addr: PublicKey): Promise<PumpState> {
        const info = await global.CONNECTION.getAccountInfo(bond_curve_addr, COMMITMENT);
        if (!info || !info.data || info.data.byteLength < PUMP_STATE_HEADER.byteLength + PUMP_STATE_SIZE)
            throw new Error('Unexpected curve state');

        const header = common.read_bytes(info.data, 0, PUMP_STATE_HEADER.byteLength);
        if (header.compare(PUMP_STATE_HEADER) !== 0) throw new Error('Unexpected curve state IDL signature');

        return {
            virtual_token_reserves: common.read_biguint_le(info.data, PUMP_STATE_OFFSETS.VIRTUAL_TOKEN_RESERVES, 8),
            virtual_sol_reserves: common.read_biguint_le(info.data, PUMP_STATE_OFFSETS.VIRTUAL_SOL_RESERVES, 8),
            real_token_reserves: common.read_biguint_le(info.data, PUMP_STATE_OFFSETS.REAL_TOKEN_RESERVES, 8),
            real_sol_reserves: common.read_biguint_le(info.data, PUMP_STATE_OFFSETS.REAL_SOL_RESERVES, 8),
            supply: common.read_biguint_le(info.data, PUMP_STATE_OFFSETS.TOKEN_TOTAL_SUPPLY, 8),
            complete: common.read_bool(info.data, PUMP_STATE_OFFSETS.COMPLETE, 1),
            creator: new PublicKey(common.read_bytes(info.data, PUMP_STATE_OFFSETS.COIN_CREATOR, 32))
        };
    }

    private static async get_amm_from_mint(mint: PublicKey): Promise<PublicKey | null> {
        try {
            const [amm] = await global.CONNECTION.getProgramAccounts(PUMP_AMM_PROGRAM_ID, {
                filters: [
                    {
                        memcmp: {
                            offset: PUMP_AMM_STATE_OFFSETS.BASE_MINT,
                            bytes: mint.toBase58()
                        }
                    },
                    {
                        memcmp: {
                            offset: 0,
                            bytes: base58.encode(PUMP_AMM_STATE_HEADER)
                        }
                    }
                ],
                commitment: COMMITMENT
            });
            return amm.pubkey;
        } catch (error) {
            return null;
        }
    }

    static async get_amm_state(amm: PublicKey): Promise<PumpAmmState> {
        const info = await global.CONNECTION.getAccountInfo(amm);
        if (!info || !info.data) throw new Error('Unexpected amm state');

        const header = common.read_bytes(info.data, 0, PUMP_AMM_STATE_HEADER.byteLength);
        if (header.compare(PUMP_AMM_STATE_HEADER) !== 0) throw new Error('Unexpected amm state IDL signature');

        const base_vault = new PublicKey(common.read_bytes(info.data, PUMP_AMM_STATE_OFFSETS.BASE_VAULT, 32));
        const quote_vault = new PublicKey(common.read_bytes(info.data, PUMP_AMM_STATE_OFFSETS.QUOTE_VAULT, 32));
        const base_vault_balance = await trade.get_vault_balance(base_vault);
        const quote_vault_balance = await trade.get_vault_balance(quote_vault);

        return {
            base_vault,
            quote_vault,
            quote_mint: new PublicKey(common.read_bytes(info.data, PUMP_AMM_STATE_OFFSETS.BASE_MINT, 32)),
            creator: new PublicKey(common.read_bytes(info.data, PUMP_AMM_STATE_OFFSETS.COIN_CREATOR, 32)),
            base_vault_balance: base_vault_balance.balance,
            quote_vault_balance: quote_vault_balance.balance
        };
    }

    static async get_amm_token_metrics(amm_state: PumpAmmState): Promise<trade.TokenMetrics> {
        const price_sol =
            Number(amm_state.quote_vault_balance) /
            LAMPORTS_PER_SOL /
            (Number(amm_state.base_vault_balance) / Math.pow(10, PUMP_CURVE_TOKEN_DECIMALS));
        const token = await trade.get_token_supply(amm_state.quote_mint);
        const mcap_sol = (price_sol * Number(token.supply)) / Math.pow(10, token.decimals);
        return { price_sol: price_sol, mcap_sol, supply: token.supply };
    }

    private static async get_buy_amm_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: Partial<PumpMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (
            !mint_meta.mint ||
            !mint_meta.pumpswap_pool ||
            !mint_meta.base_vault ||
            !mint_meta.quote_vault ||
            !mint_meta.creator_vault ||
            !mint_meta.creator_vault_ata
        ) {
            throw new Error(`Failed to get the mint meta.`);
        }

        const mint = new PublicKey(mint_meta.mint);
        const amm = new PublicKey(mint_meta.pumpswap_pool);
        const creator_vault = new PublicKey(mint_meta.creator_vault);
        const creator_vault_ata = new PublicKey(mint_meta.creator_vault_ata);
        const bonding_curve = new PublicKey(mint_meta.base_vault);
        const assoc_bonding_curve = new PublicKey(mint_meta.quote_vault);
        const sol_amount_raw = BigInt(Math.floor(sol_amount * LAMPORTS_PER_SOL));

        const token_amount_raw = this.get_token_amount_raw(sol_amount_raw, mint_meta);
        const instruction_data = this.buy_data(sol_amount_raw, token_amount_raw, slippage);
        const token_ata = trade.calc_ata(buyer.publicKey, mint);
        const wsol_ata = trade.calc_ata(buyer.publicKey, SOL_MINT);

        return [
            createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, token_ata, buyer.publicKey, mint),
            createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, wsol_ata, buyer.publicKey, SOL_MINT),
            SystemProgram.transfer({
                fromPubkey: buyer.publicKey,
                toPubkey: wsol_ata,
                lamports: this.calc_slippage_up(sol_amount_raw, slippage)
            }),
            createSyncNativeInstruction(wsol_ata),
            new TransactionInstruction({
                keys: [
                    { pubkey: amm, isSigner: false, isWritable: false },
                    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
                    { pubkey: PUMP_AMM_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: PUMP_AMM_FEE_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_AMM_FEE_TOKEN_ACCOUNT, isSigner: false, isWritable: true },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: PUMP_AMM_EVENT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: creator_vault_ata, isSigner: false, isWritable: true },
                    { pubkey: creator_vault, isSigner: false, isWritable: false }
                ],
                programId: PUMP_AMM_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, buyer.publicKey, buyer.publicKey)
        ];
    }

    private static async get_sell_amm_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: Partial<PumpMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (
            !mint_meta.mint ||
            !mint_meta.base_vault ||
            !mint_meta.quote_vault ||
            !mint_meta.pumpswap_pool ||
            !mint_meta.creator_vault ||
            !mint_meta.creator_vault_ata
        ) {
            throw new Error(`Failed to get the mint meta.`);
        }
        if (token_amount.amount === null) throw new Error(`Failed to get the token amount.`);

        const mint = new PublicKey(mint_meta.mint);
        const amm = new PublicKey(mint_meta.pumpswap_pool);
        const creator_vault = new PublicKey(mint_meta.creator_vault);
        const creator_vault_ata = new PublicKey(mint_meta.creator_vault_ata);
        const bonding_curve = new PublicKey(mint_meta.base_vault);
        const assoc_bonding_curve = new PublicKey(mint_meta.quote_vault);
        const token_amount_raw = BigInt(token_amount.amount);

        const sol_amount_raw = this.get_sol_amount_raw(token_amount_raw, mint_meta);
        const instruction_data = this.sell_data(sol_amount_raw, token_amount_raw, slippage);
        const token_ata = trade.calc_ata(seller.publicKey, mint);
        const wsol_ata = trade.calc_ata(seller.publicKey, SOL_MINT);

        let instructions: TransactionInstruction[] = [];
        instructions.push(
            createAssociatedTokenAccountIdempotentInstruction(seller.publicKey, wsol_ata, seller.publicKey, SOL_MINT)
        );
        instructions.push(
            new TransactionInstruction({
                keys: [
                    { pubkey: amm, isSigner: false, isWritable: false },
                    { pubkey: seller.publicKey, isSigner: true, isWritable: true },
                    { pubkey: PUMP_AMM_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: PUMP_AMM_FEE_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_AMM_FEE_TOKEN_ACCOUNT, isSigner: false, isWritable: true },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: PUMP_AMM_EVENT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: creator_vault_ata, isSigner: false, isWritable: true },
                    { pubkey: creator_vault, isSigner: false, isWritable: false }
                ],
                programId: PUMP_AMM_PROGRAM_ID,
                data: instruction_data
            })
        );
        instructions.push(createCloseAccountInstruction(wsol_ata, seller.publicKey, seller.publicKey));

        return instructions;
    }

    public static async create_token_metadata(meta: common.IPFSMetadata, image_path: string): Promise<string> {
        let formData = new FormData();
        const image_file = new File([readFileSync(image_path)], basename(image_path), {
            type: 'image/png'
        });
        formData.append('file', image_file);
        formData.append('name', meta.name);
        formData.append('symbol', meta.symbol);
        formData.append('description', meta.description);
        formData.append('twitter', meta.twitter || '');
        formData.append('telegram', meta.telegram || '');
        formData.append('website', meta.website || '');
        formData.append('showName', meta.showName ? 'true' : 'false');

        try {
            const response = await fetch(PUMP_IPFS_API_URL, {
                method: 'POST',
                headers: {
                    Accept: 'application/json'
                },
                body: formData,
                credentials: 'same-origin'
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            return data.metadataUri.split('/').slice(-1)[0];
        } catch (error) {
            throw new Error(`Failed to create token metadata: ${error}`);
        }
    }

    private static async get_random_ungraduated_mints(count: number): Promise<PumpMintMeta[]> {
        if (count <= 0) return [];
        const limit = 50;
        count = Math.min(count, limit);
        const offset = Array.from({ length: 20 }, (_, i) => i * limit).sort(() => 0.5 - Math.random())[0];

        return fetch(
            `${PUMP_FETCH_API_URL}/coins?offset=${offset}&limit=${limit}&sort=last_trade_timestamp&order=DESC&includeNsfw=false`
        )
            .then((response) => response.json())
            .then((data: any) => {
                if (!data || data.statusCode !== undefined) return [];
                return common.pick_random(data, count).map((item: any) => {
                    const mapped = {
                        ...item,
                        base_vault: item.bonding_curve,
                        quote_vault: item.associated_bonding_curve,
                        sol_reserves: BigInt(item.virtual_sol_reserves),
                        token_reserves: BigInt(item.virtual_token_reserves)
                    };
                    return new PumpMintMeta(mapped);
                });
            })
            .catch((err) => {
                common.error(common.red(`Failed fetching the mints: ${err}`));
                return [];
            });
    }

    private static graduated_mints_cache: PublicKey[] | null = null;
    private static async get_random_graduated_mints(count: number): Promise<PumpMintMeta[]> {
        if (count <= 0) return [];
        if (!this.graduated_mints_cache) {
            this.graduated_mints_cache = [];
            try {
                const amms = await global.CONNECTION.getProgramAccounts(PUMP_AMM_PROGRAM_ID, {
                    filters: [
                        {
                            memcmp: {
                                offset: 0,
                                bytes: base58.encode(PUMP_AMM_STATE_HEADER)
                            }
                        }
                    ],
                    dataSlice: {
                        offset: PUMP_AMM_STATE_OFFSETS.BASE_MINT,
                        length: PUMP_AMM_STATE_SIZE - PUMP_AMM_STATE_OFFSETS.BASE_MINT
                    },
                    commitment: COMMITMENT
                });
                if (amms) {
                    for (const chunk of common.chunks(amms, 100)) {
                        for (const acc of chunk) {
                            if (!acc) continue;
                            if (
                                common.read_biguint_le(
                                    acc.account.data,
                                    PUMP_AMM_STATE_OFFSETS.LP_SUPPLY - PUMP_AMM_STATE_OFFSETS.BASE_MINT,
                                    8
                                ) < 4000000000000n
                            )
                                continue;
                            this.graduated_mints_cache.push(new PublicKey(common.read_bytes(acc.account.data, 0, 32)));
                        }
                    }
                }
            } catch (error) {
                return [];
            }
        }

        return (
            await Promise.all(
                common.pick_random(this.graduated_mints_cache, count).map((mint) => this.get_mint_meta(mint))
            )
        ).filter((meta) => meta !== undefined);
    }
}
