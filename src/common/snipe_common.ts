import { Worker } from 'worker_threads';
import inquirer from 'inquirer';
import { clearLine, cursorTo, moveCursor } from 'readline';
import { PublicKey } from '@solana/web3.js';
import * as common from './common.js';
import * as trade from './trade_common.js';
import { Trader as PumpTrader } from '../pump/trade_pump.js';
import { Trader as MoonTrader } from '../moon/trade_moon.js';

const META_UPDATE_INTERVAL = 300;

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
            global.RL.close();
            throw new Error('[ERROR] Failed to start the workers. Exiting...');
        }

        common.log('[Main Worker] Bot started successfully, waiting for the token...');

        try {
            const mint =
                this.bot_config.token_name && this.bot_config.token_ticker
                    ? await this.wait_drop_sub(this.bot_config.token_name, this.bot_config.token_ticker)
                    : this.bot_config.mint;

            if (!mint) throw new Error('Failed to find the token. Exiting...');

            this.bot_config.mint = mint;
            common.log(`[Main Worker] Token detected: ${this.bot_config.mint.toString()}`);

            let mint_meta = await trader.init_mint_meta(this.bot_config.mint, sol_price);
            this.workers_post_message('mint', mint_meta);

            const interval = setInterval(async () => {
                try {
                    mint_meta = await trader.update_mint_meta_reserves(mint_meta, sol_price);
                    if (global.RL) global.RL.emit('mcap', mint_meta.token_usd_mc);
                    this.workers_post_message('mint', mint_meta);
                } catch (err) {
                    common.error(`[ERROR] Failed to update token metadata`);
                }
            }, META_UPDATE_INTERVAL);

            this.workers_post_message('buy');
            await this.workers_wait();
            clearInterval(interval);
        } catch (error) {
            throw new Error(`[ERROR] ${error}`);
        } finally {
            global.RL.prompt(false);
            global.RL.pause().removeAllListeners('line').removeAllListeners('close').close();
        }
    }

    protected async workers_wait(): Promise<void> {
        let promises = this.workers.map((w) => w.job);
        try {
            await Promise.all(promises);
            common.log('[Main Worker] All workers have finished executing');
        } catch (error) {
            throw new Error(`One of the workers encountered an error: ${error}`);
        }
    }

    protected async workers_post_message(message: WorkerMessage, data: any = {}): Promise<void> {
        if (message === 'stop') await this.wait_drop_unsub();
        if (message === 'buy') {
            for (const worker of this.workers) {
                common.log(`[Main Worker] Sending the buy command to worker ${worker.index} `);
                worker.worker.postMessage({ command: `buy${worker.index}`, data });
                const start_interval = this.bot_config.start_interval || 0;
                if (start_interval > 0) {
                    const min_interval = start_interval * 1000;
                    const max_interval = start_interval * 1.5 * 1000;
                    await common.sleep(common.normal_random(min_interval, max_interval));
                }
            }
            return;
        }
        this.workers.forEach(({ worker }) => worker.postMessage({ command: message, data }));
    }

    protected async workers_start(wallets: common.Wallet[]): Promise<boolean> {
        wallets = wallets.filter((wallet) => !wallet.is_reserve).slice(0, this.bot_config.thread_cnt);

        if (wallets.length < this.bot_config.thread_cnt) {
            common.error(`[ERROR] The number of keys doesn't match the number of threads`);
            return false;
        }

        const all_has_balances = await trade.check_has_balances(wallets);
        if (!all_has_balances) {
            common.error('[ERROR] Topup the specified accounts, exiting...');
            return false;
        }

        common.log('[Main Worker] Starting the workers...');
        const started_promises: Promise<void>[] = [];

        for (const wallet of wallets) {
            const worker_data: WorkerConfig = {
                secret: wallet.keypair.secretKey,
                id: wallet.id,
                buy_interval: this.bot_config.buy_interval || 5,
                spend_limit: this.bot_config.spend_limit,
                start_buy: this.bot_config.start_buy,
                mcap_threshold: this.bot_config.mcap_threshold,
                is_buy_once: this.bot_config.is_buy_once
            };

            const worker = new Worker(this.get_worker_path(), {
                workerData: worker_data
            });

            let started: () => void;
            const started_promise = new Promise<void>((resolve) => (started = resolve));

            const job = new Promise<void>((resolve, reject) => {
                worker.on('message', async (msg) => {
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
                    if (code !== 0) reject(new Error(`[Worker ${wallet.id}] Stopped with exit code ${code} `));
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
        if (!global.RL) common.setup_readline();
        global.RL.setPrompt('Command (stop/config/sell/set)> ');
        global.RL.prompt(true);

        let selling = false;
        let stopping = false;

        global.RL.on('line', (line) => {
            moveCursor(process.stdout, 0, -1);
            clearLine(process.stdout, 0);

            const [command, key, value] = line.trim().split(' ');
            switch (command) {
                case 'stop':
                    if (!stopping) {
                        common.log('[Main Worker] Stopping the bot...');
                        this.workers_post_message('stop');
                        stopping = true;
                    } else {
                        common.log('[Main Worker] Stopping is already in progress...');
                    }
                    break;
                case 'config':
                    if (this.bot_config) console.table(display_bot_config(this.bot_config));
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
                    if (key && value) {
                        update_bot_config(this.bot_config, key, value);
                        common.log(`[Main Worker] Configuration updated: ${key} = ${value}`);
                    } else {
                        common.log('Invalid command. Usage: set <key> <value>');
                    }
                    break;
                default:
                    common.log(`Unknown command: ${line.trim()} `);
                    break;
            }
            global.RL.prompt(true);
        })
            .on('mcap', (mcap: number) => {
                const threshold_reached = this.bot_config.mcap_threshold < mcap ? ' (Target reached)' : '';
                const mcap_message = common.bold(`MCAP: $${mcap.toFixed(2)}${threshold_reached}`);
                global.RL.setPrompt(`${mcap_message} | Command (stop/config/sell/set)> `);
                global.RL.prompt(true);
            })
            .on('close', () => {
                if (!stopping) {
                    common.log('[Main Worker] Stopping the bot...');
                    this.workers_post_message('stop');
                    cursorTo(process.stdout, 0);
                    clearLine(process.stdout, 0);
                    global.RL.close();
                }
            });
    }
}

function validate_bot_config(json: any, keys_cnt: number): BotConfig {
    const required_fields = ['thread_cnt', 'spend_limit', 'start_buy'];

    for (const field of required_fields) {
        if (!(field in json)) throw new Error(`[ERROR] Missing required field: ${field}`);
    }

    const {
        token_name,
        token_ticker,
        mint,
        trader,
        thread_cnt,
        buy_interval,
        spend_limit,
        start_buy,
        mcap_threshold,
        start_interval,
        is_buy_once
    } = json;

    if (mint === undefined && token_name === undefined && token_ticker === undefined) {
        throw new Error('[ERROR] Missing mint or token name and token ticker.');
    }

    if (mint !== undefined && (token_name !== undefined || token_ticker !== undefined)) {
        throw new Error('[ERROR] Mint and token name/token ticker are mutually exclusive. Choose one.');
    }

    if (
        (token_name === undefined && token_ticker !== undefined) ||
        (token_name !== undefined && token_ticker === undefined)
    ) {
        throw new Error('[ERROR] Both token name and token ticker are required.');
    }

    if (typeof spend_limit !== 'number' || spend_limit <= 0) {
        throw new Error('[ERROR] spend_limit must be a number greater than 0.');
    }

    if (typeof start_buy !== 'number' || start_buy <= 0 || start_buy >= spend_limit) {
        throw new Error('[ERROR] start_buy must be a number greater than 0 and less than spend_limit.');
    }

    if (typeof thread_cnt !== 'number' || thread_cnt > keys_cnt) {
        throw new Error('[ERROR] thread_cnt must be a number and less than or equal to keys_cnt.');
    }

    if ((buy_interval && typeof buy_interval !== 'number') || buy_interval <= 0) {
        throw new Error('[ERROR] buy_interval must be a number greater than 0.');
    }

    if (mcap_threshold && (typeof mcap_threshold !== 'number' || mcap_threshold < 5000)) {
        throw new Error('[ERROR] mcap_threshold must be a number greater than 5000.');
    }

    if (start_interval && (typeof start_interval !== 'number' || start_interval < 0)) {
        throw new Error('[ERROR] start_interval must be a number greater than or equal to 0.');
    }

    if (is_buy_once && typeof is_buy_once !== 'boolean') {
        throw new Error('[ERROR] is_buy_once must be a boolean');
    }

    if (trader) {
        if (trader === 'pump' || trader === 'moon') {
            json.trader = trader === 'pump' ? PumpTrader : MoonTrader;
        } else {
            throw new Error('[ERROR] Invalid trader.');
        }
    }

    if (!('trader' in json)) json.trader = PumpTrader;
    if (!('is_buy_once' in json)) json.is_buy_once = false;
    if (!('start_interval' in json)) json.start_interval = undefined;
    if (!('mcap_threshold' in json)) json.mcap_threshold = Infinity;
    if (json.mint) json.mint = new PublicKey(json.mint);

    return json as BotConfig;
}

async function get_config(keys_cnt: number): Promise<BotConfig> {
    let answers: BotConfig;
    do {
        let spend_limit: number;
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
                type: 'number',
                name: 'start_interval',
                message: 'Enter the start interval in seconds:',
                default: 0,
                validate: (value) =>
                    !value || (value && value >= 0) ? true : 'Please enter a valid number greater than or equal to 0.'
            },
            {
                type: 'input',
                name: 'spend_limit',
                message: 'Enter the limit of Solana that each bot can spend:',
                validate: (value) =>
                    common.validate_float(value, 0.001) ? true : 'Please enter a valid number greater than 0.001.',
                filter: (value) => {
                    const parsedValue = parseFloat(value);
                    if (common.validate_float(value, 0.001)) {
                        spend_limit = parsedValue;
                        return parsedValue;
                    }
                    return value;
                }
            },
            {
                type: 'input',
                name: 'start_buy',
                message: 'Enter the start Solana amount that the bot will buy the token for:',
                validate: (value) => {
                    if (!common.validate_float(value, 0.001)) {
                        return 'Please enter a valid number greater than 0.001.';
                    }
                    if (spend_limit !== undefined && parseFloat(value) >= spend_limit) {
                        return 'The start buy amount should be less than the spend limit.';
                    }
                    return true;
                },
                filter: (value) => (common.validate_float(value, 0.001) ? parseFloat(value) : value)
            },
            {
                type: 'input',
                name: 'mcap_threshold',
                message: 'Enter the threshold market cap (leave blank for Infinity):',
                default: '',
                validate: (value) =>
                    value === '' || common.validate_int(value, 5000)
                        ? true
                        : 'Please enter a valid number greater than 5000',
                filter: (value) => (value === '' ? Infinity : parseInt(value, 10))
            },
            {
                type: 'list',
                name: 'trader',
                message: 'Choose the program:',
                choices: ['Pump', 'Moonshoot'],
                default: 0,
                filter: (input) => (input.toLowerCase() === 'pump' ? PumpTrader : MoonTrader)
            },
            {
                type: 'confirm',
                name: 'is_buy_once',
                message: 'Do you want to buy only once?',
                default: false
            }
        ]);

        if (!answers.is_buy_once) {
            const buy_interval = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'buy_interval',
                    message: 'Enter the interval between each buy in seconds:',
                    validate: (value) =>
                        common.validate_int(value, 1) ? true : 'Please enter a valid number greater than 0.',
                    filter: (value) => (common.validate_int(value, 1) ? parseInt(value, 10) : value)
                }
            ]);
            answers = { ...answers, ...buy_interval };
        }

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

export async function setup_config(keys_cnt: number, json_config: any | undefined): Promise<BotConfig> {
    if (json_config) {
        const bot_config = validate_bot_config(json_config, keys_cnt - 1);

        if (bot_config.mint) {
            common.log('Sniping existing mint...');
        } else if (bot_config.token_name && bot_config.token_ticker) {
            common.log('Sniping token by name and ticker...');
        }

        console.table(display_bot_config(bot_config));
        common.setup_readline();
        await new Promise<void>((resolve) => global.RL.question('Press ENTER to start the bot...', () => resolve()));
        common.clear_lines_up(1);
        return bot_config;
    } else {
        try {
            const bot_config = await get_config(keys_cnt - 1);
            common.clear_lines_up(1);
            return bot_config;
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('prompt')) {
                    throw new Error('[ERROR] You cancelled the bot setup.');
                }
                throw new Error(`${error.message}`);
            } else {
                throw new Error('[ERROR] Failed to setup the bot.');
            }
        }
    }
}

function display_bot_config(bot_config: BotConfig) {
    return {
        ...bot_config,
        mcap_threshold: bot_config.mcap_threshold === Infinity ? 'N/A' : bot_config.mcap_threshold,
        trader: bot_config.trader === PumpTrader ? 'Pump' : 'Moon',
        token_name: bot_config.token_name ? bot_config.token_name : 'N/A',
        token_ticker: bot_config.token_ticker ? bot_config.token_ticker : 'N/A',
        start_interval: bot_config.start_interval ? bot_config.start_interval : 0,
        buy_interval: bot_config.buy_interval ? bot_config.buy_interval : 'N/A',
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
