import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, Signer, SystemProgram, Transaction, TokenAmount, TransactionInstruction, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { createAssociatedTokenAccountInstruction, createTransferInstruction, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
// import { Liquidity, LiquidityPoolKeys, Percent, SPL_ACCOUNT_LAYOUT, Token, jsonInfo2PoolKeys } from '@raydium-io/raydium-sdk';
// import { TokenAmount as RaydiumTokenAmount } from '@raydium-io/raydium-sdk';
import * as common from './common.js';

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(process.env.ASSOCIATED_TOKEN_PROGRAM_ID || 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const TRADE_PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || '');
const ACCOUNT_0 = new PublicKey(process.env.ACCOUNT_0 || '');
const ACCOUNT_1 = new PublicKey(process.env.ACCOUNT_1 || '');

export const SOLANA_TOKEN = new PublicKey(process.env.SOLANA_TOKEN || 'So11111111111111111111111111111111111111112');

const SYSTEM_PROGRAM_ID = new PublicKey(process.env.SYSTEM_PROGRAM_ID || '11111111111111111111111111111111');
const TOKEN_PROGRAM_ID = new PublicKey(process.env.TOKEN_PROGRAM_ID || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const RENT_PROGRAM_ID = new PublicKey(process.env.RENT_PROGRAM_ID || 'SysvarRent111111111111111111111111111111111');

const LIQUIDITY_FILE = process.env.LIQUIDITY_FILE || 'https://api.raydium.io/v2/sdk/liquidity/mainnet.json';

const PRIORITY_UNITS = 1000000;
const PRIORITY_MICRO_LAMPORTS = 100000;

export async function get_balance(pubkey: PublicKey): Promise<number> {
    return await global.connection.getBalance(pubkey);
}

async function create_versioned_tx(instructions: TransactionInstruction[], seller: Signer): Promise<VersionedTransaction> {
    const { blockhash } = await global.connection.getLatestBlockhash('finalized');
    const versioned_tx = new VersionedTransaction(new TransactionMessage({
        payerKey: seller.publicKey,
        recentBlockhash: blockhash,
        instructions: instructions.filter(Boolean),
    }).compileToV0Message());

    versioned_tx.sign([seller]);
    return versioned_tx;
}

async function send_tx(tx: VersionedTransaction, max_retries: number = 3): Promise<String> {
    try {
        return await global.connection.sendTransaction(tx, {
            skipPreflight: true,
            maxRetries: max_retries,
        })
    } catch (err) {
        throw new Error(`Max retries reached, failed to send the transaction. Last error: ${err}`);
    }
}

export async function check_has_balances(keys: Uint8Array[], min_balance: number = 0): Promise<boolean> {
    let ok = true;

    try {
        for (const key of keys) {
            const keypair = Keypair.fromSecretKey(key);
            const balance = await get_balance(keypair.publicKey) / LAMPORTS_PER_SOL;
            if (balance <= min_balance) {
                common.log_error(`Address: ${keypair.publicKey.toString().padEnd(44, ' ')} has no balance.`);
                ok = false;
            }
        }
        if (!ok) common.log_error('[ERROR] Some accounts are empty.');
        return ok;
    } catch (err) {
        common.log_error(`[ERROR] failed to process keys: ${err}`);
        return false;
    }
}

function instructions_add_priority(instructions: TransactionInstruction[]): void {
    const modify_cu = ComputeBudgetProgram.setComputeUnitLimit({
        units: PRIORITY_UNITS,
    });
    const priority_fee = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: PRIORITY_MICRO_LAMPORTS,
    });
    instructions.push(modify_cu, priority_fee);
}

export async function send_lamports(lamports: number, sender: Signer, receiver: PublicKey, max: boolean = false, priority: boolean = false, retries: number = 0): Promise<String> {
    const max_retries = 5;

    let instructions: TransactionInstruction[] = [];
    if (priority) instructions_add_priority(instructions);
    instructions.push(SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: receiver,
        lamports: lamports - (max ? 5000 : 0) - (priority ? 100000 : 0),
    }));

    const versioned_tx = await create_versioned_tx(instructions, sender);
    return await send_tx(versioned_tx, max_retries);
}

export async function get_tx_fee(tx: Transaction): Promise<number> {
    try {
        const repsonse = await global.connection.getFeeForMessage(
            tx.compileMessage(),
            'confirmed'
        );
        if (!repsonse || !repsonse.value) return 0;
        return repsonse.value;
    } catch (err) {
        common.log_error(`[ERROR] Failed to get the transaction fee: ${err}`);
        return 0;
    }
}

async function calc_assoc_token_addr(owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
    const address = PublicKey.findProgramAddressSync(
        [
            owner.toBuffer(),
            TOKEN_PROGRAM_ID.toBuffer(),
            mint.toBuffer(),
        ],
        ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
    return address;
}

async function check_assoc_token_addr(assoc_address: PublicKey): Promise<boolean> {
    const accountInfo = await global.connection.getAccountInfo(assoc_address);
    return accountInfo !== null;
}

function get_token_amount_raw(amount: number, token: common.TokenMeta): number {
    return Math.round(amount * token.total_supply / token.market_cap);
}

function get_solana_amount_raw(amount: number, token: common.TokenMeta): number {
    return Math.round(amount * token.market_cap / token.total_supply);
}

function calc_slippage_up(sol_amount: number, slippage: number): number {
    const lamports = sol_amount * LAMPORTS_PER_SOL;
    return Math.round(lamports * (1 + slippage) + lamports * (1 + slippage) / 100);
}

function calc_slippage_down(sol_amount: number, slippage: number): number {
    const lamports = sol_amount * LAMPORTS_PER_SOL;
    return Math.round(lamports * (1 - slippage));
}

function buy_data(sol_amount: number, token_amount: number, slippage: number): Buffer {
    const instruction_buf = Buffer.from('66063d1201daebea', 'hex');
    const token_amount_buf = Buffer.alloc(8);
    token_amount_buf.writeBigUInt64LE(BigInt(token_amount), 0);
    const slippage_buf = Buffer.alloc(8);
    slippage_buf.writeBigUInt64LE(BigInt(calc_slippage_up(sol_amount, slippage)), 0);
    return Buffer.concat([instruction_buf, token_amount_buf, slippage_buf]);
}

function sell_data(sol_amount: number, token_amount: number, slippage: number): Buffer {
    const instruction_buf = Buffer.from('33e685a4017f83ad', 'hex');
    const token_amount_buf = Buffer.alloc(8);
    token_amount_buf.writeBigUInt64LE(BigInt(token_amount), 0);
    const slippage_buf = Buffer.alloc(8);
    slippage_buf.writeBigUInt64LE(BigInt(calc_slippage_down(sol_amount, slippage)), 0);
    return Buffer.concat([instruction_buf, token_amount_buf, slippage_buf]);
}

export async function get_token_balance(pubkey: PublicKey, mint: PublicKey): Promise<TokenAmount> {
    const assoc_addres = await calc_assoc_token_addr(pubkey, mint);
    const account_info = await global.connection.getTokenAccountBalance(assoc_addres);
    return account_info.value || 0;
}

export async function send_tokens(token_amount: number, sender: Signer, receiver: PublicKey, owner: PublicKey, priority: boolean = false): Promise<String> {
    const max_retries = 5;

    let instructions: TransactionInstruction[] = []
    if (priority) instructions_add_priority(instructions);
    instructions.push(createTransferInstruction(
        sender.publicKey,
        receiver,
        owner,
        token_amount
    ));

    const versioned_tx = await create_versioned_tx(instructions, sender);
    return await send_tx(versioned_tx, max_retries);
}

export async function create_assoc_token_account(payer: Signer, owner: PublicKey, mint: PublicKey, retries: number = 0): Promise<PublicKey> {
    const max_retries = 5;

    try {
        let account = await getOrCreateAssociatedTokenAccount(global.connection, payer, mint, owner, false, 'confirmed', { maxRetries: max_retries, skipPreflight: true });
        return account.address;
    } catch (err) {
        throw new Error(`Max retries reached, failed to get associated token account. Last error: ${err}`);
    }
}

export async function buy_token(sol_amount: number, buyer: Signer, mint_meta: common.TokenMeta, slippage: number = 0.05, priority: boolean = false): Promise<String> {
    const max_retries = 5;

    const mint = new PublicKey(mint_meta.mint);
    const bonding_curve = new PublicKey(mint_meta.bonding_curve);
    const assoc_bonding_curve = new PublicKey(mint_meta.associated_bonding_curve);

    const token_amount = get_token_amount_raw(sol_amount, mint_meta);
    const instruction_data = buy_data(sol_amount, token_amount, slippage);
    const assoc_address = await calc_assoc_token_addr(buyer.publicKey, mint);
    const is_assoc = await check_assoc_token_addr(assoc_address);

    let instructions: TransactionInstruction[] = [];
    if (priority) instructions_add_priority(instructions);
    if (!is_assoc) {
        instructions.push(createAssociatedTokenAccountInstruction(
            buyer.publicKey,
            assoc_address,
            buyer.publicKey,
            mint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
        ));
    }
    instructions.push(new TransactionInstruction({
        keys: [
            { pubkey: ACCOUNT_0, isSigner: false, isWritable: false },
            { pubkey: ACCOUNT_1, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bonding_curve, isSigner: false, isWritable: true },
            { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
            { pubkey: assoc_address, isSigner: false, isWritable: true },
            { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: RENT_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: TRADE_PROGRAM_ID,
        data: instruction_data,
    }));
    const versioned_tx = await create_versioned_tx(instructions, buyer);
    return await send_tx(versioned_tx, max_retries);
}

export async function sell_token(token_amount: number, seller: Signer, mint_meta: common.TokenMeta, slippage: number = 0.05, priority: boolean = false): Promise<String> {
    const max_retries = 10;

    const mint = new PublicKey(mint_meta.mint);
    const bonding_curve = new PublicKey(mint_meta.bonding_curve);
    const assoc_bonding_curve = new PublicKey(mint_meta.associated_bonding_curve);

    const sol_amount = get_solana_amount_raw(token_amount, mint_meta);
    const instruction_data = sell_data(sol_amount, token_amount, slippage);
    const assoc_address = await calc_assoc_token_addr(seller.publicKey, mint);

    let instructions: TransactionInstruction[] = [];
    if (priority) instructions_add_priority(instructions);
    instructions.push(new TransactionInstruction({
        keys: [
            { pubkey: ACCOUNT_0, isSigner: false, isWritable: false },
            { pubkey: ACCOUNT_1, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bonding_curve, isSigner: false, isWritable: true },
            { pubkey: assoc_bonding_curve, isSigner: false, isWritable: true },
            { pubkey: assoc_address, isSigner: false, isWritable: true },
            { pubkey: seller.publicKey, isSigner: true, isWritable: true },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: TRADE_PROGRAM_ID,
        data: instruction_data,
    }));
    const versioned_tx = await create_versioned_tx(instructions, seller);
    return await send_tx(versioned_tx, max_retries);
}

// async function load_pool_keys(liquidity_file: string): Promise<any[]> {
//     const liquidity_resp = await fetch(liquidity_file);
//     if (!liquidity_resp.ok) {
//         throw new Error(`[ERROR]: Failed to fetch liquidity file: ${liquidity_file}`);
//     }
//     const liquidity = (await liquidity_resp.json()) as { official: any; unOfficial: any };
//     return [...(liquidity?.official ?? []), ...(liquidity?.unOfficial ?? [])]
// }

// function find_pool_info(pool: any[], base_mint: PublicKey, quote_mint: PublicKey): LiquidityPoolKeys | null {
//     const data = pool.find(
//         (i) => (i.baseMint === base_mint.toString() && i.quoteMint === quote_mint.toString()) || (i.baseMint === quote_mint.toString() && i.quoteMint === base_mint.toString())
//     );
//     if (!data) return null;
//     return jsonInfo2PoolKeys(data) as LiquidityPoolKeys;
// }

// async function get_owner_token_accounts(owner: PublicKey) {
//     const walletTokenAccount = await global.connection.getTokenAccountsByOwner(owner, {
//         programId: TOKEN_PROGRAM_ID,
//     })

//     return walletTokenAccount.value.map((i) => ({
//         pubkey: i.pubkey,
//         programId: i.account.owner,
//         accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
//     }))
// }

// async function get_raydium_swap_tx(amount: number, seller: Signer, mint_from: PublicKey, mint_to: PublicKey, pool_keys: any, slippage: number, priority: boolean): Promise<VersionedTransaction> {
//     const { min_amount_out, amount_in } = await calc_swap_amounts(amount, mint_from, mint_to, pool_keys, slippage);
//     const token_accounts = await get_owner_token_accounts(seller.publicKey);

//     const swap_tx = await Liquidity.makeSwapInstructionSimple({
//         connection: connection,
//         makeTxVersion: 1,
//         poolKeys: {
//             ...pool_keys,
//         },
//         userKeys: {
//             tokenAccounts: token_accounts,
//             owner: seller.publicKey,
//         },
//         amountIn: amount_in,
//         amountOut: min_amount_out,
//         fixedSide: 'in',
//         config: {
//             bypassAssociatedCheck: false,
//         },
//         computeBudgetConfig: priority ? {
//             microLamports: PRIORITY_MICRO_LAMPORTS,
//             units: PRIORITY_UNITS,
//         } : undefined,
//     });

//     return create_versioned_tx(swap_tx.innerTransactions[0].instructions, seller);
// }

// async function calc_swap_amounts(amount: number, mint_from: PublicKey, mint_to: PublicKey, pool_keys: any, slippage: number) {
//     const pool_info = await Liquidity.fetchInfo({ connection: global.connection, poolKeys: pool_keys });

//     const currency_in = new Token(TOKEN_PROGRAM_ID, mint_from, pool_keys.baseDecimals);
//     const currency_out = new Token(TOKEN_PROGRAM_ID, mint_to, pool_keys.quoteDecimals);
//     const amount_in = new RaydiumTokenAmount(currency_in, amount, false);
//     const slipage = new Percent(slippage * 100, 100);

//     const { amountOut, minAmountOut, currentPrice, executionPrice, priceImpact, fee } = Liquidity.computeAmountOut({
//         poolKeys: pool_keys,
//         poolInfo: pool_info,
//         amountIn: amount_in,
//         currencyOut: currency_out,
//         slippage: slipage
//     })

//     return {
//         amount_out: amountOut,
//         min_amount_out: minAmountOut,
//         current_price: currentPrice,
//         execution_price: executionPrice,
//         price_impact: priceImpact,
//         fee: fee,
//         amount_in
//     }
// }

// export async function swap_raydium(amount: number, seller: Signer, mint_from: PublicKey, mint_to: PublicKey, slippage: number = 0.05, priority: boolean = false): Promise<String> {
//     const max_retries = 5;

//     const pool = await load_pool_keys(LIQUIDITY_FILE);
//     const pool_keys = find_pool_info(pool, mint_from, mint_to);

//     const tx = await get_raydium_swap_tx(amount, seller, mint_from, mint_to, pool_keys, slippage, priority);
//     return await send_tx(tx, max_retries);
// }