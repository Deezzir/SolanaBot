import { AddressLookupTableAccount, PublicKey, Signer, TokenAmount, TransactionInstruction } from '@solana/web3.js';
import { PriorityLevel, JUPITER_API_URL } from '../constants';
import { send_tx, TokenMetrics, get_ltas } from './trade_common';

type JupiterQuote = {
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
    return await send_tx(instructions, [seller], priority, protection_tip, lta_accounts);
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

    const { addressLookupTableAddresses, swapInstruction, cleanupInstruction, setupInstructions } = instructions_raw;

    const lta_accounts = await get_ltas(addressLookupTableAddresses.map((lta: string) => new PublicKey(lta)));
    const instructions: TransactionInstruction[] = [
        ...setupInstructions.map(deserialize_instruction),
        deserialize_instruction(swapInstruction),
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
    return await send_tx(instructions, [seller], priority, protection_tip, address_lt_accounts);
}

export async function swap_raydium_instructions(
    _amount: TokenAmount,
    _seller: Signer,
    _amm: PublicKey,
    _swap_to: PublicKey,
    _slippage: number
): Promise<[TransactionInstruction[], AddressLookupTableAccount[]?]> {
    let instructions: TransactionInstruction[] = [];

    return [instructions, undefined];
}

export async function get_raydium_token_metrics(_amm: PublicKey): Promise<TokenMetrics> {
    // try {
    // const info = await global.CONNECTION.getAccountInfo(amm);
    // if (!info) return { price_sol: 0.0, mcap_sol: 0.0 };
    // const pool_state = LIQUIDITY_STATE_LAYOUT_V4.decode(info.data);

    // const base_token_balance = await get_vault_balance(pool_state.baseVault);
    // const quote_token_balance = await get_vault_balance(pool_state.quoteVault);

    // const price_sol =
    //     Number(base_token_balance.balance) /
    //     Math.pow(10, base_token_balance.decimals) /
    //     (Number(quote_token_balance.balance) / Math.pow(10, quote_token_balance.decimals));
    // const token = await get_token_supply(pool_state.quoteMint);
    // const mcap_sol = (price_sol * Number(token.supply)) / Math.pow(10, token.decimals);
    // return { price_sol: Number(price_sol) / Math.pow(10, token.decimals), mcap_sol };
    // } catch (err) {
    return { price_sol: 0.0, mcap_sol: 0.0 };
    // }
}

export async function get_raydium_amm_from_mint(_mint: PublicKey): Promise<PublicKey | null> {
    // try {
    //     const [marketAccount] = await CONNECTION.getProgramAccounts(RAYDIUM_AMM4_PROGRAM_ID, {
    //         commitment: COMMITMENT,
    //         filters: [
    //             { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
    //             {
    //                 memcmp: {
    //                     offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('baseMint'),
    //                     bytes: SOL_MINT.toBase58()
    //                 }
    //             },
    //             {
    //                 memcmp: {
    //                     offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
    //                     bytes: mint.toBase58()
    //                 }
    //             }
    //         ]
    //     });
    //     return marketAccount.pubkey;
    // } catch {
    return null;
    // }
}
