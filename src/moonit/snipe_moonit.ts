import { PublicKey } from '@solana/web3.js';
import * as snipe from '../common/snipe_common';

export class Runner extends snipe.SniperBase {
    protected mint_authority = new PublicKey('Placeholder');
    protected program_id = new PublicKey('Placeholder');

    protected is_create_tx(_logs: string[]): boolean {
        throw new Error('is_create_tx not implemented');
    }

    protected decode_create_instr(_data: Uint8Array): { name: string; symbol: string; misc?: object } | null {
        throw new Error('decode_create_instr not implemented');
    }
}
