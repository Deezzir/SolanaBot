import {
    ComputeBudgetProgram,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    Signer,
    TokenAmount,
    TransactionInstruction
} from '@solana/web3.js';
import * as common from '../common/common.js';
import * as trade from '../common/trade_common.js';
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import {
    COMMITMENT,
    IPFS,
    METAPLEX_PROGRAM_ID,
    PUMP_BONDING_ADDR,
    PUMP_CURVE_STATE_SIGNATURE,
    PUMP_CURVE_TOKEN_DECIMALS,
    PUMP_EVENT_AUTHORITUY_ACCOUNT,
    PUMP_FEE_RECIPIENT_ACCOUNT,
    PUMP_FETCH_API_URL,
    PUMP_GLOBAL_ACCOUNT,
    PUMP_META_ADDR,
    PUMP_MINT_AUTHORITY_ACCOUNT,
    PUMP_TRADE_PROGRAM_ID,
    RENT_PROGRAM_ID,
    SOL_MINT,
    SYSTEM_PROGRAM_ID
} from '../constants.js';

export class PumpMintMeta implements trade.IMintMeta {
    mint!: string;
    name: string = 'Unknown';
    symbol: string = 'Unknown';
    bonding_curve!: string;
    associated_bonding_curve!: string;
    raydium_pool: string | null = null;
    virtual_sol_reserves: bigint = BigInt(0);
    virtual_token_reserves: bigint = BigInt(0);
    total_supply: bigint = BigInt(0);
    usd_market_cap: number = 0;
    market_cap: number = 0;
    complete: boolean = false;

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

    public get bond_complete(): boolean {
        return this.complete;
    }

    public get amm(): PublicKey | null {
        return this.raydium_pool !== null ? new PublicKey(this.raydium_pool) : null;
    }
}

const CURVE_STATE_SIZE = 0x29;
const CURVE_STATE_OFFSETS = {
    VIRTUAL_TOKEN_RESERVES: 0x08,
    VIRTUAL_SOL_RESERVES: 0x10,
    REAL_TOKEN_RESERVES: 0x18,
    REAL_SOL_RESERVES: 0x20,
    TOKEN_TOTAL_SUPPLY: 0x28,
    COMPLETE: 0x30
};

type CurveState = {
    virtual_token_reserves: bigint;
    virtual_sol_reserves: bigint;
    real_token_reserves: bigint;
    real_sol_reserves: bigint;
    token_total_supply: bigint;
    complete: boolean;
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
        priority?: trade.PriorityLevel
    ): Promise<String> {
        const amm = this.get_raydium_amm(mint_meta);
        if (!amm) {
            return this.buy_token_pump(sol_amount, buyer, mint_meta, slippage, priority);
        } else {
            const sol_token_amount = trade.get_sol_token_amount(sol_amount);
            const mint = new PublicKey(mint_meta.mint);
            return trade.swap(sol_token_amount, buyer, mint, SOL_MINT, amm, slippage);
        }
    }

    public static async buy_token_with_retry(
        sol_amount: number,
        buyer: Signer,
        mint_meta: PumpMintMeta,
        slippage: number = 0.05,
        retries: number,
        priority?: trade.PriorityLevel
    ): Promise<String | undefined> {
        let buy_attempts = retries;
        let bought = false;
        while (buy_attempts > 0 && !bought) {
            try {
                return await this.buy_token(sol_amount, buyer, mint_meta, slippage, priority);
            } catch (e) {
                common.error(common.red(`Failed to buy the token, retrying... ${e}`));
                buy_attempts--;
                await common.sleep(3000);
            }
            return;
        }
    }

    public static async sell_token(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: PumpMintMeta,
        slippage: number = 0.05,
        priority: trade.PriorityLevel
    ): Promise<String> {
        const amm = this.get_raydium_amm(mint_meta);
        if (!amm) {
            return this.sell_token_pump(token_amount, seller, mint_meta, slippage, priority);
        } else {
            const mint = new PublicKey(mint_meta.mint);
            return trade.swap(token_amount, seller, SOL_MINT, mint, amm, slippage);
        }
    }

    public static async sell_token_with_retry(
        seller: Signer,
        mint_meta: PumpMintMeta,
        slippage: number = 0.05,
        retries: number,
        priority: trade.PriorityLevel
    ): Promise<String | undefined> {
        let sell_attempts = retries;
        while (sell_attempts > 0) {
            try {
                const balance = await trade.get_token_balance(seller.publicKey, new PublicKey(mint_meta.token_mint));
                if (balance.uiAmount === 0 || balance.uiAmount === null) {
                    common.log(`No tokens yet to sell for mint ${mint_meta.token_mint}, waiting...`);
                    sell_attempts--;
                    await common.sleep(3000);
                    continue;
                }
                return await this.sell_token(balance, seller, mint_meta, slippage, priority);
            } catch (e) {
                common.error(common.red(`Error selling the token, retrying... ${e}`));
                sell_attempts--;
                await common.sleep(1000);
            }
        }
        return;
    }

    public static async get_mint_meta(mint: PublicKey): Promise<PumpMintMeta | undefined> {
        try {
            const sol_price = await common.fetch_sol_price();
            let mint_meta = await this.init_mint_meta(mint, sol_price);
            mint_meta = await this.update_mint_meta(mint_meta, sol_price);

            return mint_meta;
        } catch (error) {
            common.error(`[ERROR] Failed to fetch the mint metadata: ${error}`);
            return undefined;
        }
    }

    public static async get_random_mints(count: number): Promise<PumpMintMeta[]> {
        const limit = 50;
        const offset = Array.from({ length: 20 }, (_, i) => i * limit).sort(() => 0.5 - Math.random())[0];
        return fetch(
            `${PUMP_FETCH_API_URL}/coins?offset=${offset}&limit=${limit}&sort=last_trade_timestamp&order=DESC&includeNsfw=false`
        )
            .then((response) => response.json())
            .then((data: any) => {
                if (!data || data.statusCode !== undefined) return [];
                const shuffled = data.sort(() => 0.5 - Math.random());
                return shuffled
                    .slice(0, count)
                    .map((item: any) => {
                        return new PumpMintMeta(item);
                    })
                    .filter((i: PumpMintMeta) => !i.raydium_pool);
            })
            .catch((err) => {
                common.error(`[ERROR] Failed fetching the mints: ${err}`);
                return [];
            });
    }

    public static async create_token(
        creator: Signer,
        meta: common.IPFSMetadata,
        cid: string,
        mint?: Keypair,
        sol_amount?: number
    ): Promise<[String, PublicKey]> {
        if (!mint) mint = Keypair.generate();

        let instructions = await this.get_create_token_instructions(creator, meta, cid, mint);

        if (sol_amount && sol_amount > 0) {
            const token_meta = new PumpMintMeta({
                mint: mint.publicKey.toString(),
                bonding_curve: instructions[0].keys[2].pubkey.toString(),
                associated_bonding_curve: instructions[0].keys[3].pubkey.toString(),
                market_cap: 27.95,
                total_supply: BigInt(1_000_000_000_000_000) // 1 * 10**9 * 10**6
            });
            const buy_instructions = await this.get_buy_token_instructions(sol_amount, creator, token_meta, 0.05);
            instructions = instructions.concat(buy_instructions);
        }

        const sig = await trade.create_and_send_smart_tx(instructions, [creator, mint]);
        return [sig, mint.publicKey];
    }

    public static async init_mint_meta(mint: PublicKey, sol_price: number): Promise<PumpMintMeta> {
        const [bonding] = this.calc_token_bonding_curve(mint);
        const [assoc_bonding] = this.calc_token_assoc_bonding_curve(mint, bonding);
        const meta = await trade.get_token_meta(mint);

        return new PumpMintMeta({
            mint: mint.toString(),
            symbol: meta.token_symbol,
            name: meta.token_name,
            raydium_pool: null,
            bonding_curve: bonding.toString(),
            associated_bonding_curve: assoc_bonding.toString(),
            market_cap: 27.958993535,
            usd_market_cap: 27.958993535 * sol_price,
            virtual_sol_reserves: BigInt(30000000030),
            virtual_token_reserves: BigInt(1072999999000001),
            total_supply: BigInt(1000000000000000)
        });
    }

    public static async buy_sell_bundle(
        sol_amount: number,
        trader: Signer,
        mint_meta: PumpMintMeta,
        tip: number,
        slippage: number = 0.05,
        priority?: trade.PriorityLevel
    ): Promise<String> {
        let buy_instructions = await this.get_buy_token_instructions(sol_amount, trader, mint_meta, slippage);
        const token_amount = this.get_token_amount_raw(sol_amount, mint_meta);
        let sell_instructions = await this.get_sell_token_instructions(
            {
                uiAmount: token_amount / 10 ** PUMP_CURVE_TOKEN_DECIMALS,
                amount: token_amount.toString(),
                decimals: 9
            },
            trader,
            mint_meta,
            slippage
        );

        if (priority) {
            const fee = await trade.get_priority_fee({
                priority_level: priority,
                accounts: [PUMP_TRADE_PROGRAM_ID.toString()]
            });
            buy_instructions.unshift(
                ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: fee
                })
            );
            sell_instructions.unshift(
                ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: fee
                })
            );
        }

        return await trade.create_and_send_bundle([buy_instructions, sell_instructions], [trader], tip);
    }

    public static async update_mint_meta(mint_meta: PumpMintMeta, sol_price: number): Promise<PumpMintMeta> {
        try {
            const amm = await trade.get_raydium_amm_from_mint(new PublicKey(mint_meta.mint));
            mint_meta.raydium_pool = amm ? amm.toString() : null;
            if (!mint_meta.raydium_pool) {
                const curve_state = await this.get_curve_state(new PublicKey(mint_meta.bonding_curve));
                if (!curve_state) throw new Error('Curve state not found.');

                const token_price_sol = this.calculate_curve_price(
                    curve_state.virtual_sol_reserves,
                    curve_state.virtual_token_reserves
                );

                const token_mc = this.calculate_token_mc(sol_price, token_price_sol, curve_state.token_total_supply);

                return new PumpMintMeta({
                    ...mint_meta,
                    usd_market_cap: token_mc.usd_mc,
                    market_cap: token_mc.sol_mc,
                    total_supply: curve_state.token_total_supply,
                    virtual_token_reserves: curve_state.virtual_token_reserves,
                    virtual_sol_reserves: curve_state.virtual_sol_reserves,
                    complete: curve_state.complete
                });
            } else {
                const metrics = await trade.get_raydium_token_metrics(new PublicKey(mint_meta.raydium_pool));
                return new PumpMintMeta({
                    ...mint_meta,
                    usd_market_cap: metrics.mcap_sol * sol_price,
                    market_cap: metrics.mcap_sol
                });
            }
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Failed to update mint meta reserves: ${error.message}`);
            }
            throw new Error(`Failed to update mint meta reserves: ${error}`);
        }
    }

    private static async buy_token_pump(
        sol_amount: number,
        buyer: Signer,
        mint_meta: PumpMintMeta,
        slippage: number = 0.05,
        priority?: trade.PriorityLevel
    ): Promise<String> {
        let instructions = await this.get_buy_token_instructions(sol_amount, buyer, mint_meta, slippage);
        if (priority) {
            return await trade.create_and_send_tx(instructions, [buyer], {
                priority_level: priority,
                accounts: [PUMP_TRADE_PROGRAM_ID.toString()]
            });
        } else {
            return await trade.create_and_send_smart_tx(instructions, [buyer]);
        }
    }

    private static async sell_token_pump(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: Partial<PumpMintMeta>,
        slippage: number = 0.05,
        priority: trade.PriorityLevel
    ): Promise<String> {
        let instructions = await this.get_sell_token_instructions(token_amount, seller, mint_meta, slippage);

        if (priority) {
            return await trade.create_and_send_tx(instructions, [seller], {
                priority_level: priority,
                accounts: [PUMP_TRADE_PROGRAM_ID.toString()]
            });
        } else {
            return await trade.create_and_send_smart_tx(instructions, [seller]);
        }
    }

    private static get_raydium_amm(mint_meta: PumpMintMeta): PublicKey | undefined {
        if (mint_meta.raydium_pool !== null) return new PublicKey(mint_meta.raydium_pool);
    }

    private static get_token_amount_raw(sol_amount: number, token: Partial<PumpMintMeta>): number {
        if (!token.virtual_sol_reserves || !token.virtual_token_reserves) return 0;
        const token_price = this.calculate_curve_price(token.virtual_sol_reserves, token.virtual_token_reserves);
        return Math.round((sol_amount / token_price) * 10 ** PUMP_CURVE_TOKEN_DECIMALS);
    }

    private static get_solana_amount_raw(token_amount: number, token: Partial<PumpMintMeta>): number {
        if (!token.virtual_sol_reserves || !token.virtual_token_reserves) return 0;
        const token_price = this.calculate_curve_price(token.virtual_sol_reserves, token.virtual_token_reserves);
        return token_amount * token_price;
    }

    private static calc_slippage_up(sol_amount: number, slippage: number): number {
        const lamports = sol_amount * LAMPORTS_PER_SOL;
        return Math.round(lamports * (1 + slippage));
    }

    private static calc_slippage_down(sol_amount: number, slippage: number): number {
        if (slippage >= 1) throw new RangeError('Slippage must be less than 1');
        const lamports = sol_amount * LAMPORTS_PER_SOL;
        return Math.round(lamports * (1 - slippage));
    }

    private static buy_data(sol_amount: number, token_amount: number, slippage: number): Buffer {
        const instruction_buf = Buffer.from('66063d1201daebea', 'hex');
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(BigInt(token_amount), 0);
        const slippage_buf = Buffer.alloc(8);
        slippage_buf.writeBigUInt64LE(BigInt(this.calc_slippage_up(sol_amount, slippage)), 0);
        return Buffer.concat([instruction_buf, token_amount_buf, slippage_buf]);
    }

    private static sell_data(sol_amount: number, token_amount: number, slippage: number): Buffer {
        const instruction_buf = Buffer.from('33e685a4017f83ad', 'hex');
        const token_amount_buf = Buffer.alloc(8);
        token_amount_buf.writeBigUInt64LE(BigInt(token_amount), 0);
        const slippage_buf = Buffer.alloc(8);
        slippage_buf.writeBigUInt64LE(BigInt(this.calc_slippage_down(sol_amount, slippage)), 0);
        return Buffer.concat([instruction_buf, token_amount_buf, slippage_buf]);
    }

    private static async get_buy_token_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: Partial<PumpMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (!mint_meta.mint || !mint_meta.bonding_curve || !mint_meta.associated_bonding_curve) {
            throw new Error(`Failed to get the mint meta.`);
        }

        const mint = new PublicKey(mint_meta.mint);
        const bonding_curve = new PublicKey(mint_meta.bonding_curve);
        const assoc_bonding_curve = new PublicKey(mint_meta.associated_bonding_curve);

        const token_amount = this.get_token_amount_raw(sol_amount, mint_meta);
        const instruction_data = this.buy_data(sol_amount, token_amount, slippage);
        const assoc_address = await trade.calc_assoc_token_addr(buyer.publicKey, mint);
        const exists = await trade.check_account_exists(assoc_address);
        // TODO: Create account in advance
        // TODO: Make a transfer to bloxroute for obfuscation

        let instructions: TransactionInstruction[] = [];
        if (!exists) {
            instructions.push(
                createAssociatedTokenAccountInstruction(buyer.publicKey, assoc_address, buyer.publicKey, mint)
            );
        }
        instructions.push(
            new TransactionInstruction({
                keys: [
                    { pubkey: PUMP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_FEE_RECIPIENT_ACCOUNT, isSigner: false, isWritable: true },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: assoc_address, isSigner: false, isWritable: true },
                    { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: RENT_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: PUMP_EVENT_AUTHORITUY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_TRADE_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: PUMP_TRADE_PROGRAM_ID,
                data: instruction_data
            })
        );

        return instructions;
    }

    private static async get_sell_token_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: Partial<PumpMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
        if (!mint_meta.mint || !mint_meta.bonding_curve || !mint_meta.associated_bonding_curve) {
            throw new Error(`Failed to get the mint meta.`);
        }

        const mint = new PublicKey(mint_meta.mint);
        const bonding_curve = new PublicKey(mint_meta.bonding_curve);
        const assoc_bonding_curve = new PublicKey(mint_meta.associated_bonding_curve);

        if (token_amount.uiAmount === null) throw new Error(`Failed to get the token amount.`);
        const token_amount_raw = parseInt(token_amount.amount);
        if (isNaN(token_amount_raw)) throw new Error(`Failed to parse the token amount.`);

        const sol_amount = this.get_solana_amount_raw(token_amount.uiAmount, mint_meta);
        const instruction_data = this.sell_data(sol_amount, token_amount_raw, slippage);
        const assoc_address = await trade.calc_assoc_token_addr(seller.publicKey, mint);

        let instructions: TransactionInstruction[] = [];
        instructions.push(
            new TransactionInstruction({
                keys: [
                    { pubkey: PUMP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_FEE_RECIPIENT_ACCOUNT, isSigner: false, isWritable: true },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
                    { pubkey: assoc_address, isSigner: false, isWritable: true },
                    { pubkey: seller.publicKey, isSigner: true, isWritable: true },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: PUMP_EVENT_AUTHORITUY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_TRADE_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: PUMP_TRADE_PROGRAM_ID,
                data: instruction_data
            })
        );

        return instructions;
    }

    private static create_data(token_name: string, token_ticker: string, meta_link: string): Buffer {
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

    private static async get_create_token_instructions(
        creator: Signer,
        meta: common.IPFSMetadata,
        cid: string,
        mint: Keypair
    ): Promise<TransactionInstruction[]> {
        const meta_link = `${IPFS}${cid}`;
        const instruction_data = this.create_data(meta.name, meta.symbol, meta_link);
        const [bonding] = this.calc_token_bonding_curve(mint.publicKey);
        const [assoc_bonding] = this.calc_token_assoc_bonding_curve(mint.publicKey, bonding);
        const [metaplex] = PublicKey.findProgramAddressSync(
            [PUMP_META_ADDR, METAPLEX_PROGRAM_ID.toBuffer(), mint.publicKey.toBuffer()],
            METAPLEX_PROGRAM_ID
        );

        let instructions: TransactionInstruction[] = [];
        instructions.push(
            new TransactionInstruction({
                keys: [
                    { pubkey: mint.publicKey, isSigner: true, isWritable: true },
                    { pubkey: PUMP_MINT_AUTHORITY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: bonding, isSigner: false, isWritable: true },
                    { pubkey: assoc_bonding, isSigner: false, isWritable: true },
                    { pubkey: PUMP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: METAPLEX_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: metaplex, isSigner: false, isWritable: true },
                    { pubkey: creator.publicKey, isSigner: true, isWritable: true },
                    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: RENT_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: PUMP_EVENT_AUTHORITUY_ACCOUNT, isSigner: false, isWritable: false },
                    { pubkey: PUMP_TRADE_PROGRAM_ID, isSigner: false, isWritable: false }
                ],
                programId: PUMP_TRADE_PROGRAM_ID,
                data: instruction_data
            })
        );

        return instructions;
    }

    private static calc_token_bonding_curve(mint: PublicKey): [PublicKey, number] {
        return PublicKey.findProgramAddressSync([PUMP_BONDING_ADDR, mint.toBuffer()], PUMP_TRADE_PROGRAM_ID);
    }

    private static calc_token_assoc_bonding_curve(mint: PublicKey, bonding: PublicKey): [PublicKey, number] {
        return PublicKey.findProgramAddressSync(
            [bonding.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
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

    private static calculate_token_mc(
        sol_price: number,
        token_price_sol: number,
        token_total_supply: bigint
    ): { sol_mc: number; usd_mc: number } {
        const sol_mc = (token_price_sol * Number(token_total_supply)) / 10 ** PUMP_CURVE_TOKEN_DECIMALS;
        const usd_mc = sol_mc * sol_price;
        return { sol_mc, usd_mc };
    }

    private static async get_curve_state(bond_curve_addr: PublicKey): Promise<CurveState> {
        const acc_info = await global.CONNECTION.getAccountInfo(bond_curve_addr, COMMITMENT);
        if (
            !acc_info ||
            !acc_info.data ||
            acc_info.data.byteLength < PUMP_CURVE_STATE_SIGNATURE.byteLength + CURVE_STATE_SIZE
        ) {
            throw new Error('unexpected curve state');
        }

        const idl_signature = common.read_bytes(acc_info.data, 0, PUMP_CURVE_STATE_SIGNATURE.byteLength);
        if (idl_signature.compare(PUMP_CURVE_STATE_SIGNATURE) !== 0) {
            throw new Error('unexpected curve state IDL signature');
        }

        return {
            virtual_token_reserves: common.read_biguint_le(
                acc_info.data,
                CURVE_STATE_OFFSETS.VIRTUAL_TOKEN_RESERVES,
                8
            ),
            virtual_sol_reserves: common.read_biguint_le(acc_info.data, CURVE_STATE_OFFSETS.VIRTUAL_SOL_RESERVES, 8),
            real_token_reserves: common.read_biguint_le(acc_info.data, CURVE_STATE_OFFSETS.REAL_TOKEN_RESERVES, 8),
            real_sol_reserves: common.read_biguint_le(acc_info.data, CURVE_STATE_OFFSETS.REAL_SOL_RESERVES, 8),
            token_total_supply: common.read_biguint_le(acc_info.data, CURVE_STATE_OFFSETS.TOKEN_TOTAL_SUPPLY, 8),
            complete: common.read_bool(acc_info.data, CURVE_STATE_OFFSETS.COMPLETE, 1)
        };
    }
}
