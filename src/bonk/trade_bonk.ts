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
    BONK_CONFIG,
    BONK_IPFS_IMAGE_API_URL,
    BONK_IPFS_META_API_URL,
    BONK_SWAP_TAX,
    COMMITMENT,
    IPFS,
    METAPLEX_META_SEED,
    METAPLEX_PROGRAM_ID,
    PriorityLevel,
    RAYDIUM_CPMM_AUTHORITY,
    RAYDIUM_CPMM_CONFIG,
    RAYDIUM_CPMM_POOL_STATE_HEADER,
    RAYDIUM_CPMM_PROGRAM_ID,
    RAYDIUM_CPMM_SWAP_DISCRIMINATOR,
    RAYDIUM_LAUNCHPAD_AUTHORITY,
    RAYDIUM_LAUNCHPAD_BUY_DISCRIMINATOR,
    RAYDIUM_LAUNCHPAD_CREATE_DISCRIMINATOR,
    RAYDIUM_LAUNCHPAD_EVENT_AUTHORITY,
    RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG,
    RAYDIUM_LAUNCHPAD_POOL_HEADER,
    RAYDIUM_LAUNCHPAD_POOL_SEED,
    RAYDIUM_LAUNCHPAD_PROGRAM_ID,
    RAYDIUM_LAUNCHPAD_SELL_DISCRIMINATOR,
    RAYDIUM_LAUNCHPAD_VAULT_SEED,
    RAYDIUM_LTA_ACCOUNT,
    RENT_PROGRAM_ID,
    SOL_MINT,
    SYSTEM_PROGRAM_ID,
    TRADE_DEFAULT_TOKEN_DECIMALS,
    TRADE_MAX_SLIPPAGE,
    TRADE_MAX_WALLETS_PER_CREATE_BUNDLE,
    TRADE_MAX_WALLETS_PER_CREATE_TX
} from '../constants.js';
import { readFileSync } from 'fs';
import { basename } from 'path';
import {
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    createSyncNativeInstruction,
    TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import base58 from 'bs58';

const STATE_OFFSETS = {
    STATUS: 0x11,
    SUPPLY: 0x15,
    VIRTUAL_BASE: 0x25,
    VIRTUAL_QUOTE: 0x2d,
    REAL_BASE: 0x35,
    REAL_QUOTE: 0x3d
};
type State = {
    status: number;
    supply: bigint;
    virtual_base: bigint;
    virtual_quote: bigint;
    real_base: bigint;
    real_quote: bigint;
};

const CPMM_STATE_OFFSETS = {
    AMM_CONFIG: 0x08,
    POOL_CREATOR: 0x28,
    TOKEN_0_VAULT: 0x48,
    TOKEN_1_VAULT: 0x68,
    LP_MINT: 0x88,
    TOKEN_0_MINT: 0xa8,
    TOKEN_1_MINT: 0xc8,
    OBSERVATION_KEY: 0x128
};
type CPMMState = {
    amm_config: PublicKey;
    pool_creator: PublicKey;
    token_0_vault: PublicKey;
    token_1_vault: PublicKey;
    lp_mint: PublicKey;
    token_0_mint: PublicKey;
    token_1_mint: PublicKey;
    observation_key: PublicKey;
    token_0_reserves: bigint;
    token_1_reserves: bigint;
    supply: bigint;
};

class BonkMintMeta implements trade.IMintMeta {
    mint!: string;
    name: string = 'Unknown';
    symbol: string = 'Unknown';
    base_vault!: string;
    quote_vault!: string;
    pool!: string;
    sol_reserves: bigint = BigInt(0);
    token_reserves: bigint = BigInt(0);
    total_supply: bigint = BigInt(0);
    usd_market_cap: number = 0;
    market_cap: number = 0;
    complete: boolean = false;
    observation_state: string | null = null;
    fee: number = BONK_SWAP_TAX;

    constructor(data: Partial<BonkMintMeta> = {}) {
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
        return false;
    }

    public get platform_fee(): number {
        return this.fee;
    }

    public get mint_pubkey(): PublicKey {
        return new PublicKey(this.mint);
    }
}

@common.staticImplements<trade.IProgramTrader>()
export class Trader {
    public static get_name(): string {
        return common.Program.Bonk;
    }

    public static async buy_token(
        sol_amount: number,
        buyer: Signer,
        mint_meta: BonkMintMeta,
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
        mint_meta: BonkMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const lta = await trade.get_ltas([RAYDIUM_LTA_ACCOUNT]);
        if (mint_meta.complete) {
            const instructions = await this.get_buy_cpmm_instructions(sol_amount, buyer, mint_meta, slippage);
            return [instructions, lta];
        }
        const instructions = await this.get_buy_instructions(sol_amount, buyer, mint_meta, slippage);
        return [instructions, lta];
    }

    public static async sell_token(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: BonkMintMeta,
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
        mint_meta: BonkMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const lta = await trade.get_ltas([RAYDIUM_LTA_ACCOUNT]);
        if (mint_meta.complete) {
            const instructions = await this.get_sell_cpmm_instructions(token_amount, seller, mint_meta, slippage);
            return [instructions, lta];
        }
        const instructions = await this.get_sell_instructions(token_amount, seller, mint_meta, slippage);
        return [instructions, lta];
    }

    public static async buy_sell_instructions(
        sol_amount: number,
        trader: Signer,
        mint_meta: BonkMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const sol_amount_raw = BigInt(Math.floor(sol_amount * LAMPORTS_PER_SOL));
        const token_amount_raw = this.calc_token_amount_raw(sol_amount_raw, mint_meta);
        let [buy_instructions, lta] = await this.buy_token_instructions(sol_amount, trader, mint_meta, slippage);
        let [sell_instructions] = await this.sell_token_instructions(
            {
                uiAmount: Number(token_amount_raw) / 10 ** TRADE_DEFAULT_TOKEN_DECIMALS,
                amount: token_amount_raw.toString(),
                decimals: TRADE_DEFAULT_TOKEN_DECIMALS
            },
            trader,
            mint_meta,
            slippage
        );
        return [buy_instructions, sell_instructions, lta];
    }

    public static async buy_sell(
        sol_amount: number,
        trader: Signer,
        mint_meta: BonkMintMeta,
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

    public static async buy_sell_bundle(
        sol_amount: number,
        trader: Signer,
        mint_meta: BonkMintMeta,
        tip: number,
        slippage: number = 0.05,
        priority?: PriorityLevel
    ): Promise<String> {
        const [buy_instructions, sell_instructions, ltas] = await this.buy_sell_instructions(
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
            ltas
        );
    }

    public static async get_mint_meta(mint: PublicKey, sol_price: number = 0): Promise<BonkMintMeta | undefined> {
        try {
            let mint_meta = await this.default_mint_meta(mint, sol_price);
            mint_meta = await this.update_mint_meta(mint_meta, sol_price);
            return mint_meta;
        } catch (error) {
            return undefined;
        }
    }

    public static async get_random_mints(_count: number): Promise<BonkMintMeta[]> {
        throw new Error('Not implemented');
    }

    public static async create_token(
        mint: Keypair,
        creator: Signer,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        sol_amount: number = 0,
        traders?: [Signer, number][],
        bundle_tip?: number,
        priority?: PriorityLevel
    ): Promise<String> {
        if ((traders && !bundle_tip) || (!traders && bundle_tip))
            throw new Error(`Invalid parameters: traders and bundle_tip must be set together`);
        if (traders && (traders.length > TRADE_MAX_WALLETS_PER_CREATE_BUNDLE || traders.length < 1))
            throw new Error(`Invalid parameters: traders must be less than ${TRADE_MAX_WALLETS_PER_CREATE_BUNDLE}`);

        let mint_meta = await this.default_mint_meta(mint.publicKey);

        const create_instructions = await this.get_create_token_instructions(
            creator,
            token_name,
            token_symbol,
            meta_cid,
            mint
        );
        if (sol_amount > 0) {
            const buy_instructions = await this.get_buy_instructions(sol_amount, creator, mint_meta, 0.005);
            create_instructions.push(...buy_instructions);
        }

        const ltas = await trade.get_ltas([RAYDIUM_LTA_ACCOUNT]);
        if (!traders)
            return await trade.send_tx(create_instructions, [creator, mint], PriorityLevel.HIGH, undefined, ltas);

        const generated_lta = await trade.generate_trade_lta(
            creator,
            traders.map((tr) => Keypair.fromSecretKey(tr[0].secretKey)),
            mint.publicKey
        );
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
        return await trade.retry_send_bundle(
            [create_instructions, ...buy_instructions],
            [[creator, mint], ...bundle_signers],
            bundle_tip!,
            priority,
            [generated_lta, ...ltas]
        );
    }

    public static update_mint_meta_reserves(mint_meta: BonkMintMeta, amount: number | TokenAmount): BonkMintMeta {
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

    public static async update_mint_meta(mint_meta: BonkMintMeta, sol_price: number = 0.0): Promise<BonkMintMeta> {
        try {
            const cpmm_pool = await this.get_cpmm_from_mint(new PublicKey(mint_meta.mint));

            if (!cpmm_pool && !mint_meta.complete) {
                const state = await this.get_state(new PublicKey(mint_meta.pool));
                const metrics = this.get_token_metrics(state);
                return new BonkMintMeta({
                    ...mint_meta,
                    usd_market_cap: metrics.mcap_sol * sol_price,
                    market_cap: metrics.mcap_sol,
                    sol_reserves: state.real_quote + state.virtual_quote,
                    token_reserves: state.virtual_base - state.real_base,
                    total_supply: state.supply,
                    complete: state.status !== 0
                });
            }

            if (cpmm_pool) {
                const state = await this.get_cpmm_state(cpmm_pool);
                const metrics = this.get_cpmm_token_metrics(state);
                return new BonkMintMeta({
                    ...mint_meta,
                    usd_market_cap: metrics.mcap_sol * sol_price,
                    market_cap: metrics.mcap_sol,
                    pool: cpmm_pool.toString(),
                    sol_reserves: state.token_0_reserves,
                    token_reserves: state.token_1_reserves,
                    base_vault: state.token_1_vault.toString(),
                    quote_vault: state.token_0_vault.toString(),
                    total_supply: state.supply,
                    complete: true,
                    observation_state: state.observation_key.toString()
                });
            }

            return mint_meta;
        } catch (error) {
            throw new Error(`Failed to update mint meta reserves: ${error}`);
        }
    }

    public static async default_mint_meta(mint: PublicKey, sol_price: number = 0.0): Promise<BonkMintMeta> {
        const meta = await trade.get_token_meta(mint).catch(() => {
            return { token_name: 'Unknown', token_symbol: 'Unknown', creator: undefined };
        });
        const pool = this.calc_pool(mint);
        const [base_vault, quote_vault] = this.calc_vault(mint, pool);

        return new BonkMintMeta({
            mint: mint.toString(),
            symbol: meta.token_symbol,
            name: meta.token_name,
            pool: pool.toString(),
            base_vault: base_vault.toString(),
            quote_vault: quote_vault.toString(),
            market_cap: 30,
            usd_market_cap: 30 * sol_price,
            sol_reserves: BigInt(30000852951),
            token_reserves: BigInt(1073025605596382),
            total_supply: BigInt(1000000000000000)
        });
    }

    public static async create_token_metadata(meta: common.IPFSMetadata, image_path: string): Promise<string> {
        const image_file = new File([readFileSync(image_path)], basename(image_path), {
            type: 'image/png'
        });

        const form_data = new FormData();
        form_data.append('image', image_file);

        try {
            const image_response = await fetch(BONK_IPFS_IMAGE_API_URL, {
                method: 'POST',
                body: form_data
            });
            if (!image_response.ok) throw new Error(`HTTP error! status: ${image_response.status}`);
            const image_ipfs_url = await image_response.text();
            meta.image = image_ipfs_url;

            const meta_response = await fetch(BONK_IPFS_META_API_URL, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(meta)
            });
            if (!meta_response.ok) throw new Error(`HTTP error! status: ${meta_response.status}`);
            const data = await meta_response.text();
            return data.split('/').slice(-1)[0];
        } catch (error) {
            throw new Error(`Failed to create token metadata: ${error}`);
        }
    }

    private static calc_token_amount_raw(sol_amount_raw: bigint, token: Partial<BonkMintMeta>): bigint {
        if (!token.sol_reserves || !token.token_reserves || !token.fee) return 0n;
        if (sol_amount_raw <= 0) return 0n;

        const fee = (sol_amount_raw * BigInt(token.fee * 10000)) / 10000n;
        const n = token.sol_reserves * token.token_reserves;
        const new_sol_reserves = token.sol_reserves + (sol_amount_raw - fee);
        const new_token_reserves = n / new_sol_reserves + 1n;
        return token.token_reserves - new_token_reserves;
    }

    private static calc_sol_amount_raw(token_amount_raw: bigint, token: Partial<BonkMintMeta>): bigint {
        if (!token.sol_reserves || !token.token_reserves) return 0n;
        if (token_amount_raw <= 0) return 0n;

        return (token_amount_raw * token.sol_reserves) / (token.token_reserves + token_amount_raw);
    }

    private static calc_slippage_up(sol_amount: bigint, slippage: number): bigint {
        if (slippage <= 0.0 || slippage >= TRADE_MAX_SLIPPAGE) throw new RangeError('Slippage must be between 0 and 1');
        return sol_amount + (sol_amount * BigInt(Math.floor(slippage * 10000))) / BigInt(10000);
    }

    private static calc_slippage_down(sol_amount: bigint, slippage: number): bigint {
        if (slippage <= 0.0 || slippage >= TRADE_MAX_SLIPPAGE) throw new RangeError('Slippage must be between 0 and 1');
        return sol_amount - (sol_amount * BigInt(Math.floor(slippage * 10000))) / BigInt(10000);
    }

    private static swap_data(amount_in: bigint, minimum_amount_out: bigint, op: 'buy' | 'sell'): Buffer {
        const discriminator = op === 'buy' ? RAYDIUM_LAUNCHPAD_BUY_DISCRIMINATOR : RAYDIUM_LAUNCHPAD_SELL_DISCRIMINATOR;
        const instruction_buf = Buffer.from(discriminator);
        const sol_amount_buf = Buffer.alloc(8);
        sol_amount_buf.writeBigUInt64LE(amount_in, 0);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(minimum_amount_out, 0);
        const share_fee_rate = Buffer.alloc(8);
        share_fee_rate.writeBigUInt64LE(0n, 0);
        return Buffer.concat([instruction_buf, sol_amount_buf, token_amount_buf, share_fee_rate]);
    }

    private static swap_cpmm_data(amount_in: bigint, minimum_amount_out: bigint): Buffer {
        const instruction_buf = Buffer.from(RAYDIUM_CPMM_SWAP_DISCRIMINATOR);
        const sol_amount_buf = Buffer.alloc(8);
        sol_amount_buf.writeBigUInt64LE(amount_in, 0);
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(minimum_amount_out, 0);
        return Buffer.concat([instruction_buf, sol_amount_buf, token_amount_buf]);
    }

    private static async get_buy_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: Partial<BonkMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (!mint_meta.mint || !mint_meta.base_vault || !mint_meta.quote_vault || !mint_meta.pool)
            throw new Error(`Incomplete mint meta data for buy instructions.`);

        const mint = new PublicKey(mint_meta.mint);
        const quote_vault = new PublicKey(mint_meta.quote_vault);
        const base_vault = new PublicKey(mint_meta.base_vault);
        const pool = new PublicKey(mint_meta.pool);
        const token_ata = trade.calc_ata(buyer.publicKey, mint);
        const wsol_ata = trade.calc_ata(buyer.publicKey, SOL_MINT);

        const sol_amount_raw = BigInt(Math.floor(sol_amount * LAMPORTS_PER_SOL));
        const token_amount_raw = this.calc_slippage_down(
            this.calc_token_amount_raw(sol_amount_raw, mint_meta),
            slippage
        );
        const instruction_data = this.swap_data(sol_amount_raw, token_amount_raw, 'buy');

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
                    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
                    { pubkey: RAYDIUM_LAUNCHPAD_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG, isSigner: false, isWritable: false },
                    { pubkey: BONK_CONFIG, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: RAYDIUM_LAUNCHPAD_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, buyer.publicKey, buyer.publicKey)
        ];
    }

    private static async get_sell_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: Partial<BonkMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (!mint_meta.mint || !mint_meta.quote_vault || !mint_meta.base_vault || !mint_meta.pool)
            throw new Error(`Incomplete mint meta data for sell instructions.`);
        if (token_amount.amount === null) throw new Error(`Invalid token amount: ${token_amount.amount}`);

        const mint = new PublicKey(mint_meta.mint);
        const quote_vault = new PublicKey(mint_meta.quote_vault);
        const base_vault = new PublicKey(mint_meta.base_vault);
        const pool = new PublicKey(mint_meta.pool);

        const token_amount_raw = BigInt(token_amount.amount);
        const sol_amount_raw = this.calc_slippage_down(this.calc_sol_amount_raw(token_amount_raw, mint_meta), slippage);

        const instruction_data = this.swap_data(token_amount_raw, sol_amount_raw, 'sell');
        const token_ata = trade.calc_ata(seller.publicKey, mint);
        const wsol_ata = trade.calc_ata(seller.publicKey, SOL_MINT);

        return [
            createAssociatedTokenAccountIdempotentInstruction(seller.publicKey, wsol_ata, seller.publicKey, SOL_MINT),
            new TransactionInstruction({
                keys: [
                    { pubkey: seller.publicKey, isSigner: true, isWritable: true },
                    { pubkey: RAYDIUM_LAUNCHPAD_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG, isSigner: false, isWritable: false },
                    { pubkey: BONK_CONFIG, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: RAYDIUM_LAUNCHPAD_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, seller.publicKey, seller.publicKey)
        ];
    }

    private static async get_buy_cpmm_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: BonkMintMeta,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (
            !mint_meta.mint ||
            !mint_meta.pool ||
            !mint_meta.base_vault ||
            !mint_meta.quote_vault ||
            !mint_meta.observation_state
        )
            throw new Error(`Incomplete mint meta data for buy instructions.`);

        const mint = new PublicKey(mint_meta.mint);
        const pool = new PublicKey(mint_meta.pool);
        const observation_state = new PublicKey(mint_meta.observation_state);
        const quote_vault = new PublicKey(mint_meta.quote_vault);
        const base_vault = new PublicKey(mint_meta.base_vault);

        const sol_amount_raw = BigInt(Math.floor(sol_amount * LAMPORTS_PER_SOL));
        const token_amount_raw = this.calc_slippage_down(
            this.calc_token_amount_raw(sol_amount_raw, mint_meta),
            slippage
        );

        const instruction_data = this.swap_cpmm_data(sol_amount_raw, token_amount_raw);
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
                    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
                    { pubkey: RAYDIUM_CPMM_AUTHORITY, isSigner: false, isWritable: true },
                    { pubkey: RAYDIUM_CPMM_CONFIG, isSigner: false, isWritable: true },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: observation_state, isSigner: false, isWritable: true }
                ],
                programId: RAYDIUM_CPMM_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, buyer.publicKey, buyer.publicKey)
        ];
    }

    private static async get_sell_cpmm_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: BonkMintMeta,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (
            !mint_meta.mint ||
            !mint_meta.pool ||
            !mint_meta.base_vault ||
            !mint_meta.quote_vault ||
            !mint_meta.observation_state
        )
            throw new Error(`Incomplete mint meta data for sell instructions.`);
        if (token_amount.amount === null) throw new Error(`Invalid token amount: ${token_amount.amount}`);

        const mint = new PublicKey(mint_meta.mint);
        const pool = new PublicKey(mint_meta.pool);
        const observation_state = new PublicKey(mint_meta.observation_state);
        const quote_vault = new PublicKey(mint_meta.quote_vault);
        const base_vault = new PublicKey(mint_meta.base_vault);

        const token_amount_raw = BigInt(token_amount.amount);
        const instruction_data = this.swap_cpmm_data(
            token_amount_raw,
            this.calc_slippage_down(this.calc_sol_amount_raw(token_amount_raw, mint_meta), slippage)
        );
        const token_ata = trade.calc_ata(seller.publicKey, new PublicKey(mint_meta.mint));
        const wsol_ata = trade.calc_ata(seller.publicKey, SOL_MINT);

        return [
            createAssociatedTokenAccountIdempotentInstruction(seller.publicKey, wsol_ata, seller.publicKey, SOL_MINT),
            new TransactionInstruction({
                keys: [
                    { pubkey: seller.publicKey, isSigner: true, isWritable: true },
                    { pubkey: RAYDIUM_CPMM_AUTHORITY, isSigner: false, isWritable: true },
                    { pubkey: RAYDIUM_CPMM_CONFIG, isSigner: false, isWritable: true },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: token_ata, isSigner: false, isWritable: true },
                    { pubkey: wsol_ata, isSigner: false, isWritable: true },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: observation_state, isSigner: false, isWritable: true }
                ],
                programId: RAYDIUM_CPMM_PROGRAM_ID,
                data: instruction_data
            }),
            createCloseAccountInstruction(wsol_ata, seller.publicKey, seller.publicKey)
        ];
    }

    private static async get_create_token_instructions(
        creator: Signer,
        token_name: string,
        token_symbol: string,
        meta_cid: string,
        mint: Keypair
    ): Promise<TransactionInstruction[]> {
        const meta_link = `${IPFS}${meta_cid}`;
        const instruction_data = this.create_data(token_name, token_symbol, meta_link);
        const pool = this.calc_pool(mint.publicKey);
        const [base_vault, quote_vault] = this.calc_vault(mint.publicKey, pool);
        const [metaplex] = PublicKey.findProgramAddressSync(
            [METAPLEX_META_SEED, METAPLEX_PROGRAM_ID.toBuffer(), mint.publicKey.toBuffer()],
            METAPLEX_PROGRAM_ID
        );

        return [
            new TransactionInstruction({
                keys: [
                    { pubkey: creator.publicKey, isSigner: true, isWritable: true },
                    { pubkey: creator.publicKey, isSigner: true, isWritable: true },
                    { pubkey: RAYDIUM_LAUNCHPAD_GLOBAL_CONFIG, isSigner: false, isWritable: false },
                    { pubkey: BONK_CONFIG, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: pool, isSigner: false, isWritable: true },
                    { pubkey: mint.publicKey, isSigner: true, isWritable: true },
                    { pubkey: SOL_MINT, isSigner: false, isWritable: false },
                    { pubkey: base_vault, isSigner: false, isWritable: true },
                    { pubkey: quote_vault, isSigner: false, isWritable: true },
                    { pubkey: metaplex, isSigner: false, isWritable: true },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: METAPLEX_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: RENT_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_EVENT_AUTHORITY, isSigner: false, isWritable: false },
                    { pubkey: RAYDIUM_LAUNCHPAD_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: RAYDIUM_LAUNCHPAD_PROGRAM_ID,
                data: instruction_data
            })
        ];
    }

    private static calc_vault(mint: PublicKey, pool: PublicKey): [PublicKey, PublicKey] {
        const [base_vault] = PublicKey.findProgramAddressSync(
            [RAYDIUM_LAUNCHPAD_VAULT_SEED, pool.toBuffer(), mint.toBuffer()],
            RAYDIUM_LAUNCHPAD_PROGRAM_ID
        );
        const [quote_vault] = PublicKey.findProgramAddressSync(
            [RAYDIUM_LAUNCHPAD_VAULT_SEED, pool.toBuffer(), SOL_MINT.toBuffer()],
            RAYDIUM_LAUNCHPAD_PROGRAM_ID
        );
        return [base_vault, quote_vault];
    }

    private static calc_pool(base_mint: PublicKey): PublicKey {
        const [vault] = PublicKey.findProgramAddressSync(
            [RAYDIUM_LAUNCHPAD_POOL_SEED, base_mint.toBuffer(), SOL_MINT.toBuffer()],
            RAYDIUM_LAUNCHPAD_PROGRAM_ID
        );
        return vault;
    }

    private static get_token_metrics(state: State): trade.TokenMetrics {
        const price_sol = this.calculate_curve_price(
            state.real_quote + state.virtual_quote,
            state.virtual_base - state.real_base
        );

        const mcap_sol = (price_sol * Number(state.supply)) / 10 ** TRADE_DEFAULT_TOKEN_DECIMALS;
        return { price_sol, mcap_sol, supply: state.supply };
    }

    private static get_cpmm_token_metrics(state: CPMMState): trade.TokenMetrics {
        const price_sol = this.calculate_curve_price(state.token_0_reserves, state.token_1_reserves);
        const mcap_sol = (price_sol * Number(state.supply)) / 10 ** TRADE_DEFAULT_TOKEN_DECIMALS;
        return { price_sol, mcap_sol, supply: BigInt(0) };
    }

    private static calculate_curve_price(quote_reserves: bigint, base_reserves: bigint): number {
        if (base_reserves <= 0 || quote_reserves <= 0)
            throw new RangeError('Curve state contains invalid virtual reserves');
        return Number(quote_reserves) / LAMPORTS_PER_SOL / (Number(base_reserves) / 10 ** TRADE_DEFAULT_TOKEN_DECIMALS);
    }

    private static async get_state(bond_curve_addr: PublicKey): Promise<State> {
        const info = await global.CONNECTION.getAccountInfo(bond_curve_addr, COMMITMENT);
        if (!info || !info.data) throw new Error('Unexpected curve state');

        const header = common.read_bytes(info.data, 0, RAYDIUM_LAUNCHPAD_POOL_HEADER.byteLength);
        if (header.compare(RAYDIUM_LAUNCHPAD_POOL_HEADER) !== 0)
            throw new Error('Unexpected curve state IDL signature');

        return {
            status: common.read_bytes(info.data, STATE_OFFSETS.STATUS, 1).readUint8(0),
            supply: common.read_biguint_le(info.data, STATE_OFFSETS.SUPPLY, 8),
            virtual_base: common.read_biguint_le(info.data, STATE_OFFSETS.VIRTUAL_BASE, 8),
            virtual_quote: common.read_biguint_le(info.data, STATE_OFFSETS.VIRTUAL_QUOTE, 8),
            real_base: common.read_biguint_le(info.data, STATE_OFFSETS.REAL_BASE, 8),
            real_quote: common.read_biguint_le(info.data, STATE_OFFSETS.REAL_QUOTE, 8)
        };
    }

    private static create_data(token_name: string, token_ticker: string, meta_link: string): Buffer {
        const instruction_buf = Buffer.from(RAYDIUM_LAUNCHPAD_CREATE_DISCRIMINATOR);

        const decimals_buf = Buffer.alloc(1);
        decimals_buf.writeUInt8(TRADE_DEFAULT_TOKEN_DECIMALS, 0);

        const token_name_buf = Buffer.alloc(4 + token_name.length);
        token_name_buf.writeUInt32LE(token_name.length, 0);
        token_name_buf.write(token_name, 4);

        const token_ticker_buf = Buffer.alloc(4 + token_ticker.length);
        token_ticker_buf.writeUInt32LE(token_ticker.length, 0);
        token_ticker_buf.write(token_ticker, 4);

        const meta_link_buf = Buffer.alloc(4 + meta_link.length);
        meta_link_buf.writeUInt32LE(meta_link.length, 0);
        meta_link_buf.write(meta_link, 4);

        // Constant curve parameters
        const constant_curve_params_buf = Buffer.alloc(1 + 8 + 8 + 8 + 1);
        constant_curve_params_buf.writeUInt8(0, 0); // curve type
        constant_curve_params_buf.writeBigUInt64LE(BigInt(1000000000000000), 1); // supply
        constant_curve_params_buf.writeBigUInt64LE(BigInt(793100000000000), 9); // total_base_sell
        constant_curve_params_buf.writeBigUInt64LE(BigInt(85000000000), 17); // total_quote_fund_raising
        constant_curve_params_buf.writeUInt8(1, 25); // migrate type

        // Vesting parameters
        const vesting_params_buf = Buffer.alloc(8 + 8 + 8);
        vesting_params_buf.writeBigUInt64LE(BigInt(0), 0); // total_locked_amount
        vesting_params_buf.writeBigUInt64LE(BigInt(0), 8); // cliff_period
        vesting_params_buf.writeBigUInt64LE(BigInt(0), 16); // unlock_period

        return Buffer.concat([
            instruction_buf,
            decimals_buf,
            token_name_buf,
            token_ticker_buf,
            meta_link_buf,
            constant_curve_params_buf,
            vesting_params_buf
        ]);
    }

    private static async get_cpmm_from_mint(mint: PublicKey): Promise<PublicKey | null> {
        try {
            const [cpmm] = await global.CONNECTION.getProgramAccounts(RAYDIUM_CPMM_PROGRAM_ID, {
                filters: [
                    {
                        memcmp: {
                            offset: CPMM_STATE_OFFSETS.TOKEN_1_MINT,
                            bytes: mint.toBase58()
                        }
                    },
                    {
                        memcmp: {
                            offset: CPMM_STATE_OFFSETS.TOKEN_0_MINT,
                            bytes: SOL_MINT.toBase58()
                        }
                    },
                    {
                        memcmp: {
                            offset: 0,
                            bytes: base58.encode(RAYDIUM_CPMM_POOL_STATE_HEADER)
                        }
                    }
                ],
                commitment: COMMITMENT
            });
            return cpmm.pubkey;
        } catch (error) {
            return null;
        }
    }

    private static async get_cpmm_state(cpmm_pool: PublicKey): Promise<CPMMState> {
        const info = await global.CONNECTION.getAccountInfo(cpmm_pool);
        if (!info || !info.data) throw new Error('Unexpected CPMM state');

        const header = common.read_bytes(info.data, 0, RAYDIUM_CPMM_POOL_STATE_HEADER.byteLength);
        if (header.compare(RAYDIUM_CPMM_POOL_STATE_HEADER) !== 0)
            throw new Error('Unexpected CPMM state IDL signature');

        const token_0_vault = new PublicKey(common.read_bytes(info.data, CPMM_STATE_OFFSETS.TOKEN_0_VAULT, 32));
        const token_1_vault = new PublicKey(common.read_bytes(info.data, CPMM_STATE_OFFSETS.TOKEN_1_VAULT, 32));
        const token_1_mint = new PublicKey(common.read_bytes(info.data, CPMM_STATE_OFFSETS.TOKEN_1_MINT, 32));
        const token_0_reserves = await trade.get_vault_balance(token_0_vault);
        const token_1_reserves = await trade.get_vault_balance(token_1_vault);
        const supply = await trade.get_token_supply(token_1_mint);

        return {
            amm_config: new PublicKey(common.read_bytes(info.data, CPMM_STATE_OFFSETS.AMM_CONFIG, 32)),
            pool_creator: new PublicKey(common.read_bytes(info.data, CPMM_STATE_OFFSETS.POOL_CREATOR, 32)),
            token_0_vault,
            token_1_vault,
            lp_mint: new PublicKey(common.read_bytes(info.data, CPMM_STATE_OFFSETS.LP_MINT, 32)),
            token_0_mint: new PublicKey(common.read_bytes(info.data, CPMM_STATE_OFFSETS.TOKEN_0_MINT, 32)),
            token_1_mint,
            observation_key: new PublicKey(common.read_bytes(info.data, CPMM_STATE_OFFSETS.OBSERVATION_KEY, 32)),
            token_0_reserves: token_0_reserves.balance,
            token_1_reserves: token_1_reserves.balance,
            supply: supply.supply
        };
    }
}
