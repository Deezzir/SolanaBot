import inquirer from 'inquirer';
import * as common from '../common/common.js';
import { PublicKey } from '@solana/web3.js';
import * as trade from '../common/trade_common.js';
import { VOLUME_RAYDIUM_SWAP_TAX } from '../constants.js';

type VolumeConfig = {
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

export const VolumeTypeStrings = ['Fast', 'Natural'];

export async function execute_fast(volume_config: VolumeConfig) {
    for (let exec = 1; exec <= volume_config.executions; exec++) {
        common.log(common.blue(`Running execution: ${exec}`));

        const delay_seconds = common.normal_random(volume_config.delay, volume_config.delay * 0.1);
        common.log(common.blue(`Sleeping for ${delay_seconds.toFixed(1)} seconds`));
        await common.sleep(delay_seconds * 1000);
    }

    common.log('The Fast Volume Bot completed');
}

export async function execute_natural(_volume_config: VolumeConfig) {
    throw new Error('[ERROR] Not implemented.');
}

async function get_config() {
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

        const { wallet_cnt } =
            type === VolumeType.Natural
                ? await inquirer.prompt<{ wallet_cnt: number }>([
                      {
                          type: 'number',
                          name: 'wallet_cnt',
                          message: 'Enter the number of wallets to use, max 5 (eg. 2):',
                          validate: (value: number | undefined) =>
                              value && value > 0 && value <= 5
                                  ? true
                                  : 'Please enter a valid number greater than 0 and less than or equal to 5.'
                      }
                  ])
                : { wallet_cnt: 1 };

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

        answers = { ...answers, type, simulate, wallet_cnt };

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
        log_volume_config(answers);
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

export async function setup_config(json_config?: object): Promise<VolumeConfig> {
    if (json_config) {
        const volume_config = await validate_volume_config(json_config);

        log_volume_config(volume_config);
        await common.to_confirm('Press ENTER to start the volume bot...');

        common.clear_lines_up(1);
        return volume_config;
    } else {
        try {
            const bot_config = await get_config();
            common.clear_lines_up(1);
            return bot_config;
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('prompt')) {
                    throw new Error('[ERROR] You cancelled the volume bot setup.');
                }
                throw new Error(`${error.message}`);
            } else {
                throw new Error('[ERROR] Failed to setup the volume bot.');
            }
        }
    }
}

export async function simulate(volume_config: VolumeConfig) {
    const sol_price = await common.fetch_sol_price();

    let total_tax_sol = 0;
    let total_volume_sol = 0;
    let total_sol = volume_config.max_sol_amount * volume_config.wallet_cnt;

    for (let i = 0; i < volume_config.executions; i++) {
        for (let j = 0; j < volume_config.wallet_cnt; j++) {
            const sol_amount = common.uniform_random(volume_config.min_sol_amount, volume_config.max_sol_amount);

            total_tax_sol += sol_amount * VOLUME_RAYDIUM_SWAP_TAX * 2;
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

async function validate_volume_config(json: any): Promise<VolumeConfig> {
    const required_fields = ['amm', 'executions', 'jito_tip', 'min_sol_amount', 'max_sol_amount'];

    for (const field of required_fields) {
        if (!json[field]) throw new Error(`[ERROR] Missing required field: ${field}`);
    }

    const { amm, wallet_cnt, min_sol_amount, max_sol_amount, executions, delay, jito_tip, simulate, type } = json;

    if (type !== undefined) {
        if (typeof type === 'string' && VolumeTypeStrings.some((t) => t.toLowerCase() === type.toLowerCase())) {
            json.type = VolumeTypeStrings.findIndex((t) => t.toLowerCase() === type.toLowerCase());
        } else {
            throw new Error("[ERROR] Invalid type, must be an either 'fast' or 'natural'.");
        }
    }

    if (!common.is_valid_pubkey(amm)) {
        try {
            await trade.get_raydium_poolkeys(new PublicKey(amm));
        } catch {
            throw new Error('[ERROR] Invalid Raydium Pair ID (AMM) public key.');
        }
    }

    if (typeof min_sol_amount !== 'number' || min_sol_amount <= 0) {
        throw new Error('[ERROR] Invalid min_sol_amount number. Must be greater than 0.');
    }

    if (typeof max_sol_amount !== 'number' || max_sol_amount <= 0 || max_sol_amount < min_sol_amount) {
        throw new Error('[ERROR] Invalid max_sol_amount number. Must be greater than 0 and min_sol_amount.');
    }

    if (typeof executions !== 'number' || !Number.isInteger(executions) || executions <= 0) {
        throw new Error('[ERROR] Invalid executions number. Must be greater than 0.');
    }

    if (typeof jito_tip !== 'number' || jito_tip < 0.0) {
        throw new Error('[ERROR] Invalid jito_tip number. Must be greater than or equal to 0.');
    }

    if (simulate && typeof simulate !== 'boolean') {
        throw new Error('[ERROR] Invalid simulate.');
    }

    if (delay && simulate === false && (typeof delay !== 'number' || delay <= 0)) {
        throw new Error('[ERROR] Invalid delay number. Must be greater than 0.');
    }

    if (type) {
        if (
            type === VolumeType.Fast &&
            (!wallet_cnt || typeof wallet_cnt !== 'number' || wallet_cnt <= 0 || wallet_cnt > 5)
        ) {
            throw new Error('[ERROR] Invalid wallet_cnt number. Must be greater than 0 and less than or equal to 5.');
        }

        if (type === VolumeType.Natural && wallet_cnt) {
            throw new Error('[ERROR] Invalid wallet_cnt number. Must be undefined for Natural type.');
        }
    }

    if (!('simulate' in json)) json.simulate = false;
    if (!('type' in json)) json.type = VolumeType.Fast;
    if (!('wallet_cnt' in json)) json.wallet_cnt = 1;

    return json as VolumeConfig;
}

function log_volume_config(volume_config: VolumeConfig) {
    const to_print = {
        ...volume_config,
        type: VolumeTypeStrings[volume_config.type],
        amm: volume_config.amm.toString(),
        simulate: volume_config.simulate ? 'Yes' : 'No',
        min_sol_amount: volume_config.min_sol_amount.toFixed(2),
        max_sol_amount: volume_config.max_sol_amount.toFixed(2)
    };

    const max_length = Math.max(...Object.values(to_print).map((value) => value.toString().length));

    common.print_header([
        { title: 'Parameter', width: common.COLUMN_WIDTHS.parameter, align: 'center' },
        { title: 'Value', width: max_length, align: 'center' }
    ]);

    for (const [key, value] of Object.entries(to_print)) {
        common.print_row([
            { content: key, width: common.COLUMN_WIDTHS.parameter, align: 'center' },
            { content: value.toString(), width: max_length, align: 'left' }
        ]);
    }

    common.print_footer([{ width: common.COLUMN_WIDTHS.parameter }, { width: max_length }]);
}
