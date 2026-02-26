import {
    PUMP_CREATE_V1_DISCRIMINATOR,
    PUMP_CREATE_V2_DISCRIMINATOR,
    PUMP_MINT_AUTHORITY_ACCOUNT,
    PUMP_PROGRAM_ID
} from '../constants';
import * as snipe from '../common/snipe_common';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

export class Runner extends snipe.SniperBase {
    protected mint_authority = PUMP_MINT_AUTHORITY_ACCOUNT;
    protected program_id = PUMP_PROGRAM_ID;

    protected is_create_tx(logs: string[]): boolean {
        return logs.some((log) => log.includes('Program log: Instruction: Create'));
    }

    protected decode_create_instr(data: Uint8Array): { name: string; symbol: string; misc?: object } | null {
        try {
            if (data.length < 18) return null;

            const prefix_v1 = Uint8Array.from(PUMP_CREATE_V1_DISCRIMINATOR);
            const prefix_v2 = Uint8Array.from(PUMP_CREATE_V2_DISCRIMINATOR);
            const data_prefix = Buffer.from(data.slice(0, 8));
            if (!data_prefix.equals(prefix_v1) && !data_prefix.equals(prefix_v2)) return null;

            const name_length = data[8];
            const name_start = 8 + 4;
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

            const creator_start = uri_end;
            const creator_end = creator_start + 32;
            const creator = new PublicKey(data.slice(creator_start, creator_end));

            let is_mayhem = false;
            let token_program = TOKEN_PROGRAM_ID;
            if (data_prefix.equals(prefix_v2)) {
                const mayhem_mode_byte = data[creator_end];
                is_mayhem = mayhem_mode_byte === 1;
                token_program = TOKEN_2022_PROGRAM_ID;
            }
            const misc = { uri, creator: creator.toBase58(), is_mayhem, token_program: token_program.toBase58() };
            return { name, symbol, misc };
        } catch (err) {
            return null;
        }
    }
}
