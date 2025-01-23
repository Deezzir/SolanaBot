import { FixedSide } from '@wen-moon-ser/moonshot-sdk';
import { LAMPORTS_PER_SOL, PublicKey, Signer, TokenAmount, TransactionInstruction, Keypair } from '@solana/web3.js';
import * as trade from '../common/trade_common.js';
import * as common from '../common/common.js';

const MOONSHOT_TRADE_PROGRAM_ID = new PublicKey('MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG');

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
        return 'Moonshot';
    }

    public static async buy_token(
        sol_amount: number,
        buyer: Signer,
        mint_meta: MoonshotMintMeta,
        slippage: number = 0.05,
        priority?: trade.PriorityLevel
    ): Promise<String> {
        const amm = this.get_raydium_amm(mint_meta);
        if (!amm) {
            return this.buy_token_moon(sol_amount, buyer, mint_meta, slippage, priority);
        } else {
            const sol_token_amount = trade.get_sol_token_amount(sol_amount);
            const mint = new PublicKey(mint_meta.baseToken.address);
            return trade.swap(sol_token_amount, buyer, mint, trade.SOL_MINT, amm, slippage);
        }
    }

    public static async buy_token_with_retry(
        sol_amount: number,
        buyer: Signer,
        mint_meta: MoonshotMintMeta,
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
        mint_meta: MoonshotMintMeta,
        slippage: number = 0.05,
        priority?: trade.PriorityLevel
    ): Promise<String> {
        const amm = this.get_raydium_amm(mint_meta);
        if (!amm) {
            return this.sell_token_moon(token_amount, seller, mint_meta, slippage, priority);
        } else {
            const mint = new PublicKey(mint_meta.baseToken.address);
            return trade.swap(token_amount, seller, trade.SOL_MINT, mint, amm, slippage);
        }
    }

    public static async sell_token_with_retry(
        seller: Signer,
        mint_meta: MoonshotMintMeta,
        slippage: number = 0.05,
        retries: number,
        priority?: trade.PriorityLevel
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

    public static async get_mint_meta(mint: PublicKey): Promise<MoonshotMintMeta | undefined> {
        return fetch(`https://api.moonshot.cc/token/v1/solana/${mint.toString()}`)
            .then((response) => response.json())
            .then((data) => {
                if (!data || data.statusCode !== undefined || data.error || !isMoonMeta(data)) return;
                return new MoonshotMintMeta(data);
            })
            .catch((err) => {
                common.error(`[ERROR] Failed fetching the mint: ${err}`);
                return undefined;
            });
    }

    public static async get_random_mints(_count: number): Promise<MoonshotMintMeta[]> {
        throw new Error('Not Implemented');
    }

    public static async create_token(
        _creator: Signer,
        _meta: common.IPFSMetadata,
        _cid: string,
        _mint?: Keypair,
        _sol_amount?: number
    ): Promise<[String, PublicKey]> {
        throw new Error('Not implemented');
    }

    public static async init_mint_meta(_mint: PublicKey, _sol_price: number): Promise<MoonshotMintMeta> {
        throw new Error('Not Implemented');
    }

    public static async update_mint_meta_reserves(
        _mint_meta: MoonshotMintMeta,
        _sol_price: number
    ): Promise<MoonshotMintMeta> {
        throw new Error('Not Implemented');
    }

    private static get_raydium_amm(mint_meta: MoonshotMintMeta): PublicKey | undefined {
        if (mint_meta.dexId === 'raydium') return new PublicKey(mint_meta.pairAddress);
    }

    private static async buy_token_moon(
        sol_amount: number,
        buyer: Signer,
        mint_meta: MoonshotMintMeta,
        slippage: number = 0.05,
        priority?: trade.PriorityLevel
    ): Promise<String> {
        let instructions = await this.get_buy_token_instructions(sol_amount, buyer, mint_meta, slippage);
        if (priority) {
            return await trade.create_and_send_tx(instructions, [buyer], {
                priority_level: priority,
                accounts: [MOONSHOT_TRADE_PROGRAM_ID.toString()]
            });
        } else {
            return await trade.create_and_send_smart_tx(instructions, [buyer]);
        }
    }

    private static async sell_token_moon(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: Partial<MoonshotMintMeta>,
        slippage: number = 0.05,
        priority?: trade.PriorityLevel
    ): Promise<String> {
        let instructions = await this.get_sell_token_instructions(token_amount, seller, mint_meta, slippage);
        if (priority) {
            return await trade.create_and_send_tx(instructions, [seller], {
                priority_level: priority,
                accounts: [MOONSHOT_TRADE_PROGRAM_ID.toString()]
            });
        } else {
            return await trade.create_and_send_smart_tx(instructions, [seller]);
        }
    }

    private static async get_sell_token_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: Partial<MoonshotMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
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

        return ixs;
    }

    private static async get_buy_token_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: Partial<MoonshotMintMeta>,
        slippage: number = 0.05
    ): Promise<TransactionInstruction[]> {
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

        return ixs;
    }
}
