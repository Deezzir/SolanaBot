import { MongoClient, Db, ServerApiVersion, ClientSession } from "mongodb";
import * as common from "./common.js";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import * as trade from "./trade.js";
import { readFileSync } from "fs";
import dotenv from "dotenv";
dotenv.config();

const RECORDS_PER_ITERATION = 2;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.MONGO_DB || "taro";
const AIRDROP_COLLECTION = "airdropusers";
const PRESALE_COLLECTION = "presaleusers";
const PRESALE_FEE_PERCENT = 0.05;
let DB: Db | undefined = undefined;
const DB_CLIENT = new MongoClient(MONGO_URI, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});


async function connect_db() {
    try {
        await DB_CLIENT.connect();
        DB = DB_CLIENT.db(DB_NAME);
    } catch (error) {
        console.error(`[ERROR] Could not connect to the database: ${error}`);
        throw error;
    }
}

async function fetch_records(collectionName: string) {
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

function calc_airdrop_amount(airdrop_percent: number, total_tokens: number, record_count: number) {
    const airdrop_amount = (airdrop_percent / 100) * total_tokens / record_count;
    return Math.floor(airdrop_amount);
}

async function calc_presale_amounts(presale_percent: number, total_tokens: number): Promise<{ presale_tokens: number, presale_sol: number, presale_fee: number }> {
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
        const presale_sol = common.round_two(result && result.length > 0 ? result[0].totalSolAmount : 0.0);
        const presale_fee = common.round_two(presale_sol * PRESALE_FEE_PERCENT);
        return { presale_tokens, presale_sol, presale_fee };
    } catch (error) {
        console.error(`[ERROR] Failed to calculate presale amounts: ${error}`);
        throw error;
    }
}

async function bulk_write(col_name: string, operations: any[]) {
    if (!DB) {
        await connect_db();
    }
    try {
        await DB?.collection(col_name).bulkWrite(operations);
    } catch (error) {
        console.error(`[ERROR] Failed to update airdrop balances: ${error}`);
        throw error;
    }
}

async function update_airdrop_balance(token_amount: number) {
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

async function update_presale_balance(token_amount: number, total_sol: number) {
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

async function count_records(col_name: string) {
    if (!DB) {
        await connect_db();
    }
    try {
        const collection = DB?.collection(col_name);
        const count = await collection?.countDocuments();
        return count || 0;
    } catch (error) {
        console.error(`[ERROR] Failed to count records: ${error}`);
        throw error;
    }

}

async function drop_tokens(col_name: string, drop: Keypair, mint_meta: common.MintMeta) {
    if (!DB) {
        await connect_db();
    }
    try {
        const collection = DB?.collection(col_name);
        let records = await collection?.find({ tx: null }).limit(RECORDS_PER_ITERATION).toArray();
        if (!records || records.length === 0) {
            console.log("No records to process");
            return;
        }

        const drop_assoc_addr = await trade.calc_assoc_token_addr(drop.publicKey, mint_meta.mint);

        while (records.length > 0) {
            let db_updates: any[] = [];
            let transactions = [];
            let count = records.length;
            let lastValidHeight = 0;

            while (count > 0) {
                const context = await connection.getLatestBlockhashAndContext('finalized');
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
                const receiver_assoc_addr = await trade.create_assoc_token_account(drop, receiver, mint_meta.mint);

                console.log(`Airdroping ${token_amount} tokens to ${receiver.toString().padEnd(44, ' ')}...`);
                transactions.push(trade.send_tokens(token_amount_raw, drop_assoc_addr, receiver_assoc_addr, drop, context, true)
                    .then((signature) => {
                        console.log(`Transaction completed for ${xUsername}, signature: ${signature}`)
                        db_updates.push({
                            updateOne: {
                                filter: { wallet: record.wallet },
                                update: { $set: { tx: signature } }
                            }
                        });
                    })
                    .catch(error => console.error(`Transaction failed for ${xUsername}, error: ${error.message}`)));

                count--;
            }
            await Promise.allSettled(transactions);
            await bulk_write(col_name, db_updates);
            await common.sleep(1000);

            records = await collection?.find({ tx: null }).limit(RECORDS_PER_ITERATION).toArray();
            if (!records) throw new Error("Failed to fetch records");
        }
    } catch (error) {
        console.error(`[ERROR] Failed to drop tokens: ${error}`);
        throw error;
    }
}

async function airdrop(percent: number, ui_balance: number, mint_meta: common.MintMeta, drop: Keypair) {
    const airdrop_count = await count_records(AIRDROP_COLLECTION);
    if (airdrop_count === 0) {
        console.error('No airdrop records found, exiting...');
        return;
    }

    const airdrop_amount = calc_airdrop_amount(percent, ui_balance, airdrop_count);
    console.log(`Airdrop | Total token amount of ${mint_meta.token_symbol}: ${airdrop_amount} | Record count: ${airdrop_count}`);

    common.setup_readline();
    await new Promise<void>(resolve => global.rl.question('Press ENTER to start the airdrop...', () => resolve()));

    console.log(`\nStarting Airdrop...`);
    await update_airdrop_balance(airdrop_amount);
    await drop_tokens(AIRDROP_COLLECTION, drop, mint_meta);
    console.log(`Airdrop completed`);
}

async function presale(percent: number, ui_balance: number, mint_meta: common.MintMeta, drop: Keypair) {
    const presale_count = await count_records(PRESALE_COLLECTION);
    if (presale_count === 0) {
        console.error('\nNo presale records found, exiting...');
        return;
    }

    const { presale_tokens, presale_sol, presale_fee } = await calc_presale_amounts(percent, ui_balance);
    console.log(
        `Presale | Total Amount ${mint_meta.token_symbol}: ${presale_tokens} | Total SOL: ${presale_sol} | Fee SOL: ${presale_fee} | Record count: ${presale_count}`
    );

    await new Promise<void>(resolve => global.rl.question('Press ENTER to start the presale...', () => resolve()));

    console.log(`\nStarting Presale drop...`);
    await update_presale_balance(presale_tokens, presale_sol - presale_fee);
    await drop_tokens(PRESALE_COLLECTION, drop, mint_meta);
    console.log(`Presale drop completed`);
}

export async function drop(airdrop_percent: number, mint: PublicKey, keypair_path: string, presale_percent: number = 0) {
    console.log(`Dropping the mint ${mint.toString()}...`);
    console.log(`Airdrop percent: ${airdrop_percent}% | Presale percent: ${presale_percent}%`);

    const mint_meta = await trade.get_token_meta(mint);
    console.log(`Token name: ${mint_meta.token_name} | Symbol: ${mint_meta.token_symbol}\n`);

    let drop: Keypair;
    let ui_balance: number = 0;
    try {
        drop = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypair_path, 'utf8'))));
        const balance = await trade.get_token_balance(drop.publicKey, mint);
        ui_balance = Math.floor(balance.uiAmount || 0);
        console.log(`Drop address: ${drop.publicKey.toString()} | Balance: ${ui_balance} ${mint_meta.token_symbol}\n`);
    } catch (err) {
        console.error('[ERROR] Failed to process dropper file');
        return;
    }

    try {
        await connect_db();

        await airdrop(airdrop_percent, ui_balance, mint_meta, drop);
        if (presale_percent !== 0) await presale(presale_percent, ui_balance, mint_meta, drop);

        console.log(`\nDropping completed`);
        await DB_CLIENT.close();
        console.log(`Database connection closed`);
        process.exit(0);
    } catch (error) {
        console.error(`[ERROR] Failed to drop tokens`);
    }
}