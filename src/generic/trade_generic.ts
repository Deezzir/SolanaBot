import {
    AddressLookupTableAccount,
    ComputeBudgetProgram,
    Keypair,
    PublicKey,
    Signer,
    TokenAmount,
    TransactionInstruction
} from '@solana/web3.js';
import * as common from '../common/common.js';
import * as trade from '../common/trade_common.js';
import {
    IPFS,
    IPFS_API,
    IPFS_JWT,
    PriorityLevel,
    SOL_MINT,
    TRADE_DEFAULT_CURVE_DECIMALS,
    TRADE_RAYDIUM_SWAP_TAX,
    TRADE_RETRY_INTERVAL_MS,
    TRADE_RETRY_ITERATIONS
} from '../constants.js';
import { quote_jupiter, swap_jupiter, swap_jupiter_instructions } from '../common/trade_dex.js';
import { readFileSync } from 'fs';
import { basename } from 'path';

type IPFSResponse = {
    id: string;
    name: string;
    cid: string;
    created_at: string;
    size: number;
    number_of_files: number;
    mime_type: string;
    user_id: string;
    group_id: string;
    is_duplicate: boolean;
};

class GenericMintMeta implements trade.IMintMeta {
    mint!: PublicKey;
    name: string = 'Unknown';
    symbol: string = 'Unknown';
    total_supply: bigint = BigInt(0);
    usd_market_cap: number = 0;
    market_cap: number = 0;
    fee: number = TRADE_RAYDIUM_SWAP_TAX;

    constructor(data: Partial<GenericMintMeta> = {}) {
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
        return this.mint;
    }
}

@common.staticImplements<trade.IProgramTrader>()
export class Trader {
    public static get_name(): string {
        return 'Generic';
    }

    public static async buy_token(
        sol_amount: number,
        buyer: Signer,
        mint_meta: GenericMintMeta,
        slippage: number = 0.05,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<String> {
        const sol_token_amount = trade.get_sol_token_amount(sol_amount);
        return await swap_jupiter(
            sol_token_amount,
            buyer,
            SOL_MINT,
            mint_meta.mint,
            slippage,
            priority,
            protection_tip
        );
    }

    public static async buy_token_instructions(
        sol_amount: number,
        buyer: Signer,
        mint_meta: GenericMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const sol_token_amount = trade.get_sol_token_amount(sol_amount);
        const quote = await quote_jupiter(sol_token_amount, SOL_MINT, mint_meta.mint, slippage);
        return await swap_jupiter_instructions(buyer, quote);
    }

    public static async sell_token(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: GenericMintMeta,
        slippage: number = 0.05,
        priority: PriorityLevel,
        protection_tip?: number
    ): Promise<String> {
        return await swap_jupiter(token_amount, seller, mint_meta.mint, SOL_MINT, slippage, priority, protection_tip);
    }

    public static async sell_token_instructions(
        token_amount: TokenAmount,
        seller: Signer,
        mint_meta: GenericMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const quote = await quote_jupiter(token_amount, mint_meta.mint, SOL_MINT, slippage);
        return await swap_jupiter_instructions(seller, quote);
    }

    public static async buy_sell_instructions(
        sol_amount: number,
        trader: Signer,
        mint_meta: GenericMintMeta,
        slippage: number = 0.05
    ): Promise<[TransactionInstruction[], TransactionInstruction[], AddressLookupTableAccount[]?]> {
        const sol_token_amount = trade.get_sol_token_amount(sol_amount);
        const quote = await quote_jupiter(sol_token_amount, SOL_MINT, mint_meta.mint, slippage);
        let [buy_instructions, ltas] = await swap_jupiter_instructions(trader, quote);
        let [sell_instructions] = await this.sell_token_instructions(
            {
                uiAmount: Number(quote.outAmount) / 10 ** TRADE_DEFAULT_CURVE_DECIMALS,
                amount: quote.outAmount,
                decimals: TRADE_DEFAULT_CURVE_DECIMALS
            },
            trader,
            mint_meta,
            slippage
        );

        return [buy_instructions, sell_instructions, ltas];
    }

    public static async buy_sell(
        sol_amount: number,
        trader: Signer,
        mint_meta: GenericMintMeta,
        interval_ms: number,
        slippage: number = 0.05,
        priority?: PriorityLevel,
        protection_tip?: number
    ): Promise<[String, String]> {
        const [buy_instructions, sell_instructions, lta_accounts] = await this.buy_sell_instructions(
            sol_amount,
            trader,
            mint_meta,
            slippage
        );

        const buy_signature = await trade.create_and_send_tx(
            buy_instructions,
            [trader],
            priority,
            protection_tip,
            lta_accounts
        );
        let sell_signature;

        if (interval_ms > 0) await common.sleep(interval_ms);

        let retries = 1;
        while (retries <= TRADE_RETRY_ITERATIONS) {
            try {
                sell_signature = await trade.create_and_send_tx(
                    sell_instructions,
                    [trader],
                    priority,
                    protection_tip,
                    lta_accounts
                );
            } catch (error) {
                common.error(common.red(`Failed to send the sell transaction, retrying...`));
                retries++;
                await common.sleep(TRADE_RETRY_INTERVAL_MS * retries * 3);
            }
        }

        if (!sell_signature) throw new Error('Failed to send the sell transaction after retries.');
        return [buy_signature, sell_signature];
    }

    public static async buy_sell_bundle(
        sol_amount: number,
        trader: Signer,
        mint_meta: GenericMintMeta,
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

        if (priority) {
            const fee = await trade.get_priority_fee({
                priority_level: priority,
                transaction: {
                    instructions: buy_instructions,
                    signers: [trader]
                }
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

        return await trade.create_and_send_bundle(
            [buy_instructions, sell_instructions],
            [[trader], [trader]],
            tip,
            ltas
        );
    }

    public static async get_mint_meta(mint: PublicKey, sol_price: number = 0): Promise<GenericMintMeta | undefined> {
        try {
            return await this.default_mint_meta(mint, sol_price);
        } catch (error) {
            return undefined;
        }
    }

    public static async get_random_mints(_count: number): Promise<GenericMintMeta[]> {
        throw new Error('Not implemented');
    }

    public static async create_token(
        _creator: Signer,
        _token_name: string,
        _token_symbol: string,
        _meta_cid: string,
        _sol_amount: number = 0,
        _mint?: Keypair
    ): Promise<[String, PublicKey]> {
        throw new Error('Token creation is not supported by Generic program');
    }

    public static async update_mint_meta(
        mint_meta: GenericMintMeta,
        sol_price: number = 0.0
    ): Promise<GenericMintMeta> {
        return this.default_mint_meta(mint_meta.mint, sol_price);
    }

    public static async default_mint_meta(mint: PublicKey, sol_price: number = 0.0): Promise<GenericMintMeta> {
        const meta = await trade.get_token_meta(mint).catch(() => {
            return {
                token_name: 'Unknown',
                token_symbol: 'Unknown',
                token_supply: 10 ** 16,
                price_per_token: 0.0,
                token_decimals: 6
            };
        });

        const usd_market_cap = meta.price_per_token * (meta.token_supply / 10 ** meta.token_decimals);
        const market_cap = sol_price ? usd_market_cap / sol_price : 0;
        return new GenericMintMeta({
            mint,
            name: meta.token_name,
            symbol: meta.token_symbol,
            total_supply: BigInt(meta.token_supply),
            usd_market_cap,
            market_cap
        });
    }

    public static async create_token_metadata(meta: common.IPFSMetadata, image_path: string): Promise<string> {
        try {
            const uuid = crypto.randomUUID();
            const image_file = new File([readFileSync(image_path)], `${uuid}-${basename(image_path)}`, {
                type: 'image/png'
            });
            const image_resp = await this.upload_ipfs(image_file);
            meta.image = `${IPFS}${image_resp.cid}`;

            const json = JSON.stringify(meta);
            const json_blob = new Blob([json]);
            const json_file = new File([json_blob], `${uuid}-metadata.json`, { type: 'application/json' });
            const meta_resp = await this.upload_ipfs(json_file);
            return meta_resp.cid;
        } catch (error) {
            throw new Error(`Failed to create metadata: ${error}`);
        }
    }

    private static async upload_ipfs(file: File): Promise<IPFSResponse> {
        const form_data = new FormData();

        form_data.append('file', file);
        form_data.append('network', 'public');
        form_data.append('name', file.name);

        const request: RequestInit = {
            method: 'POST',
            headers: { Authorization: `Bearer ${IPFS_JWT}` },
            body: form_data
        };

        try {
            const response = await fetch(IPFS_API, request);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            return data.data as IPFSResponse;
        } catch (error) {
            throw new Error(`Failed to upload to IPFS: ${error}`);
        }
    }
}
