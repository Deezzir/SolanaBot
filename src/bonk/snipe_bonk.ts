import {
    RAYDIUM_LAUNCHPAD_AUTHORITY,
    RAYDIUM_LAUNCHPAD_CREATE_DISCRIMINATOR,
    RAYDIUM_LAUNCHPAD_PROGRAM_ID
} from '../constants';
import * as snipe from '../common/snipe_common';

export class Runner extends snipe.SniperBase {
    protected mint_authority = RAYDIUM_LAUNCHPAD_AUTHORITY;
    protected program_id = RAYDIUM_LAUNCHPAD_PROGRAM_ID;

    protected is_create_tx(logs: string[]): boolean {
        return logs.some((log) => log.includes('Program log: Instruction: InitializeV2'));
    }

    protected decode_create_instr(data: Uint8Array): { name: string; symbol: string; misc?: object } | null {
        try {
            if (data.length < 18) return null;

            const prefix = Uint8Array.from(RAYDIUM_LAUNCHPAD_CREATE_DISCRIMINATOR);
            const data_prefix = Buffer.from(data.slice(0, 8));
            if (!data_prefix.equals(prefix)) return null;

            const decimals = data[8];

            const name_length = data[9];
            const name_start = 9 + 4;
            const name_end = name_start + name_length;
            const name = Buffer.from(data.slice(name_start, name_end)).toString('utf-8');

            const symbol_length = data[name_end];
            const symbol_start = name_end + 4;
            const symbol_end = symbol_start + symbol_length;
            const symbol = Buffer.from(data.slice(symbol_start, symbol_end)).toString('utf-8');

            const uri_length = data[symbol_end];
            const uri_start = symbol_end + 4;
            const uri_end = uri_start + uri_length;
            const uri = Buffer.from(data.slice(uri_start, uri_end)).toString('utf-8');

            return { name, symbol, misc: { uri, decimals } };
        } catch (err) {
            return null;
        }
    }
}
