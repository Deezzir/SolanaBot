import { FixedSide } from '@wen-moon-ser/moonshot-sdk';
import {
    LAMPORTS_PER_SOL,
    PublicKey,
    Signer,
    TokenAmount,
    TransactionInstruction,
    Keypair,
    AddressLookupTableAccount
} from '@solana/web3.js';
import { PriorityLevel, SOL_MINT, TRADE_RAYDIUM_SWAP_TAX } from '../constants.js';
import * as trade from '../common/trade_common.js';
import * as common from '../common/common.js';
import { swap_raydium_instructions } from '../common/trade_dex.js';

class MoonshotMintMeta implements trade.IMintMeta {
    url: string = '';
    chainId: string = '';
    dexId: string = '';
    pairAddress: string = '';
    baseToken: {
        address: string;
        name: string;
        symbol: string;
    } = {
            address: '',
            name: '',
            symbol: ''
        };
    priceNative: string = '';
    priceUsd: string = '';
    quoteToken: {
        address: string;
        name: string;
        symbol: string;
    } = {
            address: '',
            name: '',
            symbol: ''
        };
    profile: {
        icon: string;
        banner: string;
        links: string[];
        description: string;
    } = {
            icon: '',
            banner: '',
            links: [],
            description: ''
        };
    fdv: number = 0;
    marketCap: number = 0;
    createdAt: number = Date.now();
    moonshot: {
        progress: number;
        creator: number;
        curveType: string;
        curvePosition: string;
        marketcapThreshold: string;
    } = {
            progress: 0,
            creator: 0,
            curveType: '',
            curvePosition: '',
            marketcapThreshold: ''
        };
    fee: number = TRADE_RAYDIUM_SWAP_TAX;

    constructor(data: Partial<MoonshotMintMeta> = {}) {
        Object.assign(this, data);
    }

    public get token_name(): string {
        return this.baseToken.name;
    }

    public get token_mint(): string {
        return this.baseToken.address;
    }

    public get token_symbol(): string {
        return this.baseToken.symbol;
    }

    public get token_usd_mc(): number {
        return this.marketCap;
    }

    public get migrated(): boolean {
        return this.dexId && this.dexId !== '' ? true : false;
    }

    public get platform_fee(): number {
        return this.fee;
    }

    public get mint_pubkey(): PublicKey {
        return new PublicKey(this.baseToken.address);
    }
}

function isMoonMeta(obj: any): obj is MoonshotMintMeta {
    return (
        typeof obj === 'object' &&
        obj !== null &&
        typeof obj.moonshot === 'object' &&
        typeof obj.chainId === 'string' &&
        typeof obj.pairAddress === 'string' &&
        typeof obj.dexId === 'string' &&
        typeof obj.baseToken === 'object' &&
        typeof obj.marketCap === 'number'
    );
}

@common.staticImplements<trade.IProgramTrader>()
export class Trader {
    public static get_name(): string {
        return common.Program.Moonit;
    }

    public static async buy_token(
        sol_amount: number,
        buyer: Signer,
        mint_meta: MoonshotMintMeta,
        slippage: number = 0.05,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<String> {
        const [instructions, address_lt_accounts] = await this.buy_token_instructions(
            sol_amount,
            buyer,
            mint_meta,
            slippage
        );
        return await trade.send_tx(instructions, [buyer], priority, protection_tip, address_lt_accounts);
    }

    public static async buy_token_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: MoonshotMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const amm = this.get_raydium_amm(mint_meta);
        if (!amm) {
            return this.get_buy_token_instructions(sol_amount, buyer, mint_meta, slippage);
        } else {
            const sol_token_amount = trade.get_sol_token_amount(sol_amount);
            return swap_raydium_instructions(sol_token_amount, buyer, amm, SOL_MINT, slippage);
        }
    }

    public static async sell_token(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: MoonshotMintMeta,
        slippage: number = 0.05,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<String> {
        const [instructions, address_lt_accounts] = await this.sell_token_instructions(
            token_amount,
            seller,
            mint_meta,
            slippage
        );
        return await trade.send_tx(instructions, [seller], priority, protection_tip, address_lt_accounts);
    }

    public static async sell_token_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: MoonshotMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const amm = this.get_raydium_amm(mint_meta);
        if (!amm) {
            return this.get_sell_token_instructions(token_amount, seller, mint_meta, slippage);
        } else {
            const mint = new PublicKey(mint_meta.baseToken.address);
            return swap_raydium_instructions(token_amount, seller, amm, mint, slippage);
        }
    }

    public static async buy_sell_instructions(
        _sol_amount: number,
        _trader: Signer,
        _mint_meta: MoonshotMintMeta,
        _slippage: number = 0.05
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]> {
        throw new Error('Not implemented');
    }

    public static async buy_sell_bundle(
        _sol_amount: number,
        _trader: Signer,
        _mint_meta: MoonshotMintMeta,
        _tip: number,
        _slippage: number = 0.05,
        _priority?: PriorityLevel
    ): Promise<String> {
        throw new Error('Not implemented');
    }

    public static async buy_sell(
        _sol_amount: number,
        _trader: Signer,
        _mint_meta: MoonshotMintMeta,
        _interval_ms: number,
        _slippage: number = 0.05,
        _priority?: PriorityLevel,
        _protection_tip?: number
    ): Promise<[String, String]> {
        throw new Error('Not implemented');
    }

    public static async get_mint_meta(mint: PublicKey, _sol_price: number): Promise<MoonshotMintMeta | undefined> {
        return fetch(`https://api.moonshot.cc/token/v1/solana/${mint.toString()}`)
            .then((response) => response.json())
            .then((data) => {
                if (!data || data.statusCode !== undefined || data.error || !isMoonMeta(data)) return;
                return new MoonshotMintMeta(data);
            })
            .catch(() => {
                return undefined;
            });
    }

    public static async get_random_mints(_count: number): Promise<MoonshotMintMeta[]> {
        throw new Error('Not Implemented');
    }

    public static async create_token(
        _mint: Keypair,
        _creator: Signer,
        _token_name: string,
        _token_symbol: string,
        _meta_cid: string,
        _sol_amount: number = 0,
        _traders?: [Signer, number][],
        _bundle_tip?: number,
        _priority?: PriorityLevel
    ): Promise<String> {
        throw new Error('Not implemented');
    }

    public static async create_token_metadata(_meta: common.IPFSMetadata, _image_path: string): Promise<string> {
        throw new Error('Not implemented');
    }

    public static async default_mint_meta(_mint: PublicKey, _sol_price: number): Promise<MoonshotMintMeta> {
        throw new Error('Not Implemented');
    }

    public static update_mint_meta_reserves(
        _mint_meta: MoonshotMintMeta,
        _amount: number | TokenAmount
    ): MoonshotMintMeta {
        throw new Error('Not Implemented');
    }

    public static async update_mint_meta(_mint_meta: MoonshotMintMeta, _sol_price: number): Promise<MoonshotMintMeta> {
        throw new Error('Not Implemented');
    }

    private static get_raydium_amm(mint_meta: MoonshotMintMeta): PublicKey | undefined {
        if (mint_meta.dexId === 'raydium') return new PublicKey(mint_meta.pairAddress);
    }

    private static async get_sell_token_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: Partial<MoonshotMintMeta>,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        if (!mint_meta.baseToken || !mint_meta.baseToken.address || !mint_meta.priceNative) {
            throw new Error(`Failed to get the mint meta.`);
        }

        const token = global.MOONSHOT.Token({
            mintAddress: mint_meta.baseToken.address
        });
        const raw_slippage = slippage * 1000;
        const curve_pos = await token.getCurvePosition();
        const token_amount_raw = BigInt(token_amount.amount);

        const collateral_amount = await token.getCollateralAmountByTokens({
            tokenAmount: token_amount_raw,
            tradeDirection: 'SELL',
            curvePosition: curve_pos
        });

        const { ixs } = await token.prepareIxs({
            slippageBps: raw_slippage,
            creatorPK: seller.publicKey.toBase58(),
            tokenAmount: token_amount_raw,
            collateralAmount: collateral_amount,
            tradeDirection: 'SELL',
            fixedSide: FixedSide.IN
        });

        return [ixs, undefined];
    }

    private static async get_buy_token_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: Partial<MoonshotMintMeta>,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        if (!mint_meta.baseToken || !mint_meta.baseToken.address || !mint_meta.priceNative) {
            throw new Error(`Failed to get the mint meta.`);
        }

        const token = global.MOONSHOT.Token({
            mintAddress: mint_meta.baseToken.address
        });
        const raw_slippage = slippage * 1000;
        const curve_pos = await token.getCurvePosition();
        const collateral_amount = BigInt(sol_amount * LAMPORTS_PER_SOL);

        const token_amount = await token.getTokenAmountByCollateral({
            collateralAmount: collateral_amount,
            tradeDirection: 'BUY',
            curvePosition: curve_pos
        });

        const { ixs } = await token.prepareIxs({
            creatorPK: buyer.publicKey.toBase58(),
            tokenAmount: token_amount,
            collateralAmount: collateral_amount,
            tradeDirection: 'BUY',
            fixedSide: FixedSide.OUT,
            slippageBps: raw_slippage
        });

        return [ixs, undefined];
    }
}
