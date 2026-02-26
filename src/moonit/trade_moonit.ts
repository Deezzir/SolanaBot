import {
    PublicKey,
    Signer,
    TokenAmount,
    TransactionInstruction,
    Keypair,
    AddressLookupTableAccount
} from '@solana/web3.js';
import { PriorityLevel, SOL_MINT, TRADE_RAYDIUM_SWAP_TAX } from '../constants';
import * as trade from '../common/trade_common';
import * as common from '../common/common';
import { swap_raydium_instructions } from '../common/trade_dex';

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
    token_program_id!: string;

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

    public get token_program(): PublicKey {
        return new PublicKey(this.token_program_id);
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

export class Trader implements trade.IProgramTrader {
    public get_name(): string {
        return common.Program.Moonit;
    }

    public async buy_token(
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

    public async buy_token_instructions(
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

    public async sell_token(
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

    public async sell_token_instructions(
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

    public async buy_sell_instructions(
        _sol_amount: number,
        _trader: Signer,
        _mint_meta: MoonshotMintMeta,
        _slippage: number = 0.05
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]> {
        throw new Error('Not implemented');
    }

    public async buy_sell_bundle(
        _sol_amount: number,
        _trader: Signer,
        _mint_meta: MoonshotMintMeta,
        _tip: number,
        _slippage: number = 0.05,
        _priority?: PriorityLevel
    ): Promise<String> {
        throw new Error('Not implemented');
    }

    public async buy_sell(
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

    public async get_mint_meta(mint: PublicKey, _sol_price: number): Promise<MoonshotMintMeta | undefined> {
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

    public async get_random_mints(_count: number): Promise<MoonshotMintMeta[]> {
        throw new Error('Not Implemented');
    }

    public async create_token(
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

    public async create_token_metadata(_meta: common.IPFSMetadata, _image_path: string): Promise<string> {
        throw new Error('Not implemented');
    }

    public async default_mint_meta(_mint: PublicKey, _sol_price: number): Promise<MoonshotMintMeta> {
        throw new Error('Not Implemented');
    }

    public update_mint_meta_reserves(_mint_meta: MoonshotMintMeta, _amount: number | TokenAmount): MoonshotMintMeta {
        throw new Error('Not Implemented');
    }

    public async update_mint_meta(_mint_meta: MoonshotMintMeta, _sol_price: number): Promise<MoonshotMintMeta> {
        throw new Error('Not Implemented');
    }

    private get_raydium_amm(mint_meta: MoonshotMintMeta): PublicKey | undefined {
        if (mint_meta.dexId === 'raydium') return new PublicKey(mint_meta.pairAddress);
    }

    private async get_sell_token_instructions(
        _token_amount: TokenAmount,
        _seller: Signer,
        mint_meta: Partial<MoonshotMintMeta>,
        _slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        if (!mint_meta.baseToken || !mint_meta.baseToken.address || !mint_meta.priceNative) {
            throw new Error(`Failed to get the mint meta.`);
        }
        throw new Error('Not Implemented');
    }

    private async get_buy_token_instructions(
        _sol_amount: number,
        _buyer: Signer,
        mint_meta: Partial<MoonshotMintMeta>,
        _slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        if (!mint_meta.baseToken || !mint_meta.baseToken.address || !mint_meta.priceNative) {
            throw new Error(`Failed to get the mint meta.`);
        }
        throw new Error('Not Implemented');
    }
}
