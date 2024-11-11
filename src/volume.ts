import inquirer from 'inquirer';
import * as common from './common/common.js';
import { PublicKey } from '@solana/web3.js';
import * as trade from './common/trade_common.js';

const RAYDIUM_SWAP_TAX = 0.0025; // 0.25%

export type VolumeConfig = {
    type: VolumeType;
    amm: PublicKey;
    wallet_cnt: number;
    min_sol_amount: number;
    max_sol_amount: number;
    executions: number;
    delay: number;
    jito_tip: number;
    simulate: boolean;
};

export enum VolumeType {
    Fast = 0,
    Natural = 1
}

const VolumeTypeStrings = ['Fast', 'Natural'];

export async function execute_fast(_volume_config: VolumeConfig) {
    throw new Error('[ERROR] Not implemented.');
}

export async function execute_natural(_volume_config: VolumeConfig) {
    throw new Error('[ERROR] Not implemented.');
}

export async function get_config() {
    let answers: VolumeConfig;
    do {
        let min_sol_amount: number;
        const { simulate, type } = await inquirer.prompt<{ simulate: boolean; type: VolumeType }>([
            {
                type: 'confirm',
                name: 'simulate',
                message: 'Do you want to simulate the bot without making any trades?'
            },
            {
                type: 'list',
                name: 'type',
                message: 'Choose the type of the Volume Bot:',
                choices: VolumeTypeStrings,
                default: 0,
                filter: (value: string) =>
                    value.toLowerCase().includes(VolumeTypeStrings[VolumeType.Fast])
                        ? VolumeType.Fast
                        : VolumeType.Natural
            }
        ]);

        answers = await inquirer.prompt<VolumeConfig>([
            {
                type: 'input',
                name: 'amm',
                message: 'Enter the Raydium Pair ID (AMM) of the token:',
                validate: async (value: string) => {
                    if (!common.is_valid_pubkey(value)) return 'Please enter a valid publik key.';
                    try {
                        await trade.get_raydium_poolkeys(new PublicKey(value));
                    } catch {
                        return 'Please enter a valid Raydium Pair ID (AMM).';
                    }
                    return true;
                },
                filter: (value: string) => new PublicKey(value)
            },
            {
                type: 'number',
                name: 'wallet_cnt',
                message: 'Enter the number of wallets to use, max 5 (eg. 2):',
                validate: (value: number | undefined) =>
                    value && value > 0 && value <= 5
                        ? true
                        : 'Please enter a valid number greater than 0 and less than or equal to 5.'
            },
            {
                type: 'input',
                name: 'min_sol_amount',
                message: 'Enter the minimum amount of SOL to buy (eg. 0.1):',
                validate: (value: string) => {
                    if (!common.validate_float(value, 0.001)) return 'Please enter a valid number greater than 0.001.';
                    min_sol_amount = parseFloat(value);
                    return true;
                },
                filter: () => min_sol_amount
            },
            {
                type: 'input',
                name: 'max_sol_amount',
                message: 'Enter the maximum amount of SOL to buy (eg. 0.5):',
                validate: (value: string) => {
                    if (!common.validate_float(value, 0.001)) return 'Please enter a valid number greater than 0.001.';
                    if (parseFloat(value) < min_sol_amount)
                        return 'Please enter a number greater than the minimum amount.';
                    return true;
                },
                filter: (value: string) => parseFloat(value)
            },
            {
                type: 'number',
                name: 'executions',
                message: 'Enter the number of executions (bundles) to perform (eg. 30):',
                validate: (value: number | undefined) =>
                    value && value > 0 ? true : 'Please enter a valid number greater than 0.'
            },
            {
                type: 'input',
                name: 'jito_tip',
                message: 'Enter the JITO tip amount in SOL (eg. 0.0001):',
                validate: (value: string) => {
                    if (!common.validate_float(value, 0.00001))
                        return 'Please enter a valid number greater than 0.0001.';
                    return true;
                },
                filter: (value: string) => parseFloat(value)
            }
        ]);

        answers = { ...answers, type, simulate };

        if (!simulate) {
            const delay = await inquirer.prompt<{ delay: number }>([
                {
                    type: 'input',
                    name: 'delay',
                    message: 'Enter the delay in seconds between the executions (eg. 2.5):',
                    validate: (value: string) => {
                        if (!common.validate_float(value, 0.01))
                            return 'Please enter a valid number greater than 0.01.';
                        return true;
                    },
                    filter: (value: string) => parseFloat(value)
                }
            ]);
            answers = { ...answers, ...delay };
        }

        await common.clear_lines_up(1);
        console.table(display_volume_config(answers));
        const prompt = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'proceed',
                message: 'Do you want to start the volume bot with the above configuration?'
            }
        ]);

        if (prompt.proceed) break;
        else await common.clear_lines_up(Object.keys(answers).length + 6);
    } while (true);

    return answers;
}

function display_volume_config(volume_config: VolumeConfig) {
    return {
        ...volume_config,
        type: VolumeTypeStrings[volume_config.type],
        amm: volume_config.amm.toString(),
        simulate: volume_config.simulate ? 'Yes' : 'No'
    };
}

export async function simulate(volume_config: VolumeConfig) {
    const sol_price = await common.fetch_sol_price();

    let total_tax_sol = 0;
    let total_volume_sol = 0;
    let total_sol = volume_config.max_sol_amount * volume_config.wallet_cnt;

    for (let i = 0; i < volume_config.executions; i++) {
        for (let j = 0; j < volume_config.wallet_cnt; j++) {
            const sol_amount = common.uniform_random(volume_config.min_sol_amount, volume_config.max_sol_amount);

            total_tax_sol += sol_amount * RAYDIUM_SWAP_TAX * 2;
            total_volume_sol += sol_amount;
        }
        total_tax_sol += volume_config.jito_tip;
    }

    return {
        total_sol,
        total_tax_sol,
        total_sol_after_tax: total_sol - total_tax_sol,
        total_tax_usd: total_tax_sol * sol_price,
        total_volume_sol,
        total_volume_usd: total_volume_sol * sol_price,
        sol_price
    };
}
