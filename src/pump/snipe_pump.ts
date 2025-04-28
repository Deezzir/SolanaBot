import { PublicKey } from '@solana/web3.js';
import { COMMITMENT, PUMP_MINT_AUTHORITY_ACCOUNT, PUMP_TRADE_PROGRAM_ID } from '../constants.js';
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

    decode_create_instr(data: Uint8Array): { name: string; symbol: string } | null {
        try {
            if (data.length < 18) return null;

            const prefix = Uint8Array.from([0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77]);
            const data_prefix = Buffer.from(data.slice(0, 8));
            if (!data_prefix.equals(prefix)) return null;

            const name_length = data[8];
            const name_start = 8 + 4;
            const name_end = name_start + name_length;
            const name = Buffer.from(data.slice(name_start, name_end)).toString('utf-8');

            const symbol_length = data[name_end];
            const symbol_start = name_end + 4;
            const symbol_end = symbol_start + symbol_length;
            const symbol = Buffer.from(data.slice(symbol_start, symbol_end)).toString('utf-8');

            return { name, symbol };
        } catch (err) {
            return null;
        }
    }

    async wait_drop_unsub(): Promise<void> {
        if (this._subscription_id !== undefined) {
            if (this._logs_stop_func) this._logs_stop_func();
            global.CONNECTION.removeOnLogsListener(this._subscription_id)
                .then(() => (this._subscription_id = undefined))
                .catch((err) => common.error(common.red(`Failed to unsubscribe from logs: ${err}`)));
        }
    }

    async wait_drop_sub(token_name: string, token_ticker: string): Promise<PublicKey | null> {
        const name = token_name.toLowerCase();
        const ticker = token_ticker.toLowerCase();

        return new Promise<PublicKey | null>((resolve, reject) => {
            this._logs_stop_func = () => reject(new Error('User stopped the process'));
            common.log('[Main Worker] Waiting for the new token drop using Solana logs...');

            this._subscription_id = global.CONNECTION.onLogs(
                PUMP_MINT_AUTHORITY_ACCOUNT,
                async ({ err, logs, signature }) => {
                    if (err) return;
                    if (logs && logs.includes('Program log: Instruction: Create')) {
                        try {
                            const tx = await trade.get_tx_with_retries(signature);
                            if (!tx || !tx.meta || !tx.transaction.message) return;

                            const instructions = tx.transaction.message.compiledInstructions;
                            const address_lookup = tx.transaction.message.getAccountKeys();

                            for (const instr of instructions) {
                                const program_id = address_lookup.get(instr.programIdIndex);
                                const mint = address_lookup.get(1);

                                if (!program_id || !program_id.equals(PUMP_TRADE_PROGRAM_ID)) continue;
                                const result = this.decode_create_instr(instr.data);
                                if (!result) continue;

                                if (
                                    result.name.toLowerCase() === name &&
                                    result.symbol.toLowerCase() === ticker &&
                                    mint
                                ) {
                                    this._logs_stop_func = null;
                                    await this.wait_drop_unsub();
                                    common.log(`[Main Worker] Found the mint using Solana logs`);
                                    resolve(mint);
                                }
                            }
                        } catch (err) {
                            common.error(common.red(`Failed fetching the parsed transaction: ${err}`));
                        }
                    }
                },
                COMMITMENT
            );

            if (this._subscription_id === undefined) {
                reject(new Error('Failed to subscribe to logs'));
            }
        }).catch(() => {
            return null;
        });
    }
}
