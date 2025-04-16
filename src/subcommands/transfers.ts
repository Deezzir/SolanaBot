import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import {
    COMMANDS_INTERVAL_MS,
    PriorityLevel,
    SPIDER_EXTRA_SOL,
    SPIDER_INTERVAL_MS,
    SPIDER_RESCUE_DIR_PATH,
    WALLETS_FILE_HEADERS
} from '../constants.js';
import path from 'path';
import * as common from '../common/common.js';
import * as trade from '../common/trade_common.js';
import bs58 from 'bs58';

type SpiderTreeNode = {
    amount: number;
    left: SpiderTreeNode | null;
    right: SpiderTreeNode | null;
    keypair: Keypair;
};

type SpiderTree = {
    head: SpiderTreeNode | null;
    depth: number;
};

function build_spider_tree(tree: SpiderTree, amount: number, keys_cnt: number, payer: Keypair): SpiderTree {
    if (tree.head) return tree;

    let wallet_cnt_tmp = keys_cnt;
    let layer_cnt = tree.depth;
    tree.head = {
        amount: 0,
        left: null,
        right: null,
        keypair: payer
    } as SpiderTreeNode;

    const _build_tree = (node: SpiderTreeNode | null, layer_cnt: number): SpiderTreeNode | null => {
        if (layer_cnt === 0 || wallet_cnt_tmp === 0) return null;
        if (layer_cnt === 1) wallet_cnt_tmp--;

        if (node === null) {
            node = {
                amount: amount,
                left: null,
                right: null,
                keypair: new Keypair()
            } as SpiderTreeNode;
        }

        node.right = _build_tree(node.right, layer_cnt - 1);
        node.left = _build_tree(node.left, layer_cnt - 1);

        if (node.right || node.left) node.amount = (node.left?.amount || 0) + (node.right?.amount || 0);
        if (node.right) node.amount += SPIDER_EXTRA_SOL;
        if (node.left) node.amount += SPIDER_EXTRA_SOL;

        return node;
    };

    tree.head = _build_tree(tree.head, layer_cnt);
    return tree;
}

function display_spider_tree(tree: SpiderTree) {
    if (!tree.head) return;

    common.log(`[Main Worker] Spider tree depth: ${tree.depth}`);

    const _display_spider_tree = (
        node: SpiderTreeNode | null,
        layer_cnt: number = 0,
        prefix: string = '',
        isLeft: boolean = true
    ) => {
        if (node === null) return;

        const connector = layer_cnt === 0 ? ' ' : isLeft ? '├── ' : '└── ';
        const child_prefix = prefix + (layer_cnt === 0 ? ' ' : isLeft ? '│   ' : '    ');
        const node_display = `${node.amount.toFixed(4)} SOL - ${node.keypair.publicKey.toString()}`;

        common.log(`${prefix}${layer_cnt === 0 ? ' ' : '│'}`);
        common.log(`${prefix}${connector}${node_display}`);

        if (node.left || node.right) {
            if (node.left) {
                _display_spider_tree(node.left, layer_cnt + 1, child_prefix, true);
            }

            if (node.right) {
                _display_spider_tree(node.right, layer_cnt + 1, child_prefix, false);
            }
        }
    };

    _display_spider_tree(tree.head);
    common.log('');
}

function setup_rescue_file(): string | undefined {
    const file_name = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '').replace(' ', '_');
    const target_file = `${file_name}.csv`;
    const target_file_path = path.join(SPIDER_RESCUE_DIR_PATH, target_file);

    try {
        if (!existsSync(SPIDER_RESCUE_DIR_PATH)) mkdirSync(SPIDER_RESCUE_DIR_PATH);
        try {
            if (existsSync(target_file_path)) throw 'Target already exists';
            writeFileSync(target_file_path, WALLETS_FILE_HEADERS.join(',') + '\n', 'utf-8');
            return target_file_path;
        } catch (error) {
            common.error(`[ERROR] Failed to process target rescue entry '${target_file_path}': ${error}`);
            return;
        }
    } catch (error) {
        common.error(`[ERROR] Failed to process '${SPIDER_RESCUE_DIR_PATH}': ${error}`);
        return;
    }
}

function save_rescue_key(keypair: Keypair, target_file_path: string, layer_cnt: number, index: number): boolean {
    const key_name = `wallet${layer_cnt}_${index}`;
    const private_key = bs58.encode(keypair.secretKey);
    const public_key = keypair.publicKey.toString();
    const date = new Date().toLocaleDateString();

    if (existsSync(target_file_path)) {
        try {
            const row = [key_name, private_key, false, public_key, date].join(',');
            appendFileSync(target_file_path, row + '\n', 'utf8');
            return true;
        } catch (error) {
            common.error(`[ERROR] Failed to write a wallet to a rescue file: ${error}`);
            return false;
        }
    }
    return false;
}

function backup_spider_tree(tree: SpiderTree): string | undefined {
    if (!tree.head) return;

    const target_file = setup_rescue_file();
    if (!target_file) return;

    let postfixes: Map<number, number> = new Map();

    const _backup_spider_tree = (node: SpiderTreeNode | null, layer_cnt: number = 0): boolean => {
        if (node === null) return true;

        postfixes.set(layer_cnt, (postfixes.get(layer_cnt) ?? 0) + 1);
        const ok = save_rescue_key(node.keypair, target_file, layer_cnt, postfixes.get(layer_cnt) || 0);
        if (!ok) return false;

        if (node.left) {
            const ok = _backup_spider_tree(node.left, layer_cnt + 1);
            if (!ok) return false;
        }

        if (node.right) {
            const ok = _backup_spider_tree(node.right, layer_cnt + 1);
            if (!ok) return false;
        }

        return true;
    };

    const ok = _backup_spider_tree(tree.head);
    if (!ok) {
        common.error(
            `[ERROR] Something went wrong during the spider transfer, check the rescue file for wallet backups`
        );
    } else {
        common.log(`[Main Worker] Successfully backed the keys up for the spider transfer`);
    }
    return target_file;
}

async function process_inner_transfers(tree: SpiderTree): Promise<Keypair[] | undefined> {
    if (!tree.head) return;
    const entries: Keypair[] = [];

    let postfixes: Map<number, number> = new Map();

    const _process_inner_transfers = async (node: SpiderTreeNode | null, layer_cnt: number = 0): Promise<boolean> => {
        if (node === null) return true;
        if (layer_cnt === tree.depth - 1) entries.push(node.keypair);

        postfixes.set(layer_cnt, (postfixes.get(layer_cnt) ?? 0) + 1);

        if (node.left) {
            const amount = node.left.amount;
            const sol_amount = Math.ceil(amount * LAMPORTS_PER_SOL);
            const sender = node.keypair;
            const receiver = node.left.keypair;
            const layer_name = `${layer_cnt}_${postfixes.get(layer_cnt) || 0}`;

            common.log(
                `${sender.publicKey.toString().padEnd(44, ' ')} is sending ${amount.toFixed(4).padEnd(7, ' ')} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')} (Layer: ${layer_name})...`
            );

            try {
                const sig = await trade.send_lamports_with_retries(
                    sol_amount,
                    sender,
                    receiver.publicKey,
                    PriorityLevel.DEFAULT
                );
                common.log(`Transaction completed for ${layer_name}, signature: ${sig}`);
            } catch (error) {
                common.error(`[ERROR] Failed to send lamports: ${error}`);
                return false;
            }

            await common.sleep(SPIDER_INTERVAL_MS);

            const ok = await _process_inner_transfers(node.left, layer_cnt + 1);
            if (!ok) return false;
        }

        if (node.right) {
            const amount = node.right.amount;
            const sol_amount = Math.ceil(amount * LAMPORTS_PER_SOL);
            const sender = node.keypair;
            const receiver = node.right.keypair;
            const layer_name = `${layer_cnt}_${postfixes.get(layer_cnt) || 0}`;

            common.log(
                `${sender.publicKey.toString().padEnd(44, ' ')} is sending ${amount.toFixed(4).padEnd(7, ' ')} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')} (Layer: ${layer_name}})...`
            );
            try {
                let sig = await trade.send_lamports_with_retries(
                    sol_amount,
                    sender,
                    receiver.publicKey,
                    PriorityLevel.DEFAULT
                );
                common.log(`Transaction completed for ${layer_name}, signature: ${sig}`);
            } catch (error) {
                common.error(`[ERROR] Failed to send lamports: ${error}`);
                return false;
            }

            await common.sleep(SPIDER_INTERVAL_MS);

            const ok = await _process_inner_transfers(node.right, layer_cnt + 1);
            if (!ok) return false;
        }

        return true;
    };

    const ok = await _process_inner_transfers(tree.head);
    if (!ok) {
        common.error(`[ERROR] Something went wrong during the spider transfer, check the logs for details`);
        return;
    }

    return entries;
}

async function process_final_transfers(wallets: common.Wallet[], entries: Keypair[]): Promise<void> {
    if (entries.length === 0) return;
    if (entries.length !== wallets.length) {
        common.error(`[ERROR] The number of entries doesn't match the number of keys`);
        return;
    }

    const transactions: Promise<String>[] = [];

    for (const [i, wallet] of wallets.entries()) {
        const sender = entries[i];
        const receiver = wallet.keypair;
        const amount = await trade.get_balance(sender.publicKey);
        if (amount <= 0) continue;

        common.log(
            `${sender.publicKey.toString().padEnd(44, ' ')} is sending ${(amount / LAMPORTS_PER_SOL).toFixed(3).padEnd(7, ' ')} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')}...`
        );
        transactions.push(trade.send_lamports_with_retries(amount, sender, receiver.publicKey, PriorityLevel.DEFAULT));

        await common.sleep(50);
    }

    const results = await Promise.all(transactions);
    if (results.every((result) => result)) {
        common.log(`[Main Worker] All transactions completed successfully`);
    } else {
        common.error(`[Main Worker] Some transactions failed, check the logs for details`);
    }
}

export async function run_spider_transfer(
    keys: common.Wallet[],
    amount: number,
    sender: Keypair
): Promise<common.Wallet[]> {
    const keys_cnt = keys.length;

    let tree = {
        head: null,
        depth: Math.ceil(Math.log2(keys_cnt)) + 1
    } as SpiderTree;

    tree = build_spider_tree(tree, amount, keys_cnt, sender);
    display_spider_tree(tree);

    const target_file = backup_spider_tree(tree);
    if (!target_file) throw new Error('Failed to create a target file for the spider transfer');
    const rescue_keys = common.get_wallets(target_file);

    common.log(`[Main Worker] Processing inner transfers...\n`);
    const final_entries = await process_inner_transfers(tree);
    await common.sleep(SPIDER_INTERVAL_MS * 2);

    if (final_entries) {
        common.log(`\n[Main Worker] Processing final transfers...\n`);
        await process_final_transfers(keys, final_entries);
        await common.sleep(SPIDER_INTERVAL_MS * 2);
    }

    return rescue_keys;
}

export async function run_deep_transfer(
    wallets: common.Wallet[],
    amounts: number[],
    sender: Keypair,
    depth: number
): Promise<common.Wallet[]> {
    const target_file = setup_rescue_file();
    if (!target_file) throw new Error('Failed to create a target file for the spider transfer');

    const transfer_map = wallets.map((wallet, index) => {
        const amount = amounts[index];
        const path = [
            sender,
            ...Array.from({ length: depth }, () => {
                const pair = new Keypair();
                save_rescue_key(pair, target_file, 0, index);
                return pair;
            }),
            wallet.keypair
        ];

        return {
            amount,
            wallet,
            path
        };
    });

    const failed: { name: string; id: number }[] = [];
    for (const entry of transfer_map) {
        const wallet = entry.wallet;
        const topup_amount = entry.amount;

        common.log(
            common.bold(
                `Sending ${topup_amount} SOL to ${wallet.keypair.publicKey.toString()} ${wallet.name} (${wallet.id})...`
            )
        );

        for (let index = 1; index < entry.path.length; index++) {
            const sender = entry.path[index - 1];
            const receiver = entry.path[index];

            try {
                const signature = await trade.send_lamports_with_retries(
                    topup_amount * LAMPORTS_PER_SOL,
                    sender,
                    receiver.publicKey,
                    PriorityLevel.HIGH
                );
                common.log(
                    common.green(`Transaction completed for ${wallet.name}, signature: ${signature}, depth: ${index}`)
                );
            } catch (error) {
                common.error(common.red(`Transaction failed for ${wallet.name}: ${error}, depth: ${index}`));
                failed.push({ name: wallet.name, id: wallet.id });
                break;
            }
            await common.sleep(SPIDER_INTERVAL_MS);
        }
        common.log(common.bold(`Finished sending to ${wallet.name} (${wallet.id})\n`));
    }

    if (failed.length > 0) {
        common.error(common.red(`Failed transactions:`));
        for (const item of failed) common.error(common.bold(`Wallet: ${item.name} (${item.id})`));
    }

    return common.get_wallets(target_file);
}

export async function run_reg_transfer(wallets: common.Wallet[], amounts: number[], sender: Keypair): Promise<void> {
    if (amounts.length !== wallets.length) throw new Error('The number of entries does not match the number of keys');

    const transactions = [];
    const failed: { name: string; id: number }[] = [];

    for (const [i, wallet] of wallets.entries()) {
        const receiver = wallet.keypair;
        const topup_amount = amounts[i];
        if (receiver.publicKey.equals(sender.publicKey)) continue;

        common.log(
            `Sending ${topup_amount} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')} ${wallet.name} (${wallet.id})...`
        );
        transactions.push(
            trade
                .send_lamports(topup_amount * LAMPORTS_PER_SOL, sender, receiver.publicKey, PriorityLevel.HIGH)
                .then((signature) =>
                    common.log(common.green(`Transaction completed for ${wallet.name}, signature: ${signature}`))
                )
                .catch((error) => {
                    common.error(common.red(`Transaction failed for ${wallet.name}: ${error.message}`));
                    failed.push({ name: wallet.name, id: wallet.id });
                })
        );

        await common.sleep(COMMANDS_INTERVAL_MS);
    }
    await Promise.allSettled(transactions);

    if (failed.length > 0) {
        common.error(common.red(`\nFailed transactions:`));
        for (const item of failed) common.error(common.bold(`Wallet: ${item.name} (${item.id})`));
    }
}
