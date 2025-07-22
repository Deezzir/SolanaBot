import { PumpTrader, PumpRunner } from '../pump/pump.js';
import { MoonitTrader, MoonitRunner } from '../moonit/moonit.js';
import { JupiterTrader } from '../generic/jupiter.js';
import { MeteoraRunner, MeteoraTrader } from '../meteora/meteora.js';
import { Program } from './common.js';
import { IProgramTrader } from './trade_common.js';
import { ISniper } from './snipe_common.js';
import { BonkRunner, BonkTrader } from '../bonk/bonk.js';

export function get_trader(program: Program): IProgramTrader {
    switch (program) {
        case Program.Pump: {
            return PumpTrader;
        }
        case Program.Moonit: {
            return MoonitTrader;
        }
        case Program.Meteora: {
            return MeteoraTrader;
        }
        case Program.Generic: {
            return JupiterTrader;
        }
        case Program.Bonk: {
            return BonkTrader;
        }
        default: {
            throw new Error(`Invalid program received: ${program}`);
        }
    }
}

export function get_sniper(program: Program): ISniper {
    const trader = get_trader(program);
    switch (program) {
        case Program.Pump: {
            return new PumpRunner(trader);
        }
        case Program.Moonit: {
            return new MoonitRunner(trader);
        }
        case Program.Meteora: {
            return new MeteoraRunner(trader);
        }
        case Program.Bonk: {
            return new BonkRunner(trader);
        }
        case Program.Generic: {
            throw new Error('Generic program is not supported for sniping.');
        }
        default: {
            throw new Error(`Invalid program received: ${program}`);
        }
    }
}
