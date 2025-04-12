import {
    Liquidity,
    LiquidityPoolInfo,
    LiquidityPoolKeys,
    Percent,
    Token,
    TokenAmount as RayTokenAmount,
    LIQUIDITY_STATE_LAYOUT_V4,
    MARKET_STATE_LAYOUT_V3,
    MAINNET_PROGRAM_ID,
    CurrencyAmount
} from '@raydium-io/raydium-sdk';
import {
    AddressLookupTableAccount,
    PublicKey,
    Signer,
    SystemProgram,
    TokenAmount,
    TransactionInstruction
} from '@solana/web3.js';
import {
    PriorityLevel,
    JUPITER_API_URL,
    RAYDIUM_AMM_PROGRAM_ID,
    RAYDIUM_AUTHORITY,
    SOL_MINT,
    TRADE_SWAP_SEED,
    COMMITMENT
} from '../constants.js';
import BN from 'bn.js';
import {
    calc_assoc_token_addr,
    check_ata_exists,
    create_and_send_smart_tx,
    create_and_send_tx,
    get_address_lt_accounts,
    get_token_supply,
    get_vault_balance,
    TokenMetrics
} from './trade_common.js';
import {
    createAssociatedTokenAccountInstruction,
    createCloseAccountInstruction,
    createInitializeAccountInstruction,
    TOKEN_PROGRAM_ID
} from '@solana/spl-token';

type RaydiumAmounts = {
    amount_in: RayTokenAmount;
    token_in: PublicKey;
    token_out: PublicKey;
    min_amount_out: CurrencyAmount;
};

export type JupiterQuote = {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: 'ExactIn' | 'ExactOut';
    slippageBps: number;
    platformFee: {
        amount: string;
        feeBps: number;
    };
    priceImpactPct: string;
    routePlan: Array<{
        swapInfo: {
            ammKey: string;
            label: string;
            inputMint: string;
            outputMint: string;
            inAmount: string;
            outAmount: string;
            feeAmount: string;
            feeMint: string;
        };
        percent: number;
    }>;
    contextSlot: number;
    timeTaken: number;
};

export async function swap_jupiter(
    amount: TokenAmount,
    seller: Signer,
    from: PublicKey,
    to: PublicKey,
    slippage: number = 0.05,
    priority?: PriorityLevel,
    protection_tip?: number
): Promise<String> {
    const quote = await quote_jupiter(amount, from, to, slippage);
    const [instructions, lta_accounts] = await swap_jupiter_instructions(seller, quote);
    if (priority) {
        return await create_and_send_tx(instructions, [seller], priority, protection_tip, lta_accounts);
    }
    return await create_and_send_smart_tx(instructions, [seller]);
}

export async function quote_jupiter(
    amount: TokenAmount,
    from: PublicKey,
    to: PublicKey,
    slippage: number = 0.05
): Promise<JupiterQuote> {
    const amount_in = amount.amount;
    const slippage_raw = slippage * 10000;
    const url = `${JUPITER_API_URL}quote?inputMint=${from.toString()}&outputMint=${to.toString()}&amount=${amount_in}&slippageBps=${slippage_raw}`;

    const quote = await (await fetch(url)).json();
    if (quote.errorCode) throw new Error(`Failed to get the quote: ${quote.error}`);

    return quote as JupiterQuote;
}

export async function swap_jupiter_instructions(
    seller: Signer,
    quote: JupiterQuote
): Promise<[TransactionInstruction[], AddressLookupTableAccount[]]> {
    const deserialize_instruction = (instruction: any) => {
        return new TransactionInstruction({
            programId: new PublicKey(instruction.programId),
            keys: instruction.accounts.map((key: any) => ({
                pubkey: new PublicKey(key.pubkey),
                isSigner: key.isSigner,
                isWritable: key.isWritable
            })),
            data: Buffer.from(instruction.data, 'base64')
        });
    };
    const instructions_raw = await (
        await fetch(`${JUPITER_API_URL}swap-instructions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                quoteResponse: quote,
                userPublicKey: seller.publicKey.toString(),
                wrapAndUnwrapSol: true
            })
        })
    ).json();
    if (instructions_raw.error) throw new Error(`Failed to get swap instructions: ${instructions_raw.error} `);

    const { addressLookupTableAddresses, swapInstructionPayload, cleanupInstruction, setupInstructions } =
        instructions_raw;

    const lta_accounts: AddressLookupTableAccount[] = [];
    lta_accounts.push(...(await get_address_lt_accounts(addressLookupTableAddresses)));
    const instructions: TransactionInstruction[] = [
        ...setupInstructions.map(deserialize_instruction),
        deserialize_instruction(swapInstructionPayload),
        deserialize_instruction(cleanupInstruction)
    ];
    return [instructions, lta_accounts];
}

export async function swap_raydium(
    amount: TokenAmount,
    seller: Signer,
    amm: PublicKey,
    swap_to: PublicKey,
    slippage: number = 0.05,
    priority?: PriorityLevel,
    protection_tip?: number
): Promise<String> {
    const [instructions, address_lt_accounts] = await swap_raydium_instructions(amount, seller, swap_to, amm, slippage);
    if (priority) {
        return await create_and_send_tx(instructions, [seller], priority, protection_tip, address_lt_accounts);
    }
    return await create_and_send_smart_tx(instructions, [seller]);
}

export async function swap_raydium_instructions(
    amount: TokenAmount,
    seller: Signer,
    amm: PublicKey,
    swap_to: PublicKey,
    slippage: number
): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
    const raw_slippage = slippage * 100;
    const pool_keys = await get_raydium_poolkeys(amm);
    if (!pool_keys) throw new Error(`Failed to get the pool keys.`);

    const pool_info = await Liquidity.fetchInfo({
        connection: global.CONNECTION,
        poolKeys: pool_keys
    });

    const raw_amount_in = parseInt(amount.amount, 10);
    const { amount_in, token_in, token_out, min_amount_out } = await calc_raydium_amounts(
        pool_keys,
        pool_info,
        swap_to,
        amount.uiAmount || 0,
        raw_slippage
    );

    let token_in_acc: PublicKey;
    let token_out_acc: PublicKey;
    let instructions: TransactionInstruction[] = [];

    if (token_in.equals(SOL_MINT)) {
        token_out_acc = await calc_assoc_token_addr(seller.publicKey, token_out);
        if (!(await check_ata_exists(token_out_acc))) {
            instructions.push(
                createAssociatedTokenAccountInstruction(seller.publicKey, token_out_acc, seller.publicKey, token_out)
            );
        }
        token_in_acc = await PublicKey.createWithSeed(seller.publicKey, TRADE_SWAP_SEED, TOKEN_PROGRAM_ID);
        instructions = instructions.concat(await get_swap_acc_intsruction(seller, token_in_acc, raw_amount_in));
    } else {
        token_out_acc = await PublicKey.createWithSeed(seller.publicKey, TRADE_SWAP_SEED, TOKEN_PROGRAM_ID);
        instructions = instructions.concat(await get_swap_acc_intsruction(seller, token_out_acc));
        token_in_acc = await calc_assoc_token_addr(seller.publicKey, token_in);
    }
    instructions.push(
        new TransactionInstruction({
            programId: new PublicKey(pool_keys.programId),
            keys: [
                {
                    pubkey: TOKEN_PROGRAM_ID,
                    isSigner: false,
                    isWritable: false
                },
                { pubkey: pool_keys.id, isSigner: false, isWritable: true },
                {
                    pubkey: pool_keys.authority,
                    isSigner: false,
                    isWritable: false
                },
                {
                    pubkey: pool_keys.openOrders,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.targetOrders,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.baseVault,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.quoteVault,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.marketProgramId,
                    isSigner: false,
                    isWritable: false
                },
                {
                    pubkey: pool_keys.marketId,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.marketBids,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.marketAsks,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.marketEventQueue,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.marketBaseVault,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.marketQuoteVault,
                    isSigner: false,
                    isWritable: true
                },
                {
                    pubkey: pool_keys.marketAuthority,
                    isSigner: false,
                    isWritable: false
                },
                { pubkey: token_in_acc, isSigner: false, isWritable: true },
                { pubkey: token_out_acc, isSigner: false, isWritable: true },
                { pubkey: seller.publicKey, isSigner: true, isWritable: false }
            ],
            data: Buffer.from(
                Uint8Array.of(
                    9,
                    ...new BN(amount_in.raw).toArray('le', 8),
                    ...new BN(min_amount_out.raw).toArray('le', 8)
                )
            )
        })
    );
    if (token_in.equals(SOL_MINT)) {
        instructions.push(createCloseAccountInstruction(token_in_acc, seller.publicKey, seller.publicKey));
    } else {
        instructions.push(createCloseAccountInstruction(token_out_acc, seller.publicKey, seller.publicKey));
    }

    return [instructions, undefined];
}

async function calc_raydium_amounts(
    pool_keys: LiquidityPoolKeys,
    pool_info: LiquidityPoolInfo,
    token_buy: PublicKey,
    amount_in: number,
    raw_slippage: number
): Promise<RaydiumAmounts> {
    let mint_token_out = token_buy;
    let token_out_decimals = pool_keys.baseMint.equals(mint_token_out)
        ? pool_info.baseDecimals
        : pool_keys.quoteDecimals;
    let mint_token_in = pool_keys.baseMint.equals(mint_token_out) ? pool_keys.quoteMint : pool_keys.baseMint;
    let token_in_decimals = pool_keys.baseMint.equals(mint_token_out)
        ? pool_info.quoteDecimals
        : pool_info.baseDecimals;

    const token_in = new Token(TOKEN_PROGRAM_ID, mint_token_in, token_in_decimals);
    const token_amount_in = new RayTokenAmount(token_in, amount_in, false);
    const token_out = new Token(TOKEN_PROGRAM_ID, mint_token_out, token_out_decimals);
    const slippage = new Percent(raw_slippage, 100);
    const { minAmountOut } = Liquidity.computeAmountOut({
        poolKeys: pool_keys,
        poolInfo: pool_info,
        amountIn: token_amount_in,
        currencyOut: token_out,
        slippage
    });
    return {
        amount_in: token_amount_in,
        token_in: mint_token_in,
        token_out: mint_token_out,
        min_amount_out: minAmountOut
    };
}

async function get_swap_acc_intsruction(
    seller: Signer,
    token_acc: PublicKey,
    lamports: number = 0
): Promise<TransactionInstruction[]> {
    let instructions: TransactionInstruction[] = [];
    instructions.push(
        SystemProgram.createAccountWithSeed({
            seed: TRADE_SWAP_SEED,
            basePubkey: seller.publicKey,
            fromPubkey: seller.publicKey,
            newAccountPubkey: token_acc,
            lamports: (await global.CONNECTION.getMinimumBalanceForRentExemption(165)) + lamports,
            space: 165,
            programId: TOKEN_PROGRAM_ID
        })
    );
    instructions.push(createInitializeAccountInstruction(token_acc, SOL_MINT, seller.publicKey, TOKEN_PROGRAM_ID));
    return instructions;
}

export async function get_raydium_token_metrics(amm: PublicKey): Promise<TokenMetrics> {
    try {
        const info = await global.CONNECTION.getAccountInfo(amm);
        if (!info) return { price_sol: 0.0, mcap_sol: 0.0, supply: BigInt(0) };
        const pool_state = LIQUIDITY_STATE_LAYOUT_V4.decode(info.data);

        const base_token_balance = await get_vault_balance(pool_state.baseVault);
        const quote_token_balance = await get_vault_balance(pool_state.quoteVault);

        const price_sol =
            Number(base_token_balance.balance) /
            Math.pow(10, base_token_balance.decimals) /
            (Number(quote_token_balance.balance) / Math.pow(10, quote_token_balance.decimals));
        const token = await get_token_supply(pool_state.quoteMint);
        const mcap_sol = (price_sol * Number(token.supply)) / Math.pow(10, token.decimals);
        return { price_sol: Number(price_sol) / Math.pow(10, token.decimals), mcap_sol, supply: token.supply };
    } catch (err) {
        return { price_sol: 0.0, mcap_sol: 0.0, supply: BigInt(0) };
    }
}

export async function get_raydium_amm_from_mint(mint: PublicKey): Promise<PublicKey | null> {
    try {
        const [marketAccount] = await CONNECTION.getProgramAccounts(RAYDIUM_AMM_PROGRAM_ID, {
            commitment: COMMITMENT,
            filters: [
                { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
                {
                    memcmp: {
                        offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('baseMint'),
                        bytes: SOL_MINT.toBase58()
                    }
                },
                {
                    memcmp: {
                        offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
                        bytes: mint.toBase58()
                    }
                }
            ]
        });
        return marketAccount.pubkey;
    } catch {
        return null;
    }
}

export async function get_raydium_poolkeys(amm: PublicKey): Promise<LiquidityPoolKeys> {
    const ammAccount = await global.CONNECTION.getAccountInfo(amm);
    if (ammAccount) {
        try {
            const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(ammAccount.data);
            const marketAccount = await global.CONNECTION.getAccountInfo(poolState.marketId);
            if (marketAccount) {
                const marketState = MARKET_STATE_LAYOUT_V3.decode(marketAccount.data);
                const marketAuthority = PublicKey.createProgramAddressSync(
                    [marketState.ownAddress.toBuffer(), marketState.vaultSignerNonce.toArrayLike(Buffer, 'le', 8)],
                    MAINNET_PROGRAM_ID.OPENBOOK_MARKET
                );
                return {
                    id: amm,
                    programId: MAINNET_PROGRAM_ID.AmmV4,
                    status: poolState.status,
                    baseDecimals: poolState.baseDecimal.toNumber(),
                    quoteDecimals: poolState.quoteDecimal.toNumber(),
                    lpDecimals: 9,
                    baseMint: poolState.baseMint,
                    quoteMint: poolState.quoteMint,
                    version: 4,
                    authority: RAYDIUM_AUTHORITY,
                    openOrders: poolState.openOrders,
                    baseVault: poolState.baseVault,
                    quoteVault: poolState.quoteVault,
                    marketProgramId: MAINNET_PROGRAM_ID.OPENBOOK_MARKET,
                    marketId: marketState.ownAddress,
                    marketBids: marketState.bids,
                    marketAsks: marketState.asks,
                    marketEventQueue: marketState.eventQueue,
                    marketBaseVault: marketState.baseVault,
                    marketQuoteVault: marketState.quoteVault,
                    marketAuthority: marketAuthority,
                    targetOrders: poolState.targetOrders,
                    lpMint: poolState.lpMint
                } as unknown as LiquidityPoolKeys;
            }
        } catch {
            throw new Error('Invalid Raydium AMM address');
        }
    }
    throw new Error('Failed to retrieve account information');
}
