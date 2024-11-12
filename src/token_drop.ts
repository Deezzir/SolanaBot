import { MongoClient, Db, ServerApiVersion, WithId, Document, BulkWriteResult } from 'mongodb';
import * as common from './common/common.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as trade from './common/trade_common.js';
import dotenv from 'dotenv';
dotenv.config();

const RECORDS_PER_ITERATION = 10;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB_NAME || 'test';
const AIRDROP_COLLECTION = 'airdropusers';
const PRESALE_COLLECTION = 'presaleusers';
let DB: Db | undefined = undefined;

// SCHEMA
// airdropusers
// {
//     wallet: string;
//     xUsername: string;
//     xPostLink: string;
//     tokensToSend: number;
//     tx: string | null;
// }

// presaleusers
// {
//     wallet: string;
//     solAmount: number;
//     txEnroll: string[];
//     tokensToSend: number;
//     tx: string | null;
// }

const DB_CLIENT = new MongoClient(MONGO_URI, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true
    }
});

async function connect_db(): Promise<void> {
    try {
        await DB_CLIENT.connect();
        DB = DB_CLIENT.db(DB_NAME);
    } catch (error) {
        throw new Error(`Could not connect to the database: ${error}`);
    }
}

async function close_db(): Promise<void> {
    try {
        await DB_CLIENT.close();
    } catch (error) {
        throw new Error(`Could not close the database: ${error}`);
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
        throw new Error(`Failed to fetch records: ${error}`);
    }
}

function calc_airdrop_amount(airdrop_percent: number, total_tokens: number, record_count: number): number {
    const airdrop_amount = ((airdrop_percent / 100) * total_tokens) / record_count;
    return Math.floor(airdrop_amount);
}

async function calc_presale_amounts(
    presale_percent: number,
    total_tokens: number
): Promise<{ presale_tokens: number; presale_sol: number }> {
    if (!DB) {
        await connect_db();
    }
    try {
        const presale_tokens = Math.floor((presale_percent / 100) * total_tokens);
        const collection = DB?.collection(PRESALE_COLLECTION);
        const result = await collection
            ?.aggregate([
                {
                    $match: {
                        tx: { $eq: null },
                        txEnroll: { $ne: null }
                    }
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: '$solAmount' }
                    }
                }
            ])
            .toArray();
        const presale_sol = common.round_two(result && result.length > 0 ? result[0].total : 0.0);
        return { presale_tokens, presale_sol };
    } catch (error) {
        throw new Error(`Failed to calculate presale amounts: ${error}`);
    }
}

async function bulk_write(col_name: string, operations: any[]): Promise<BulkWriteResult | undefined> {
    if (!DB) {
        await connect_db();
    }
    try {
        return await DB?.collection(col_name).bulkWrite(operations);
    } catch (error) {
        throw new Error(`Failed to update airdrop balances: ${error}`);
    }
}

async function update_airdrop_balance(token_amount: number): Promise<void> {
    common.log(`Updating airdrop balances...`);
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
    common.log(`Updating airdrop balances...`);
    let bulk_writes: any[] = [];

    const records = await fetch_records(PRESALE_COLLECTION);
    if (!records) throw new Error('Failed to fetch records');

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
        throw new Error(`Failed to count records: ${error}`);
    }
}

async function drop_tokens(col_name: string, drop: Keypair, mint_meta: trade.MintMeta): Promise<void> {
    if (!DB) {
        await connect_db();
    }

    const collection = DB?.collection(col_name);
    let records = await collection?.find({ tx: null }).limit(RECORDS_PER_ITERATION).toArray();
    if (!records || records.length === 0) {
        common.error(common.red('No records to process'));
        return;
    }

    const drop_assoc_addr = await trade.calc_assoc_token_addr(drop.publicKey, mint_meta.mint);

    while (records.length > 0) {
        common.log(common.yellow(`Processing ${records.length} records...`));

        let db_updates: any[] = [];
        let transactions = [];
        let count = records.length;
        let lastValidHeight = 0;

        while (count > 0) {
            const record = records[count - 1];
            const receiver = new PublicKey(record.wallet);
            const token_amount = record.tokensToSend;
            const token_amount_raw = token_amount * 10 ** mint_meta.token_decimals;
            try {
                const context = await global.CONNECTION.getLatestBlockhashAndContext('confirmed');
                const last = context.value.lastValidBlockHeight;

                if (lastValidHeight !== last) {
                    lastValidHeight = last;
                } else {
                    await common.sleep(500);
                    continue;
                }

                common.log(`Sending ${token_amount} tokens to ${receiver.toString()}...`);
                transactions.push(
                    trade
                        .send_tokens_with_account_create(
                            token_amount_raw,
                            mint_meta.mint,
                            drop_assoc_addr,
                            receiver,
                            drop
                        )
                        .then((signature) => {
                            common.log(
                                common.green(
                                    `Transaction completed for ${receiver.toString()}, signature: ${signature}`
                                )
                            );
                            db_updates.push({
                                updateOne: {
                                    filter: { wallet: record.wallet },
                                    update: { $set: { tx: signature } }
                                }
                            });
                        })
                        .catch((error) => {
                            common.error(
                                common.red(`Transaction failed for ${receiver.toString()}, error: ${error.message}`)
                            );
                            if (error.message.includes('Provided owner is not allowed')) {
                                db_updates.push({
                                    updateOne: {
                                        filter: { wallet: record.wallet },
                                        update: { $set: { tx: 'Provided owner is not allowed' } }
                                    }
                                });
                            }
                        })
                );

                count--;
            } catch (error) {
                common.error(`[ERROR] Failed to drop tokens to ${receiver.toString()}: ${error}`);
            }
        }
        await Promise.allSettled(transactions);
        await bulk_write(col_name, db_updates);
        await common.sleep(500);

        records = await collection?.find({ tx: null }).limit(RECORDS_PER_ITERATION).toArray();
        if (!records) throw new Error('Failed to fetch records');
    }
}

async function airdrop(percent: number, ui_balance: number, mint_meta: trade.MintMeta, drop: Keypair): Promise<void> {
    const airdrop_count = await count_records(AIRDROP_COLLECTION);
    if (airdrop_count === 0) {
        common.error(common.red('\nNo airdrop records found, skipping...'));
        return;
    }

    const airdrop_amount = calc_airdrop_amount(percent, ui_balance, airdrop_count);
    common.log(
        `\nAirdrop | Total token amount of ${mint_meta.token_symbol}: ${airdrop_amount} | Record count: ${airdrop_count}`
    );

    await common.to_confirm('Press ENTER to start the airdrop...');

    common.log(common.yellow(`\nStarting Airdrop...`));
    await update_airdrop_balance(airdrop_amount);
    await drop_tokens(AIRDROP_COLLECTION, drop, mint_meta);
    common.log(common.green(`Airdrop completed`));
}

async function presale(percent: number, ui_balance: number, mint_meta: trade.MintMeta, drop: Keypair): Promise<void> {
    const presale_count = await count_records(PRESALE_COLLECTION);
    if (presale_count === 0) {
        common.error(common.red('\nNo presale records found, skipping...'));
        return;
    }

    const { presale_tokens, presale_sol } = await calc_presale_amounts(percent, ui_balance);
    common.log(
        `\nPresale | Total Amount ${mint_meta.token_symbol}: ${presale_tokens} | Total SOL: ${presale_sol} | Record count: ${presale_count}`
    );

    await common.to_confirm('Press ENTER to start the presale drop...');

    common.log(common.yellow(`\nStarting Presale drop...`));
    await update_presale_balance(presale_tokens, presale_sol);
    await drop_tokens(PRESALE_COLLECTION, drop, mint_meta);
    common.log(common.green(`Presale drop completed`));
}

export async function execute(
    drop: Keypair,
    token_balance: number,
    mint_meta: trade.MintMeta,
    airdrop_percent: number,
    presale_percent: number
): Promise<void> {
    try {
        await connect_db();

        if (presale_percent !== 0) await presale(presale_percent, token_balance, mint_meta, drop);
        if (airdrop_percent !== 0) await airdrop(airdrop_percent, token_balance, mint_meta, drop);

        await close_db();
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`[ERROR] Failed to drop tokens: ${error.message}`);
        }
    }
}
