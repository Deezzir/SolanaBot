import { MongoClient, Db, ServerApiVersion, WithId, Document, BulkWriteResult } from "mongodb";
import * as common from "./common.js";
import { Keypair, PublicKey, Signer, TransactionInstruction } from "@solana/web3.js";
import * as trade from "./trade_common.js";
import { readFileSync } from "fs";
import dotenv from "dotenv";
import { createAssociatedTokenAccountInstruction, createTransferInstruction } from "@solana/spl-token";
dotenv.config();

const RECORDS_PER_ITERATION = 10;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.MONGO_DB_NAME || "test";
const AIRDROP_COLLECTION = "airdropusers";
const PRESALE_COLLECTION = "presaleusers";
let DB: Db | undefined = undefined;

const DB_CLIENT = new MongoClient(MONGO_URI, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

async function send_tokens(token_amount: number, mint: PublicKey, sender: PublicKey, receiver: PublicKey, payer: Signer): Promise<String> {
    let instructions: TransactionInstruction[] = []

    const ata = await trade.calc_assoc_token_addr(receiver, mint);

    if (!(await trade.check_account_exists(ata))) {
        instructions.push(
            createAssociatedTokenAccountInstruction(
                payer.publicKey,
                ata,
                receiver,
                mint
            )
        );
    }

    instructions.push(createTransferInstruction(
        sender,
        ata,
        payer.publicKey,
        token_amount
    ));

    return await trade.create_and_send_tx(instructions, [payer],
        { priority_level: common.PriorityLevel.MEDIUM, accounts: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'] }
    );
}


async function connect_db(): Promise<void> {
    try {
        await DB_CLIENT.connect();
        DB = DB_CLIENT.db(DB_NAME);
    } catch (error) {
        console.error(`[ERROR] Could not connect to the database: ${error}`);
        throw error;
    }
}

async function fetch_records(collectionName: string): Promise<WithId<Document>[] | undefined> {
    if (!DB) {
        await connect_db();
    }
    try {
        const collection = DB?.collection(collectionName);
        const records = await collection?.find({}).toArray();
        return records;
    } catch (error) {
        console.error("[ERROR] Failed to fetch records:", error);
        throw error;
    }
}

function calc_airdrop_amount(airdrop_percent: number, total_tokens: number, record_count: number): number {
    const airdrop_amount = (airdrop_percent / 100) * total_tokens / record_count;
    return Math.floor(airdrop_amount);
}

async function calc_presale_amounts(presale_percent: number, total_tokens: number): Promise<{ presale_tokens: number, presale_sol: number }> {
    if (!DB) {
        await connect_db();
    }
    try {
        const presale_tokens = Math.floor((presale_percent / 100) * total_tokens);
        const collection = DB?.collection(PRESALE_COLLECTION);
        const result = await collection?.aggregate([
            {
                $match: {
                    tx: { $eq: null },
                    txEnroll: { $ne: null }
                }
            },
            {
                $group: {
                    _id: null,
                    total: { $sum: "$solAmount" }
                }
            }
        ]).toArray();
        const presale_sol = common.round_two(result && result.length > 0 ? result[0].total : 0.0);
        return { presale_tokens, presale_sol };
    } catch (error) {
        console.error(`[ERROR] Failed to calculate presale amounts: ${error}`);
        throw error;
    }
}

async function bulk_write(col_name: string, operations: any[]): Promise<BulkWriteResult | undefined> {
    if (!DB) {
        await connect_db();
    }
    try {
        return await DB?.collection(col_name).bulkWrite(operations);
    } catch (error) {
        console.error(`[ERROR] Failed to update airdrop balances: ${error}`);
        throw error;
    }
}

async function update_airdrop_balance(token_amount: number): Promise<void> {
    console.log(`Updating airdrop balances...`);
    await bulk_write(AIRDROP_COLLECTION, [
        {
            updateMany: {
                filter: {},
                update: { $set: { tokensToSend: token_amount } }
            }
        }
    ]);
}

async function update_presale_balance(token_amount: number, total_sol: number): Promise<void> {
    console.log(`Updating airdrop balances...`);
    let bulk_writes: any[] = [];

    const records = await fetch_records(PRESALE_COLLECTION);
    if (!records) throw new Error("Failed to fetch records");

    for (let record of records) {
        const sol_amount = record.solAmount;
        const tokens_to_send = Math.floor(token_amount * (sol_amount / total_sol));

        bulk_writes.push({
            updateOne: {
                filter: { wallet: record.wallet },
                update: { $set: { tokensToSend: tokens_to_send } }
            }
        });
    }

    await bulk_write(PRESALE_COLLECTION, bulk_writes);
}

async function count_records(col_name: string): Promise<number> {
    if (!DB) {
        await connect_db();
    }
    try {
        const collection = DB?.collection(col_name);
        const count = await collection?.countDocuments({ tx: null });
        return count || 0;
    } catch (error) {
        console.error(`[ERROR] Failed to count records: ${error}`);
        throw error;
    }
}

async function drop_tokens(col_name: string, drop: Keypair, mint_meta: common.MintMeta): Promise<void> {
    if (!DB) {
        await connect_db();
    }
    try {
        const collection = DB?.collection(col_name);
        let records = await collection?.find({ tx: null }).limit(RECORDS_PER_ITERATION).toArray();
        if (!records || records.length === 0) {
            console.log("No records to process");
            return; ``
        }

        const drop_assoc_addr = await trade.calc_assoc_token_addr(drop.publicKey, mint_meta.mint);

        while (records.length > 0) {
            console.log(`Processing ${records.length} records...`);
            let db_updates: any[] = [];
            let transactions = [];
            let count = records.length;
            let lastValidHeight = 0;

            while (count > 0) {
                const context = await global.CONNECTION.getLatestBlockhashAndContext('confirmed');
                const last = context.value.lastValidBlockHeight;

                if (lastValidHeight !== last) {
                    lastValidHeight = last;
                } else {
                    await common.sleep(500);
                    continue;
                }

                const record = records[count - 1];
                const receiver = new PublicKey(record.wallet);
                const token_amount = record.tokensToSend;
                const xUsername = record.xUsername;
                const token_amount_raw = token_amount * (10 ** mint_meta.token_decimals);

                console.log(`Airdroping ${token_amount} tokens to ${receiver.toString().padEnd(44, ' ')} | ${xUsername}...`);
                transactions.push(send_tokens(token_amount_raw, mint_meta.mint, drop_assoc_addr, receiver, drop)
                    .then((signature) => {
                        console.log(`Transaction completed for ${xUsername}, signature: ${signature}`)
                        db_updates.push({
                            updateOne: {
                                filter: { wallet: record.wallet },
                                update: { $set: { tx: signature } }
                            }
                        });
                    })
                    .catch(error => {
                        console.error(`Transaction failed for ${xUsername}, error: ${error.message}`);
                        if (error.message.includes("Provided owner is not allowed")) {
                            db_updates.push({
                                updateOne: {
                                    filter: { wallet: record.wallet },
                                    update: { $set: { tx: "Provided owner is not allowed" } }
                                }
                            });
                        }
                    }));

                count--;
            }
            await Promise.allSettled(transactions);
            await bulk_write(col_name, db_updates);
            await common.sleep(500);

            records = await collection?.find({ tx: null }).limit(RECORDS_PER_ITERATION).toArray();
            if (!records) throw new Error("Failed to fetch records");
        }
    } catch (error) {
        console.error(`[ERROR] Failed to drop tokens: ${error}`);
        throw error;
    }
}

async function airdrop(percent: number, ui_balance: number, mint_meta: common.MintMeta, drop: Keypair): Promise<void> {
    const airdrop_count = await count_records(AIRDROP_COLLECTION);
    if (airdrop_count === 0) {
        console.error('No airdrop records found, exiting...');
        return;
    }

    const airdrop_amount = calc_airdrop_amount(percent, ui_balance, airdrop_count);
    console.log(`Airdrop | Total token amount of ${mint_meta.token_symbol}: ${airdrop_amount} | Record count: ${airdrop_count}`);

    common.setup_readline();
    await new Promise<void>(resolve => global.RL.question('Press ENTER to start the airdrop...', () => resolve()));

    console.log(`\nStarting Airdrop...`);
    await update_airdrop_balance(airdrop_amount);
    await drop_tokens(AIRDROP_COLLECTION, drop, mint_meta);
    console.log(`Airdrop completed`);
}

async function presale(percent: number, ui_balance: number, mint_meta: common.MintMeta, drop: Keypair): Promise<void> {
    const presale_count = await count_records(PRESALE_COLLECTION);
    if (presale_count === 0) {
        console.error('\nNo presale records found, exiting...');
        return;
    }

    const { presale_tokens, presale_sol } = await calc_presale_amounts(percent, ui_balance);
    console.log(
        `Presale | Total Amount ${mint_meta.token_symbol}: ${presale_tokens} | Total SOL: ${presale_sol} | Record count: ${presale_count}`
    );

    await new Promise<void>(resolve => global.RL.question('Press ENTER to start the presale...', () => resolve()));

    console.log(`\nStarting Presale drop...`);
    await update_presale_balance(presale_tokens, presale_sol);
    await drop_tokens(PRESALE_COLLECTION, drop, mint_meta);
    console.log(`Presale drop completed`);
}

export async function drop(airdrop_percent: number, mint: PublicKey, drop: Keypair, presale_percent: number = 0): Promise<void> {
    console.log(`Dropping the mint ${mint.toString()}...`);
    console.log(`Airdrop percent: ${airdrop_percent}% | Presale percent: ${presale_percent}%`);

    const mint_meta = await trade.get_token_meta(mint);
    console.log(`Token name: ${mint_meta.token_name} | Symbol: ${mint_meta.token_symbol}\n`);

    let ui_balance: number = 0;
    try {
        const balance = await trade.get_token_balance(drop.publicKey, mint);
        ui_balance = Math.floor(balance.uiAmount || 0);
        console.log(`Drop address: ${drop.publicKey.toString()} | Balance: ${ui_balance} ${mint_meta.token_symbol}\n`);
    } catch (err) {
        console.error('[ERROR] Failed to process dropper file');
        return;
    }

    try {
        await connect_db();
        if (global.RL === undefined) common.setup_readline();

        if (presale_percent !== 0) await presale(presale_percent, ui_balance, mint_meta, drop);
        if (airdrop_percent !== 0) await airdrop(airdrop_percent, ui_balance, mint_meta, drop);

        console.log(`\nDropping completed`);
        await DB_CLIENT.close();
        console.log(`Database connection closed`);
        process.exit(0);
    } catch (error) {
        console.error(`[ERROR] Failed to drop tokens: ${error}`);
    }
}

export async function clear_drop(airdrop_to_remove_path: string): Promise<void> {
    console.log(`Clearing the database...`);

    try {
        await connect_db();

        let to_remove = readFileSync(airdrop_to_remove_path, 'utf8').split('\n');
        to_remove = to_remove.map((line) => line.trim());
        console.log(`Removing ${to_remove.length} records...`);

        let bulk_writes: any[] = [];
        for (let wallet of to_remove) {
            bulk_writes.push({
                deleteOne: {
                    filter: { wallet: wallet }
                }
            });
        }

        await bulk_write(AIRDROP_COLLECTION, bulk_writes);

        console.log(`Database cleared`);
        await DB_CLIENT.close();
        console.log(`Database connection closed`);
    } catch (error) {
        console.error(`[ERROR] Failed to clear the database`);
    }
}
