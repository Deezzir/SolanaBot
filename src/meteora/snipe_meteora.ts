import { METEORA_DBC_PROGRAM_ID, METEORA_DBC_POOL_AUTHORITY } from '../constants';
import * as snipe from '../common/snipe_common';

export class Runner extends snipe.SniperBase {
    protected mint_authority = METEORA_DBC_POOL_AUTHORITY;
    protected program_id = METEORA_DBC_PROGRAM_ID;

    protected is_create_tx(logs: string[]): boolean {
        return logs.some((log) => log.includes('Program log: Instruction: InitializeVirtualPoolWithSplToken'));
    }

    protected decode_create_instr(data: Uint8Array): { name: string; symbol: string; misc?: object } | null {
        try {
            if (data.length < 18) return null;

            const prefix = Uint8Array.from([0x8c, 0x55, 0xd7, 0xb0, 0x66, 0x36, 0x68, 0x4f]);
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
}
