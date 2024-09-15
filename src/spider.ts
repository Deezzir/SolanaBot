import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import * as common from './common.js';
import * as commands from './commands.js';
import * as trade from './trade_common.js';

const RESCUE_DIR_PATH: string = process.env.PROCESS_DIR_PATH || './.rescue';
const MAX_RETRIES: number = 3;
const EXTRA_SOL: number = 0.005;
const INTERVAL: number = 1000;

type SpiderTreeNode = {
    amount: number,
    left: SpiderTreeNode | null,
    right: SpiderTreeNode | null,
    keypair: Keypair
};

type SpiderTree = {
    head: SpiderTreeNode | null
    depth: number
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
        if (node.right) node.amount += EXTRA_SOL;
        if (node.left) node.amount += EXTRA_SOL;

        return node;
    }

    tree.head = _build_tree(tree.head, layer_cnt);
    return tree;
}

function display_spider_tree(tree: SpiderTree) {
    if (!tree.head) return;

    common.log(`[Main Worker] Spider tree depth: ${tree.depth}`);

    const _display_spider_tree = (node: SpiderTreeNode | null, layer_cnt: number = 0, prefix: string = '', isLeft: boolean = true) => {
        if (node === null) return;

        const connector = layer_cnt === 0 ? ' ' : (isLeft ? '├── ' : '└── ');
        const child_prefix = prefix + (layer_cnt === 0 ? ' ' : (isLeft ? '│   ' : '    '));
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
    }

    _display_spider_tree(tree.head);
    common.log('');
}

function setup_rescue_dir(layers_cnt: number): string | undefined {
    const target_folder = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '').replace(' ', '_');
    const target_folder_path = path.join(RESCUE_DIR_PATH, target_folder);

    try {
        if (!existsSync(RESCUE_DIR_PATH)) mkdirSync(RESCUE_DIR_PATH);
        try {
            if (existsSync(target_folder_path)) throw 'Target already exists';
            mkdirSync(target_folder_path);

            for (let i: number = 0; i < layers_cnt; i++) mkdirSync(path.join(target_folder_path, `layer_${i}`));

            return target_folder_path;
        } catch (error) {
            common.error(`[ERROR] Failed to process target rescue entry '${target_folder_path}': ${error}`);
            return;
        }
    } catch (error) {
        common.error(`[ERROR] Failed to process '${RESCUE_DIR_PATH}': ${error}`);
        return;
    }
}

function save_rescue_key(node: SpiderTreeNode, target_folder: string, layer_cnt: number, index: number): boolean {
    const key_file_name = `key${layer_cnt}_${index}.json`;
    const key_file_path = path.join(target_folder, path.join(`layer_${layer_cnt}`, key_file_name));
    if (!existsSync(key_file_path)) {
        try {
            writeFileSync(key_file_path, JSON.stringify(Array.from(node.keypair.secretKey)), 'utf8');
            return true;
        } catch (error) {
            common.error(`[ERROR] Failed to write a key to a rescue folder: ${error}`);
            return false;
        }
    }
    return true;
}

function backup_spider_tree(tree: SpiderTree): string | undefined {
    if (!tree.head) return;

    const target_folder = setup_rescue_dir(tree.depth);
    if (!target_folder) return;

    let postfixes: Map<number, number> = new Map();

    const _backup_spider_tree = (node: SpiderTreeNode | null, layer_cnt: number = 0): boolean => {
        if (node === null) return true;

        postfixes.set(layer_cnt, (postfixes.get(layer_cnt) ?? 0) + 1);
        const ok = save_rescue_key(node, target_folder, layer_cnt, postfixes.get(layer_cnt) || 0);
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
    }

    const ok = _backup_spider_tree(tree.head);
    if (!ok) {
        common.error(`[ERROR] Something went wrong during the spider transfer, check the rescue folder for key backups`);
    } else {
        common.log(`[Main Worker] Successfully backed the keys up for the spider transfer`)
    }
    return target_folder;
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

            common.log(`${sender.publicKey.toString().padEnd(44, ' ')} is sending ${amount.toFixed(4).padEnd(7, ' ')} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')} (Layer: ${layer_name})...`);

            let ok = await send_lamports_with_retries(sol_amount, sender, receiver, common.PriorityLevel.HIGH, layer_name);
            if (!ok) return false;

            await common.sleep(INTERVAL);

            ok = await _process_inner_transfers(node.left, layer_cnt + 1);
            if (!ok) return false;
        }

        if (node.right) {
            const amount = node.right.amount;
            const sol_amount = Math.ceil(amount * LAMPORTS_PER_SOL);
            const sender = node.keypair;
            const receiver = node.right.keypair;
            const layer_name = `${layer_cnt}_${postfixes.get(layer_cnt) || 0}`;

            common.log(`${sender.publicKey.toString().padEnd(44, ' ')} is sending ${amount.toFixed(4).padEnd(7, ' ')} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')} (Layer: ${layer_name}})...`);

            let ok = await send_lamports_with_retries(sol_amount, sender, receiver, common.PriorityLevel.HIGH, layer_name);
            if (!ok) return false;

            await common.sleep(INTERVAL);

            ok = await _process_inner_transfers(node.right, layer_cnt + 1);
            if (!ok) return false;
        }

        return true;
    }

    const ok = await _process_inner_transfers(tree.head)
    if (!ok) {
        common.error(`[ERROR] Something went wrong during the spider transfer, check the logs for details`);
        return;
    }

    return entries;
}

async function send_lamports_with_retries(amount: number, sender: Keypair, receiver: Keypair, priority: common.PriorityLevel, name: string, max_retries: number = MAX_RETRIES): Promise<boolean> {
    for (let attempt = 1; attempt <= max_retries; attempt++) {
        try {
            const signature = await trade.send_lamports(amount, sender, receiver.publicKey, priority);
            common.log(`Transaction completed for ${name}, signature: ${signature} `);
            return true;
        } catch (error) {
            if (attempt < max_retries) {
                common.error(`Transaction failed for ${name}, attempt ${attempt}. Retrying...`);
                await common.sleep(INTERVAL * 3);
                amount = await trade.get_balance(sender.publicKey);
            } else {
                common.error(`Transaction failed for ${name} after ${max_retries} attempts: ${error}`);
            }
        }
    }
    return false;
}

async function process_final_transfers(keys: common.Key[], entries: Keypair[]): Promise<void> {
    if (entries.length === 0) return;
    if (entries.length !== keys.length) {
        common.error(`[ERROR] The number of entries doesn't match the number of keys`);
        return;
    }

    const transactions: Promise<boolean>[] = [];

    for (const [i, key] of keys.entries()) {
        const sender = entries[i];
        const receiver = key.keypair;
        const amount = await trade.get_balance(sender.publicKey);
        if (amount <= 0) continue;

        common.log(`${sender.publicKey.toString().padEnd(44, ' ')} is sending ${(amount / LAMPORTS_PER_SOL).toFixed(3).padEnd(7, ' ')} SOL to ${receiver.publicKey.toString().padEnd(44, ' ')}...`);
        transactions.push(send_lamports_with_retries(amount, sender, receiver, common.PriorityLevel.HIGH, key.file_name));

        await common.sleep(50);
    }

    const results = await Promise.all(transactions);
    if (results.every(result => result)) {
        common.log(`[Main Worker] All transactions completed successfully`);
    } else {
        common.error(`[Main Worker] Some transactions failed, check the logs for details`);
    }
}

export async function run_spider_transfer(keys: common.Key[], amount: number, payer: Keypair) {
    const keys_cnt = keys.length;

    let tree = {
        head: null,
        depth: Math.ceil(Math.log2(keys_cnt)) + 1,
    } as SpiderTree;

    tree = build_spider_tree(tree, amount, keys_cnt, payer);
    display_spider_tree(tree);

    const target_folder = backup_spider_tree(tree);
    if (!target_folder) return;
    const rescue_keys = await common.get_rescue_keys(target_folder);

    common.log(`[Main Worker] Processing inner transfers...\n`);
    const final_entries = await process_inner_transfers(tree);
    await common.sleep(INTERVAL * 2);

    if (final_entries) {
        common.log(`\n[Main Worker] Processing final transfers...\n`);
        await process_final_transfers(keys, final_entries);
        await common.sleep(INTERVAL * 2);
    }

    common.log(`\n[Main Worker] Performing cleanup of the temporary wallets...\n`);
    await commands.collect(rescue_keys, payer.publicKey)
}
