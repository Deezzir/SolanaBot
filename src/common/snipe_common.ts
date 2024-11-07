import { Worker } from 'worker_threads';
import inquirer from 'inquirer';
import { clearLine, cursorTo, moveCursor } from 'readline';
import { PublicKey } from '@solana/web3.js';
import * as common from './common.js';
import * as trade from './trade_common.js';
import { Trader as PumpTrader } from '../pump/trade_pump.js';
import { Trader as MoonTrader } from '../moon/trade_moon.js';

const META_UPDATE_INTERVAL = 200;

export type BotConfig = {
    thread_cnt: number;
    buy_interval: number;
    spend_limit: number;
    start_buy: number;
    mcap_threshold: number;
    is_buy_once: boolean;
    trader: trade.IProgramTrader;
    start_interval: number | undefined;
    token_name: string | undefined;
    token_ticker: string | undefined;
    mint: PublicKey | undefined;
};

export type WorkerConfig = {
    secret: Uint8Array;
    id: number;
    buy_interval: number;
    spend_limit: number;
    start_buy: number;
    mcap_threshold: number;
    is_buy_once: boolean;
};

type WorkerJob = {
    worker: Worker;
    index: number;
    job: Promise<void>;
};

enum Method {
    Wait = 0,
    Snipe = 1
}

type WorkerMessage = 'stop' | 'buy' | 'mint' | 'sell';

const MethodStrings = ['Wait', 'Snipe'];
export interface ISniper {
    workers: WorkerJob[];
    bot_config: BotConfig;

    snipe(wallets: common.Wallet[], sol_price: number): Promise<void>;
}

export abstract class SniperBase implements ISniper {
    public workers: WorkerJob[];
    public bot_config: BotConfig;

    constructor(bot_config: BotConfig) {
        this.workers = new Array<WorkerJob>();
        this.bot_config = bot_config;
    }

    protected abstract wait_drop_sub(token_name: string, token_ticker: string): Promise<PublicKey | null>;
    protected abstract wait_drop_unsub(): Promise<void>;
    protected abstract get_worker_path(): string;

    public async snipe(wallets: common.Wallet[], sol_price: number): Promise<void> {
        const trader = this.bot_config.trader;
        this.setup_cmd_interface();

        common.log('[Main Worker] Starting the bot...');
        const ok = await this.workers_start(wallets);
        if (!ok) {
            common.error('[ERROR] Failed to start the workers. Exiting...');
            global.RL.close();
            return;
        }

        common.log('[Main Worker] Bot started successfully, waiting for the token...');

        try {
            const mint =
                this.bot_config.token_name && this.bot_config.token_ticker
                    ? await this.wait_drop_sub(this.bot_config.token_name, this.bot_config.token_ticker)
                    : this.bot_config.mint;

            if (mint) {
                this.bot_config.mint = mint;
                common.log(`[Main Worker] Token detected: ${this.bot_config.mint.toString()}`);

                let mint_meta = await trader.init_mint_meta(this.bot_config.mint, sol_price);
                this.workers_post_message('mint', mint_meta);
                const interval = setInterval(async () => {
                    let updated_mint_meta = await trader.update_mint_meta_reserves(mint_meta, sol_price);
                    if (updated_mint_meta) {
                        const meta_printer = trader.get_meta_printer(updated_mint_meta);
                        common.log(`[Main Worker] Current MCAP: $${meta_printer.usd_mc.toFixed(3)}`);
                        mint_meta = updated_mint_meta;
                        this.workers_post_message('mint', updated_mint_meta);
                    }
                }, META_UPDATE_INTERVAL);

                this.workers_post_message('buy', {});
                await this.workers_wait();
                clearInterval(interval);
            } else {
                common.error('[ERROR] Token not found. Exiting...');
                global.RL.close();
            }
        } catch (error) {
            common.error(`[ERROR] ${error}`);
            global.RL.close();
        }
    }

    protected async workers_wait(): Promise<void> {
        let promises = this.workers.map((w) => w.job);
        try {
            await Promise.all(promises);
            common.log('[Main Worker] All workers have finished executing');
        } catch (err) {
            common.error(`[ERROR] One of the workers encountered an error`);
        }
    }

    protected async workers_post_message(message: WorkerMessage, data: any = {}): Promise<void> {
        if (message === 'stop') await this.wait_drop_unsub();
        if (message === 'buy') {
            for (const worker of this.workers) {
                common.log(`[Main Worker] Sending the buy command to worker ${worker.index}`);
                worker.worker.postMessage({
                    command: `buy${worker.index}`,
                    data
                });
                const start_interval = this.bot_config.start_interval || 0;
                if (start_interval > 0) {
                    const min_interval = start_interval * 1000;
                    const max_interval = start_interval * 1.5 * 1000;
                    await common.sleep(Math.floor(Math.random() * (max_interval - min_interval)) + min_interval);
                }
            }
            return;
        }
        this.workers.forEach(({ worker }) => worker.postMessage({ command: message, data }));
    }

    protected async workers_start(wallets: common.Wallet[]): Promise<boolean> {
        wallets = wallets.filter((wallet) => !wallet.is_reserve).slice(0, this.bot_config.thread_cnt);

        if (wallets.length === 0 || wallets.length < this.bot_config.thread_cnt) {
            common.error(`[ERROR] The number of keys doesn't match the number of threads`);
            global.RL.close();
            return false;
        }

        const all_has_balances = await trade.check_has_balances(wallets);
        if (!all_has_balances) {
            common.error('[ERROR] First, topup the specified accounts.');
            global.RL.close();
            return false;
        }

        common.log('[Main Worker] Starting the workers...');
        const started_promises: Promise<void>[] = [];

        for (const wallet of wallets) {
            const data: WorkerConfig = {
                secret: wallet.keypair.secretKey,
                id: wallet.id,
                buy_interval: this.bot_config.buy_interval,
                spend_limit: this.bot_config.spend_limit,
                start_buy: this.bot_config.start_buy,
                mcap_threshold: this.bot_config.mcap_threshold,
                is_buy_once: this.bot_config.is_buy_once
            };

            const worker = new Worker(this.get_worker_path(), {
                workerData: data
            });

            let started: () => void;
            const started_promise = new Promise<void>((resolve) => (started = resolve));

            const job = new Promise<void>((resolve, reject) => {
                worker.on('message', (msg) => {
                    if (msg.command === 'started') {
                        started();
                        common.log(msg.data);
                        return;
                    }
                    common.log(msg);
                });
                worker.on('error', (err) => {
                    common.error(`[Worker ${wallet.id}] Encountered error: ${err}`);
                    reject();
                });
                worker.on('exit', (code) => {
                    if (code !== 0) reject(new Error(`[Worker ${wallet.id}]Stopped with exit code ${code} `));
                    else resolve();
                });
            });

            started_promises.push(started_promise);
            this.workers.push({ worker: worker, index: wallet.id, job: job });
        }

        await Promise.all(started_promises);
        common.log('[Main Worker] All workers have started');

        return true;
    }

    protected setup_cmd_interface() {
        if (global.RL === undefined) common.setup_readline();
        global.RL.setPrompt('Command (stop/config/sell/set)> ');
        global.RL.prompt(true);

        let selling = false;
        let stopping = false;

        global.RL.on('line', async (line) => {
            moveCursor(process.stdout, 0, -1);
            clearLine(process.stdout, 0);
            switch (line.trim().split(' ')[0]) {
                case 'stop':
                    if (!stopping) {
                        this.workers_post_message('stop');
                        stopping = true;
                    } else {
                        common.log('[Main Worker] Stopping is already in progress...');
                    }
                    break;
                case 'config':
                    if (this.bot_config !== undefined) console.table(display_bot_config(this.bot_config));
                    break;
                case 'sell':
                    if (!selling) {
                        this.workers_post_message('sell');
                        selling = true;
                    } else {
                        common.log('[Main Worker] Selling is already in progress...');
                    }
                    break;
                case 'set':
                    const args = line.trim().split(' ');
                    if (args.length < 3) {
                        common.log('Invalid command. Example: set action buy');
                        break;
                    }
                    const [, key, value] = args;
                    update_bot_config(this.bot_config, key, value);
                    break;
                default:
                    common.log(`Unknown command: ${line.trim()} `);
                    break;
            }
            global.RL.prompt(true);
        }).on('close', () => {
            common.log('[Main Worker] Stopping the bot...');
            cursorTo(process.stdout, 0);
            clearLine(process.stdout, 0);
            process.exit(0);
        });
    }
}

export function validate_bot_config(json: any): BotConfig | undefined {
    const required_fields = ['thread_cnt', 'buy_interval', 'spend_limit', 'start_buy', 'mcap_threshold'];

    for (const field of required_fields) {
        if (!(field in json)) {
            return;
        }
    }

    const { token_name, token_ticker, mint, trader } = json;

    if (mint === undefined && token_name === undefined && token_ticker === undefined) {
        common.error('[ERROR] Missing mint or token name and token ticker.');
        return;
    }

    if (mint !== undefined && (token_name !== undefined || token_ticker !== undefined)) {
        common.error('[ERROR] Mint and token name/token ticker are mutually exclusive. Choose one.');
        return;
    }

    if (
        (token_name === undefined && token_ticker !== undefined) ||
        (token_name !== undefined && token_ticker === undefined)
    ) {
        common.error('[ERROR] Both token name and token ticker are required.');
        return;
    }

    if (trader) {
        if (trader === 'pump' || trader === 'moon') {
            json.trader = trader === 'pump' ? PumpTrader : MoonTrader;
        } else {
            common.error('[ERROR] Invalid trader.');
            return;
        }
    } else {
        json.trader = PumpTrader;
    }

    if (!('is_buy_once' in json)) json.is_buy_once = false;
    if (!('start_interval' in json)) json.start_interval = undefined;
    if (json.mint) json.mint = new PublicKey(json.mint);

    return json as BotConfig;
}

async function get_config(keys_cnt: number): Promise<BotConfig> {
    let answers: BotConfig;
    do {
        answers = await inquirer.prompt<BotConfig>([
            {
                type: 'input',
                name: 'thread_cnt',
                message: `Enter the number of bots to run(${keys_cnt} accounts available):`,
                validate: (value) =>
                    common.validate_int(value, 1, keys_cnt)
                        ? true
                        : `Please enter a valid number greater than 0 and less or equal to ${keys_cnt}.`,
                filter: (value) => (common.validate_int(value, 1, keys_cnt) ? parseInt(value, 10) : value)
            },
            {
                type: 'confirm',
                name: 'is_buy_once',
                message: 'Do you want to buy only once?',
                default: false
            },
            {
                type: 'number',
                name: 'start_interval',
                message: 'Enter the start interval in seconds:',
                default: 0,
                validate: (value) =>
                    !value || (value && value >= 0) ? true : 'Please enter a valid number greater than or equal to 0.'
            },
            {
                type: 'input',
                name: 'buy_interval',
                message: 'Enter the interval between each buy in seconds:',
                validate: (value) =>
                    common.validate_int(value, 1) ? true : 'Please enter a valid number greater than 0.',
                filter: (value) => (common.validate_int(value, 1) ? parseInt(value, 10) : value)
            },
            {
                type: 'input',
                name: 'spend_limit',
                message: 'Enter the limit of Solana that each bot can spend:',
                validate: (value) =>
                    common.validate_float(value, 0.001) ? true : 'Please enter a valid number greater than 0.001.',
                filter: (value) => (common.validate_float(value, 0.001) ? parseFloat(value) : value)
            },
            {
                type: 'input',
                name: 'start_buy',
                message: 'Enter the start Solana amount that the bot will buy the token for:',
                validate: (value) =>
                    common.validate_float(value, 0.001) ? true : 'Please enter a valid number greater than 0.001.',
                filter: (value) => (common.validate_float(value, 0.001) ? parseFloat(value) : value)
            },
            {
                type: 'input',
                name: 'mcap_threshold',
                message: 'Enter the threshold market cap:',
                validate: (value) =>
                    common.validate_int(value, 5000) ? true : 'Please enter a valid number greater than 5000',
                filter: (value) => (common.validate_int(value, 5000) ? parseInt(value, 10) : value)
            },
            {
                type: 'list',
                name: 'trader',
                message: 'Choose the program:',
                choices: ['Pump', 'Moonshoot'],
                default: 0,
                filter: (input) => (input.toLowerCase() === 'pump' ? PumpTrader : MoonTrader)
            }
        ]);

        const method = await inquirer.prompt([
            {
                type: 'list',
                name: 'type',
                message: 'Choose the type of the sniping:',
                choices: ['Wait for the token to drop', 'Snipe an existing token'],
                default: 0,
                filter: (input) =>
                    input.toLowerCase().includes(MethodStrings[Method.Wait].toLocaleLowerCase())
                        ? Method.Wait
                        : Method.Snipe
            }
        ]);

        if (method.type === Method.Wait) {
            const token_meta = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'token_name',
                    message: 'Enter the token name:'
                },
                {
                    type: 'input',
                    name: 'token_ticker',
                    message: 'Enter the token ticker:'
                }
            ]);
            answers = { ...answers, ...token_meta };
        } else {
            const mint = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'mint',
                    message: 'Enter the mint public key:',
                    validate: async (input) => {
                        if (!common.is_valid_pubkey(input)) return 'Please enter a valid public key.';
                        const meta = await answers.trader.get_mint_meta(input);
                        if (!meta) return 'Failed fetching the mint data with the public key.';
                        return true;
                    },
                    filter: (input) => new PublicKey(input)
                }
            ]);
            answers = { ...answers, ...mint };
        }

        await common.clear_lines_up(Object.keys(answers).length + 1);
        console.table(display_bot_config(answers));
        const prompt = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'proceed',
                message: 'Do you want to start the bot with the above configuration?'
            }
        ]);

        if (prompt.proceed) break;
        else await common.clear_lines_up(Object.keys(answers).length + 6);
    } while (true);

    return answers;
}

export async function setup_config(config: BotConfig, keys_cnt: number): Promise<BotConfig | undefined> {
    if (config) {
        if (config.mint) {
            common.log('Sniping existing mint...');
        } else if (config.token_name && config.token_ticker) {
            common.log('Sniping token by name and ticker...');
        } else {
            console.error('Invalid config file.');
            process.exit(1);
        }
        console.table(display_bot_config(config));
        common.setup_readline();
        await new Promise<void>((resolve) => global.RL.question('Press ENTER to start the bot...', () => resolve()));
    } else {
        config = await get_config(keys_cnt - 1);
        common.clear_lines_up(1);
        if (!config) return;
    }
    return config;
}

function display_bot_config(bot_config: BotConfig) {
    return {
        ...bot_config,
        trader: bot_config.trader === PumpTrader ? 'Pump' : 'Moon',
        token_name: bot_config.token_name ? bot_config.token_name : 'N/A',
        token_ticker: bot_config.token_ticker ? bot_config.token_ticker : 'N/A',
        start_interval: bot_config.start_interval ? bot_config.start_interval : 0,
        mint: bot_config.mint ? bot_config.mint.toString() : 'N/A'
    };
}

function update_bot_config(bot_config: BotConfig, key: string, value: string): void {
    switch (key) {
        case 'buy_interval':
            if (common.validate_int(value, 1)) bot_config.buy_interval = parseInt(value, 10);
            else common.error('Invalid buy interval.');
            break;
        case 'spend_limit':
            if (common.validate_float(value, 0.001)) bot_config.spend_limit = parseFloat(value);
            else common.error('Invalid spend limit.');
            break;
        case 'is_buy_once':
            bot_config.is_buy_once = value === 'true';
            break;
        case 'mcap_threshold':
            if (common.validate_int(value, 5000)) bot_config.mcap_threshold = parseInt(value, 10);
            else common.error('Invalid market cap threshold.');
        default:
            common.error('Invalid key.');
            break;
    }
}
