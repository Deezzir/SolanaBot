import { PublicKey } from '@solana/web3.js';
import { COMMITMENT, METAPLEX_PROGRAM_ID, PUMP_TRADE_PROGRAM_ID } from '../constants.js';
import * as common from '../common/common.js';
import * as trade from '../common/trade_common.js';
import * as snipe from '../common/snipe_common.js';

const WORKER_PATH = './dist/pump/worker_pump.js';

export class Runner extends snipe.SniperBase {
    private _subscription_id: number | undefined;
    private _logs_stop_func: (() => void) | null = null;

    protected get_worker_path(): string {
        return WORKER_PATH;
    }

    async wait_drop_unsub(): Promise<void> {
        if (this._subscription_id !== undefined) {
            if (this._logs_stop_func) this._logs_stop_func();
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
            new Promise<PublicKey | null>((resolve, reject) => {
                this._logs_stop_func = () => reject(new Error('User stopped the process'));
                common.log('[Main Worker] Waiting for the new token drop using Solana logs...');

                this._subscription_id = global.CONNECTION.onLogs(
                    PUMP_TRADE_PROGRAM_ID,
                    async ({ err, logs, signature }) => {
                        if (err) return;
                        if (logs && logs.includes('Program log: Instruction: Create')) {
                            try {
                                const tx = await trade.get_tx_with_retries(signature);
                                if (!tx || !tx.meta || !tx.transaction.message) return;

                                const inner_instructions = tx.meta.innerInstructions;
                                const address_lookup = tx.transaction.message.getAccountKeys();
                                if (!inner_instructions) return;

                                for (const inner of inner_instructions) {
                                    for (const instruction of inner.instructions) {
                                        const program_id = address_lookup.get(instruction.programIdIndex);
                                        const mint = address_lookup.get(1);

                                        if (!program_id || !program_id.equals(METAPLEX_PROGRAM_ID)) continue;
                                        const [meta, bytes_read] = trade.decode_metaplex_instr(instruction.data);
                                        if (bytes_read <= 0) continue;

                                        if (
                                            meta.data.name.toLowerCase() === name.toLowerCase() &&
                                            meta.data.symbol.toLowerCase() === ticker.toLowerCase() &&
                                            mint
                                        ) {
                                            this._logs_stop_func = null;
                                            await this.wait_drop_unsub();
                                            common.log(`[Main Worker] Found the mint using Solana logs`);
                                            resolve(mint);
                                        }
                                    }
                                }
                            } catch (err) {
                                common.error(`[ERROR] Failed fetching the parsed transaction: ${err}`);
                            }
                        }
                    },
                    COMMITMENT
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
