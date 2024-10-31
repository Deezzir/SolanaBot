import { FixedSide } from '@wen-moon-ser/moonshot-sdk';
import { LAMPORTS_PER_SOL, PublicKey, Signer, TokenAmount, TransactionInstruction } from '@solana/web3.js';
import * as trade_common from './trade_common.js';
import * as common from './common.js'

const MOONSHOT_TRADE_PROGRAM_ID = new PublicKey('MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG');

export interface MoonshotTokenMeta {
    url: string;
    chainId: string;
    dexId: string;
    pairAddress: string;
    baseToken: {
      address: string;
      name: string;
      symbol: string;
    }
    priceNative: string;
    priceUsd: string;
    quoteToken: {
      address: string;
      name: string;
      symbol: string;
    };
    profile: {
      icon: string;
      banner: string;
      links: string[];
      decription: string;
    };
    fdv: number;
    marketCap: number;
    createdAt: number;
    moonshot: {
      progress: number;
      creator: number;
      curveType: string;
      curvePosition: string;
      marketcapThreshold: string;
    },
}

export function is_moonshot_meta(obj: any): obj is MoonshotTokenMeta {
    return (
        typeof obj === 'object' &&
        obj !== null &&
        typeof obj.moonshot === 'object' &&
        typeof obj.chainId === 'string' &&
        typeof obj.pairAddress === 'string' &&
        typeof obj.dexId === 'string' &&
        typeof obj.baseToken === 'object' &&
        typeof obj.marketCap === 'number'
    )
}

export async function fetch_mint(mint: string): Promise<MoonshotTokenMeta> {
    return fetch(`https://api.moonshot.cc/token/v1/solana/${mint}`)
    .then(response => response.json())
        .then(data => {
            if (!data || data.statusCode !== undefined || data.error) return {} as MoonshotTokenMeta;
            return data as MoonshotTokenMeta;
        })
        .catch(err => {
            console.error(`[ERROR] Failed fetching the mint: ${err}`);
            return {} as MoonshotTokenMeta;
        });
}

async function get_buy_token_instructions(
    sol_amount: number, buyer: Signer, mint_meta: Partial<MoonshotTokenMeta>, slippage: number = 0.05
): Promise<TransactionInstruction[]> {
    if (!mint_meta.baseToken || !mint_meta.baseToken.address || !mint_meta.priceNative) {
        throw new Error(`[ERROR]: Failed to get the mint meta.`);
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

    const {ixs} = await token.prepareIxs({
        creatorPK: buyer.publicKey.toBase58(),
        tokenAmount: token_amount,
        collateralAmount: collateral_amount,
        tradeDirection: 'BUY',
        fixedSide: FixedSide.OUT,
        slippageBps: raw_slippage
    });

    return ixs;
}

export async function buy_token(
    sol_amount: number, buyer: Signer, mint_meta: MoonshotTokenMeta, slippage: number = 0.05,
    priority?: common.PriorityLevel
): Promise<String> {
    let instructions = await get_buy_token_instructions(sol_amount, buyer, mint_meta, slippage);
    if (priority) {
        return await trade_common.create_and_send_tx(
            instructions, [buyer],
            { priority_level: priority, accounts: [MOONSHOT_TRADE_PROGRAM_ID.toString()] }
        );
    } else {
        return await trade_common.create_and_send_smart_tx(instructions, [buyer]);
    }
}

async function get_sell_token_instructions(
    token_amount: TokenAmount, seller: Signer, mint_meta: Partial<MoonshotTokenMeta>, slippage: number = 0.05
): Promise<TransactionInstruction[]> {
    if (!mint_meta.baseToken || !mint_meta.baseToken.address || !mint_meta.priceNative) {
        throw new Error(`[ERROR]: Failed to get the mint meta.`);
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
        fixedSide: FixedSide.IN,
      });

    return ixs;
}

export async function sell_token(
    token_amount: TokenAmount, seller: Signer, mint_meta: Partial<MoonshotTokenMeta>,
    slippage: number = 0.05, priority?: common.PriorityLevel
): Promise<String> {
    let instructions = await get_sell_token_instructions(token_amount, seller, mint_meta, slippage);
    if (priority) {
        return await trade_common.create_and_send_tx(
            instructions, [seller],
            { priority_level: priority, accounts: [MOONSHOT_TRADE_PROGRAM_ID.toString()] }
        );
    } else {
        return await trade_common.create_and_send_smart_tx(instructions, [seller]);
    }
}
