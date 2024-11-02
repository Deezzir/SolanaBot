import * as snipe from '../common/snipe_common.js';
import * as common from '../common/common.js';
import { PublicKey } from '@solana/web3.js';
import { Trader } from './trade_moon.js';

const WORKER_PATH = './dist/moon_worker.js';

export class Runner extends snipe.SniperBase {
    private _subscription_id: number | undefined;
    private _logs_stop_func: (() => void) | null = null;
    private _fetch_stop_func: (() => void) | null = null;

    protected get_worker_path(): string {
        throw new Error('Not Implemented');
        return WORKER_PATH;
    }

    protected get_trader(): typeof Trader {
        return Trader;
    }

    protected async wait_drop_unsub(): Promise<void> {
        if (this._subscription_id !== undefined) {
            if (this._logs_stop_func) this._logs_stop_func();
            if (this._fetch_stop_func) this._fetch_stop_func();
            global.CONNECTION.removeOnLogsListener(this._subscription_id)
                .then(() => (this._subscription_id = undefined))
                .catch((err) => common.error(`[ERROR] Failed to unsubscribe from logs: ${err}`));
        }
    }

    protected async wait_drop_sub(_token_name: string, _token_ticker: string): Promise<PublicKey | null> {
        throw new Error('Not Implemented');
    }
}
