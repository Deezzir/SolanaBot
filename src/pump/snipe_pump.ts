import io from 'socket.io-client';
import { PartiallyDecodedInstruction, PublicKey } from '@solana/web3.js';
import * as common from '../common/common.js';
import * as trade from '../common/trade_common.js';
import * as snipe from '../common/snipe_common.js';
import { PumpTokenMeta, PUMP_TRADE_PROGRAM_ID, METAPLEX_PROGRAM_ID, FETCH_MINT_API_URL } from './trade_pump.js';

const WORKER_PATH = './dist/pump/worker_pump.js';

export class Runner extends snipe.SniperBase {
    private _subscription_id: number | undefined;
    private _logs_stop_func: (() => void) | null = null;
    private _fetch_stop_func: (() => void) | null = null;

    protected get_worker_path(): string {
        return WORKER_PATH;
    }

    async wait_drop_unsub(): Promise<void> {
        if (this._subscription_id !== undefined) {
            if (this._logs_stop_func) this._logs_stop_func();
            if (this._fetch_stop_func) this._fetch_stop_func();
            global.CONNECTION.removeOnLogsListener(this._subscription_id)
                .then(() => (this._subscription_id = undefined))
                .catch((err) => common.error(`[ERROR] Failed to unsubscribe from logs: ${err}`));
        }
    }

    async wait_drop_sub(token_name: string, token_ticker: string): Promise<PublicKey | null> {
        let name = token_name.toLowerCase();
        let ticker = token_ticker.toLowerCase();

        let search = [];

        search.push(
            new Promise<PublicKey | null>(async (resolve, reject) => {
                common.log('[Main Worker] Waiting for the new token drop using Websocket...');
                const socket = io(FETCH_MINT_API_URL, {
                    path: '/socket.io/',
                    // query: { offset: 0, limit: 100, sort: 'last_trade_timestamp', order: 'DESC', includeNsfw: true },
                    transports: ['websocket']
                });
                this._logs_stop_func = () => {
                    socket.disconnect();
                    reject(new Error('User stopped the process'));
                };
                socket.on('connect', () => {});
                socket.on('disconnect', () => {});

                socket.prependAny(async (event, ...obj) => {
                    if (event !== 'newCoinCreated') return;
                    const data_raw = obj[0];
                    if (!data_raw || !data_raw.data || !data_raw.data.subscribe || !data_raw.data.subscribe.data)
                        return;
                    const token_meta = JSON.parse(data_raw.data.subscribe.data).payload as PumpTokenMeta;
                    if (
                        token_meta.name.toLowerCase() === token_name.toLowerCase() &&
                        token_meta.symbol.toLowerCase() === ticker.toLocaleLowerCase()
                    ) {
                        this._logs_stop_func = null;
                        await this.wait_drop_unsub();
                        common.log(`[Main Worker] Found the mint using Websocket`);
                        socket.disconnect();
                        resolve(new PublicKey(token_meta.mint));
                    }
                });
            })
        );

        search.push(
            new Promise<PublicKey | null>((resolve, reject) => {
                let mint: PublicKey;
                this._logs_stop_func = () => reject(new Error('User stopped the process'));
                common.log('[Main Worker] Waiting for the new token drop using Solana logs...');
                this._subscription_id = global.CONNECTION.onLogs(
                    PUMP_TRADE_PROGRAM_ID,
                    async ({ err, logs, signature }) => {
                        if (err) return;
                        if (logs && logs.includes('Program log: Instruction: Create')) {
                            try {
                                const tx = await global.CONNECTION.getParsedTransaction(signature, {
                                    maxSupportedTransactionVersion: 0
                                });
                                if (!tx || !tx.meta || !tx.transaction.message || !tx.meta.postTokenBalances) return;

                                const inner_instructions = tx.meta.innerInstructions;
                                if (!inner_instructions) return;

                                for (const inner of inner_instructions) {
                                    for (const instruction of inner.instructions) {
                                        if (!instruction.programId.equals(METAPLEX_PROGRAM_ID)) continue;

                                        const partial = instruction as PartiallyDecodedInstruction;
                                        const [meta, bytes_read] = trade.decode_metaplex_instr(partial.data);
                                        if (bytes_read <= 0) continue;
                                        if (
                                            meta.data.name.toLowerCase() === name.toLowerCase() &&
                                            meta.data.symbol.toLowerCase() === ticker.toLowerCase()
                                        ) {
                                            if (tx.meta.postTokenBalances[0].mint)
                                                mint = new PublicKey(tx.meta.postTokenBalances[0].mint);
                                            else mint = partial.accounts[1];
                                        }
                                    }
                                }
                                const signers = tx.transaction.message.accountKeys.filter((key) => key.signer);
                                if (signers.some(({ pubkey }) => mint !== undefined && pubkey.equals(mint))) {
                                    this._logs_stop_func = null;
                                    await this.wait_drop_unsub();
                                    common.log(`[Main Worker] Found the mint using Solana logs`);
                                    resolve(mint);
                                }
                            } catch (err) {
                                common.error(`[ERROR] Failed fetching the parsed transaction: ${err}`);
                            }
                        }
                    },
                    'confirmed'
                );
                if (this._subscription_id === undefined) reject(new Error('Failed to subscribe to logs'));
            })
        );

        return Promise.race(search)
            .then((result) => {
                if (!result) return null;
                return result;
            })
            .catch((error) => {
                common.error(`[ERROR] An error occurred: ${error}`);
                return null;
            });
    }
}
