import figlet from 'figlet';
import { Command, InvalidArgumentError, InvalidOptionArgumentError, Option } from 'commander';
import { existsSync } from 'fs';
import * as common from './common/common.js';
import * as commands from './commands.js';
import { exit } from 'process';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Helius } from 'helius-sdk';
import { Environment, Moonshot } from '@wen-moon-ser/moonshot-sdk';
import {
    COMMITMENT,
    DROP_AIRDROP_CSV,
    DROP_PRESALE_CSV,
    HELIUS_API_KEY,
    HELIUS_RPC,
    PriorityLevel,
    TRADE_MAX_SLIPPAGE,
    WALLETS_FILE
} from './constants.js';
import base58 from 'bs58';

//------------------------------------------------------------
// MAIN
// -----------------------------------------------------------

function reserve_wallet_check(wallets: common.Wallet[]) {
    if (!common.check_reserve_exists(wallets)) {
        common.error('[ERROR] Reserve wallet not found.');
        exit(1);
    }
}

function get_wallets_from_file(file: string): common.Wallet[] {
    try {
        const wallets = common.get_wallets(file);
        if (wallets.length === 0) common.error(common.yellow('[WARNING] The file does not containt any wallets.'));
        return wallets;
    } catch (error) {
        if (error instanceof Error) {
            common.error(common.yellow(`[WARNING] ${error.message}`));
        }
    }
    return [];
}

async function main() {
    let wallets = get_wallets_from_file(WALLETS_FILE);
    let wallet_cnt = wallets.length;

    global.CONNECTION = new Connection(HELIUS_RPC, { disableRetryOnRateLimit: true, commitment: COMMITMENT });
    global.HELIUS_CONNECTION = new Helius(HELIUS_API_KEY);
    global.MOONSHOT = new Moonshot({
        rpcUrl: global.CONNECTION.rpcEndpoint,
        environment: Environment.MAINNET,
        chainOptions: {
            solana: { confirmOptions: { commitment: COMMITMENT } }
        }
    });

    const program = new Command();

    program.version('4.0.0').description('Solana Bot CLI');

    program.addHelpText('beforeAll', figlet.textSync('Solana Bot', { horizontalLayout: 'full' }));
    program.showHelpAfterError('Use --help for additional information');

    program.configureOutput({
        writeOut: (str) => process.stdout.write(str),
        writeErr: (str) => process.stderr.write(str),
        outputError: (str, write) => write(common.red(str))
    });

    program.addOption(
        new Option('-k, --keys <path>', 'Path to the CSV file with the wallets')
            .argParser((value) => {
                if (!existsSync(value)) throw new InvalidOptionArgumentError('Keys file does not exist.');
                wallets = get_wallets_from_file(value);
                wallet_cnt = wallets.length;
                return value;
            })
            .default(WALLETS_FILE, WALLETS_FILE)
    );

    program
        .command('snipe')
        .alias('sn')
        .description('Start the snipe bot')
        .option('-c, --config <path>', 'Path to the JSON config file', (value) => {
            if (!existsSync(value)) throw new InvalidOptionArgumentError('Config file does not exist.');
            return common.read_json(value);
        })
        .option('-f, --from <number>', 'Warmup starting from the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (options: any) => {
            let { config, from, program } = options;
            await commands.snipe(common.filter_wallets(wallets, from), program, config);
        });

    program
        .command('volume')
        .alias('v')
        .description('Generate the volume for the Raydium pool')
        .option('-c, --config <path>', 'Path to the JSON config file', (value) => {
            if (!existsSync(value)) throw new InvalidOptionArgumentError('Config file does not exist.');
            return common.read_json(value);
        })
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (options: any) => {
            const { config, program } = options;
            await commands.start_volume(program, config);
        });

    program
        .command('generate')
        .alias('g')
        .description(
            'Generate the wallets. Optionally, a file with secret keys (separated by newline) can be provided to convert them to keypairs.'
        )
        .argument('<count>', 'Number of wallets to generate', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 1) throw new InvalidArgumentError('Invalid count. Must be greater than 0.');
            return parsed_value;
        })
        .argument('<name>', 'Name of the file to save the wallets', (value) => {
            if (existsSync(value)) throw new InvalidArgumentError('File with the same name already exists.');
            return value;
        })
        .option('-k, --keys_path <path>', 'Path to the file with secret keys to convert', (value) => {
            if (!existsSync(value)) throw new InvalidOptionArgumentError('Keys file does not exist.');
            return value;
        })
        .option('-i, --index <index>', 'Starting index of the wallets', (value) => {
            if (!common.validate_int(value, 0)) throw new InvalidOptionArgumentError(`Index should be greater than 0.`);
            return parseInt(value, 10);
        })
        .option('-r, --reserve', 'Generate the reserve wallet', false)
        .action(async (count, name, options) => {
            let { keys_path, index, reserve } = options;
            commands.generate(count, name, reserve, keys_path, index);
        });

    program
        .command('balance')
        .alias('b')
        .description('Get the balance of the wallets')
        .action(async () => await commands.balance(wallets));

    program
        .command('wallet-pnl')
        .alias('pnl')
        .description('Get the PNL of the account')
        .argument('<address>', 'Public address of the account', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not a address.');
            return new PublicKey(value);
        })
        .action(async (address) => await commands.wallet_pnl(address));

    program
        .command('token-balance')
        .alias('tb')
        .description('Get the total balance of a token of the wallets')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .action(async (mint) => await commands.token_balance(wallets, mint));

    program
        .command('warmup')
        .alias('w')
        .description('Warmup the wallets with the tokens')
        .option('-f, --from <number>', 'Warmup starting from the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-t, --to <number>', 'Warmup ending at the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-l, --list <wallets...>', 'Specify the list of wallet files', (value, prev: any) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return prev ? prev?.concat(parseInt(value, 10)) : [parseInt(value, 10)];
        })
        .option('--min <number>', 'Minimum amount of tokens for each wallet', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 1)
                throw new InvalidOptionArgumentError('Invalid minimum amount. Must be greater than 0.');
            return parsed_value;
        })
        .option('--max <number>', 'Maximum amount of tokens for each wallet', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 1 || parsed_value > 50)
                throw new InvalidOptionArgumentError('Invalid maximum amount. Must be between 1 and 50');
            return parsed_value;
        })
        .option('-b, --bundle <tip>', 'Amount to tip for buy/sell bundle', (value) => {
            if (!common.validate_float(value, 0))
                throw new InvalidOptionArgumentError('Not a valid tip amount. Must be greater than 0.');
            return parseFloat(value);
        })
        .addOption(
            new Option('-pr, --priority <level>', 'specify priority level')
                .choices(Object.values(PriorityLevel) as string[])
                .default(PriorityLevel.DEFAULT, PriorityLevel.DEFAULT)
        )
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (options) => {
            const { from, to, list, bundle, priority, min, max, program } = options;
            await commands.warmup(common.filter_wallets(wallets, from, to, list), bundle, priority, program, min, max);
        });

    program
        .command('collect')
        .alias('c')
        .description('Collect all the SOL from the wallets to the provided address')
        .argument('<receiver>', 'Public address of the receiver', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .option('-f, --from <number>', 'Colllect starting from the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-t, --to <number>', 'Collect ending at the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-l, --list <wallets...>', 'Specify the list of wallet files', (value, prev: any) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return prev ? prev?.concat(parseInt(value, 10)) : [parseInt(value, 10)];
        })
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (receiver, options) => {
            const { from, to, list } = options;
            await commands.collect(common.filter_wallets(wallets, from, to, list), receiver);
        });

    program
        .command('buy-token-once')
        .alias('bto')
        .description('Buy the token once with the provided amount')
        .argument('<amount>', 'Amount to buy in SOL', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            return parsed_value;
        })
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<buyer_index>', 'Index of the buyer wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const buyer_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!buyer_wallet) throw new InvalidArgumentError('Invalid index.');
            return buyer_wallet.keypair;
        })
        .option('-s, --slippage <number>', 'Slippage in percents', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 0.0 || parsed_value > TRADE_MAX_SLIPPAGE)
                throw new InvalidOptionArgumentError(`Invalid range (0.0 - ${TRADE_MAX_SLIPPAGE.toFixed(1)}).`);
            return parsed_value;
        })
        .option('-m, --mev <tip>', 'Enable MEV protection by providing tip amount', (value) => {
            if (!common.validate_float(value, 0))
                throw new InvalidOptionArgumentError('Not a valid tip amount. Must be greater than 0.');
            return parseFloat(value);
        })
        .addOption(
            new Option('-pr, --priority <level>', 'specify priority level')
                .choices(Object.values(PriorityLevel) as string[])
                .default(PriorityLevel.DEFAULT, PriorityLevel.DEFAULT)
        )
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (amount, mint, buyer, options) => {
            const { slippage, mev, priority, program } = options;
            await commands.buy_token_once(amount, mint, buyer, slippage, mev, priority, program);
        });

    program
        .command('sell-token-once')
        .alias('sto')
        .description('Sell the token once with the provided amount')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<seller_index>', 'Index of the seller wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const seller_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!seller_wallet) throw new InvalidArgumentError('Invalid index.');
            return seller_wallet.keypair;
        })
        .option('-p, --percent <number>', 'Percentage of the token to sell', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 0.0 || parsed_value > 1.0)
                throw new InvalidOptionArgumentError('Invalid range (0.0 - 1.0).');
            return parsed_value;
        })
        .option('-s, --slippage <number>', 'Slippage in percents', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 0.0 || parsed_value > TRADE_MAX_SLIPPAGE)
                throw new InvalidOptionArgumentError(`Invalid range (0.0 - ${TRADE_MAX_SLIPPAGE.toFixed(1)}).`);
            return parsed_value;
        })
        .option('-m, --mev <tip>', 'Enable MEV protection by providing tip amount', (value) => {
            if (!common.validate_float(value, 0))
                throw new InvalidOptionArgumentError('Not a valid tip amount. Must be greater than 0.');
            return parseFloat(value);
        })
        .addOption(
            new Option('-pr, --priority <level>', 'specify priority level')
                .choices(Object.values(PriorityLevel) as string[])
                .default(PriorityLevel.DEFAULT, PriorityLevel.DEFAULT)
        )
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (mint, seller, options) => {
            const { percent, slippage, mev, priority, program } = options;
            await commands.sell_token_once(mint, seller, percent, slippage, mev, priority, program);
        });

    program
        .command('buy-token')
        .alias('bt')
        .description('Buy the token by the mint from the wallets')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .option('-a --amount <amount>', 'Amount to buy in SOL', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            return parsed_value;
        })
        .option(
            '--min <number>',
            'Minimum amount for random buy in SOL (cannot be used with "--amount" parameter)',
            (value) => {
                const parsed_value = parseFloat(value);
                if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
                if (parsed_value <= 0.0)
                    throw new InvalidOptionArgumentError('Invalid minimum amount. Must be greater than 0.0.');
                return parsed_value;
            }
        )
        .option(
            '--max <number>',
            'Maximum amount for random buy in SOL (cannot be used with "--amount" parameter)',
            (value) => {
                const parsed_value = parseFloat(value);
                if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
                if (parsed_value <= 0.0)
                    throw new InvalidOptionArgumentError('Invalid maximum amount. Must be greater than 0.0.');
                return parsed_value;
            }
        )
        .option('-s, --slippage <number>', 'Slippage in percents', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 0.0 || parsed_value > TRADE_MAX_SLIPPAGE)
                throw new InvalidOptionArgumentError(`Invalid range (0.0 - ${TRADE_MAX_SLIPPAGE.toFixed(1)}).`);
            return parsed_value;
        })
        .option('-f, --from <number>', 'Buy starting from the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-t, --to <number>', 'Buy ending at the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-l, --list <wallets...>', 'Specify the list of wallet files', (value, prev: any) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return prev ? prev?.concat(parseInt(value, 10)) : [parseInt(value, 10)];
        })
        .option('-b, --bundle <tip>', 'Enable bundles by providing tip amount', (value) => {
            if (!common.validate_float(value, 0))
                throw new InvalidOptionArgumentError('Not a valid tip amount. Must be greater than 0.');
            return parseFloat(value);
        })
        .addOption(
            new Option('-m, --mev <tip>', 'Enable MEV protection by providing tip amount')
                .argParser((value) => {
                    if (!common.validate_float(value, 0))
                        throw new InvalidOptionArgumentError('Not a valid tip amount. Must be greater than 0.');
                    return parseFloat(value);
                })
                .conflicts('bundle')
        )
        .addOption(
            new Option('-pr, --priority <level>', 'specify priority level')
                .choices(Object.values(PriorityLevel) as string[])
                .default(PriorityLevel.DEFAULT, PriorityLevel.DEFAULT)
        )
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (mint, options) => {
            const { amount, min, max, slippage, from, to, list, bundle, mev, priority, program } = options;
            await commands.buy_token(
                common.filter_wallets(wallets, from, to, list),
                mint,
                priority,
                program,
                mev,
                bundle,
                amount,
                min,
                max,
                slippage
            );
        });

    program
        .command('sell-token')
        .alias('st')
        .description('Sell all the token by the mint from the wallets')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .option('-p, --percent <number>', 'Percentage of the token to sell', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 0.0 || parsed_value > 1.0)
                throw new InvalidOptionArgumentError('Invalid range (0.0 - 1.0).');
            return parsed_value;
        })
        .option('-s, --slippage <number>', 'Slippage in percents', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 0.0 || parsed_value > TRADE_MAX_SLIPPAGE)
                throw new InvalidOptionArgumentError(`Invalid range (0.0 - ${TRADE_MAX_SLIPPAGE.toFixed(1)}).`);
            return parsed_value;
        })
        .option('-f, --from <number>', 'Sell starting from the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-t, --to <number>', 'Sell ending at the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-l, --list <wallets...>', 'Specify the list of wallet files', (value, prev: any) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return prev ? prev?.concat(parseInt(value, 10)) : [parseInt(value, 10)];
        })
        .option('-b, --bundle <tip>', 'Enable bundles by providing tip amount', (value) => {
            if (!common.validate_float(value, 0))
                throw new InvalidOptionArgumentError('Not a valid tip amount. Must be greater than 0.');
            return parseFloat(value);
        })
        .addOption(
            new Option('-m, --mev <tip>', 'Enable MEV protection by providing tip amount')
                .argParser((value) => {
                    if (!common.validate_float(value, 0))
                        throw new InvalidOptionArgumentError('Not a valid tip amount. Must be greater than 0.');
                    return parseFloat(value);
                })
                .conflicts('bundle')
        )
        .addOption(
            new Option('-pr, --priority <level>', 'specify priority level')
                .choices(Object.values(PriorityLevel) as string[])
                .default(PriorityLevel.DEFAULT, PriorityLevel.DEFAULT)
        )
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (mint, options) => {
            const { percent, slippage, from, to, list, bundle, mev, priority, program } = options;
            await commands.sell_token(
                common.filter_wallets(wallets, from, to, list),
                mint,
                priority,
                program,
                mev,
                bundle,
                percent,
                slippage
            );
        });

    program
        .command('transfer')
        .alias('tr')
        .description('Transfer SOL from the specified keypair to the receiver')
        .argument('<amount>', 'Amount of SOL to transfer', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 0) throw new InvalidArgumentError('Invalid amount. Must be greater than 0.0');
            return parsed_value;
        })
        .argument('<receiver>', 'Public address of the receiver', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<sender_index>', 'Index of the sender wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const sender_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!sender_wallet) throw new InvalidArgumentError('Invalid index.');
            return sender_wallet.keypair;
        })
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (amount, receiver, sender) => {
            await commands.transfer_sol(amount, receiver, sender);
        });

    program
        .command('token-collect')
        .alias('tc')
        .description('Collect all the token by the mint from the wallets to the provided address')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<receiver>', 'Public address of the receiver', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .option('-f, --from <number>', 'Collect starting from the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-t, --to <number>', 'Collect ending at the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-l, --list <wallets...>', 'Specify the list of wallet files', (value, prev: any) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return prev ? prev?.concat(parseInt(value, 10)) : [parseInt(value, 10)];
        })
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (mint, receiver, options) => {
            const { from, to, list } = options;
            await commands.collect_token(common.filter_wallets(wallets, from, to, list), mint, receiver);
        });

    program
        .command('topup')
        .alias('t')
        .description('Topup the wallets with SOL using the provided wallet')
        .argument('<amount>', 'Amount of SOL to topup', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 0) throw new InvalidArgumentError('Invalid amount. Must be greater than 0.0');
            return parsed_value;
        })
        .argument('<sender_index>', 'Index of the sender wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const sender_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!sender_wallet) throw new InvalidArgumentError('Invalid index.');
            return sender_wallet.keypair;
        })
        .option('-f, --from <number>', 'Topup starting from the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-t, --to <number>', 'Topup ending at the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-l, --list <wallets...>', 'Specify the list of wallet files', (value, prev: any) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return prev ? prev?.concat(parseInt(value, 10)) : [parseInt(value, 10)];
        })
        .option(
            '-d, --depth <number>',
            "The number of transfers to be done between the sender and receiver. Can't be used with Spider enabled",
            (value) => {
                const parsed_value = parseInt(value);
                if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
                if (parsed_value < 1 || parsed_value > 5)
                    throw new InvalidOptionArgumentError('Invalid transfers. Must be greater than 0 and less than 5.');
                return parsed_value;
            }
        )
        .addOption(new Option('-s, --spider', 'Topup the account using the spider').default(false).conflicts('depth'))
        .option('-r, --random', 'Topup with random values using <amount> argument as a mean value', false)
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (amount, sender, options) => {
            const { from, to, list, depth, spider, random } = options;
            await commands.topup(common.filter_wallets(wallets, from, to, list), amount, sender, spider, random, depth);
        });

    program
        .command('create-metadata')
        .alias('cm')
        .description('Upload the metadata of the token using the provided JSON file and image')
        .argument('<json_path>', 'Path to the JSON file', (value) => {
            if (!existsSync(value)) throw new InvalidOptionArgumentError('Config file does not exist.');
            const json = common.read_json(value);
            if (!json) throw new InvalidOptionArgumentError('Invalid JSON format.');
            return json as common.IPFSMetadata;
        })
        .argument('<image_path>', 'Path to the image file', (value) => {
            if (!existsSync(value)) throw new InvalidOptionArgumentError('Image file does not exist.');
            return value;
        })
        .action(async (json, image_path) => {
            await commands.create_token_metadata(json, image_path);
        });

    program
        .command('promote')
        .alias('pr')
        .description('Create promotion tokens using the provided wallet')
        .argument('<count>', 'Number of promotion tokens to create', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 1) throw new InvalidArgumentError('Invalid count. Must be greater than 0.');
            return parsed_value;
        })
        .argument('<cid>', 'CID of the metadata on IPFS')
        .argument('<creator_index>', 'Index of the creator wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const creator_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!creator_wallet) throw new InvalidArgumentError('Invalid index.');
            return creator_wallet.keypair;
        })
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .action(async (count, cid, creator, options) => {
            const { program } = options;
            await commands.promote(count, cid, creator, program);
        });

    program
        .command('create-token')
        .alias('ct')
        .description('Create a token')
        .argument('<cid>', 'CID of the metadata on IPFS')
        .argument('<creator_index>', 'Index of the creator wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0 - ${wallet_cnt}).`);
            const creator_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!creator_wallet) throw new InvalidArgumentError('Invalid index.');
            return creator_wallet;
        })
        .option('-m, --mint <mint_private_key>', 'Private key of the mint to create', (value) => {
            try {
                return Keypair.fromSecretKey(base58.decode(value));
            } catch {
                throw new InvalidOptionArgumentError(`Invalid private key provided`);
            }
        })
        .option('-b, --buy <number>', 'Amount of SOL to buy the token', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value) || parsed_value <= 0) throw new InvalidOptionArgumentError('Not a number.');
            return parsed_value;
        })
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .action(async (cid, creator, options) => {
            const { mint, buy, program } = options;
            await commands.create_token(cid, creator, program, buy, mint);
        });

    program
        .command('clean')
        .alias('cl')
        .description('Clean the wallets')
        .action(async () => await commands.clean(wallets));

    program
        .command('drop')
        .alias('dr')
        .description('Do the drop')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<drop_index>', 'Index of the drop wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0-  ${wallet_cnt}).`);
            const drop_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!drop_wallet) throw new InvalidArgumentError('Invalid index.');
            return drop_wallet.keypair;
        })
        .option('-ap, --airdrop <percent>', 'Percent of tokens to be airdroped', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 0 || parsed_value > 1.0) throw new InvalidArgumentError('Invalid range (0.0 - 1.0).');
            return parsed_value;
        })
        .option('-pp, --presale <percent>', 'Turn on the presale', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 0 || parsed_value > 1.0)
                throw new InvalidOptionArgumentError('Invalid range (0.0 - 1.0).');
            return parsed_value;
        })
        .option(
            '-af, --airdrop-file <path>',
            'Path to the CSV file with the airdrop list',
            (value) => {
                if (!existsSync(value)) throw new InvalidOptionArgumentError('Airdrop file does not exist.');
                return value;
            },
            DROP_AIRDROP_CSV
        )
        .option(
            '-pf, --presale-file <path>',
            'Path to the CSV file with the presale list',
            (value) => {
                if (!existsSync(value)) throw new InvalidOptionArgumentError('Presale file does not exist.');
                return value;
            },
            DROP_PRESALE_CSV
        )
        .action(async (mint, drop, options) => {
            const { presale, airdrop, airdropFile, presaleFile } = options;
            await commands.drop(mint, drop, airdropFile, presaleFile, airdrop, presale);
        });

    program
        .command('benchmark')
        .alias('bh')
        .description('Benchmark the RPC node')
        .argument('<requests>', 'Number of requests to send', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 1) throw new InvalidArgumentError('Invalid count. Must be greater than 0.');
            return parsed_value;
        })
        .option('-t, --thread <number>', 'Number of threads to use', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 1) throw new InvalidOptionArgumentError('Invalid count. Must be greater than 0.');
            return parsed_value;
        })
        .option('-i --interval <number>', 'Interval between console logs', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 1) throw new InvalidOptionArgumentError('Invalid count. Must be greater than 0.');
            return parsed_value;
        })
        .action(async (requests, options) => {
            const { thread, interval } = options;
            await commands.benchmark(requests, '7536JKDpY6bGNq3qUcn87CAmwGPA4WcRctzsFDTr9i8N', thread, interval);
        });

    try {
        await program.parseAsync(process.argv);
        if (!process.argv.slice(2).length) {
            program.outputHelp();
        }
    } catch (error) {
        if (error instanceof Error) {
            program.error(error.message);
        } else {
            program.error(String(error));
        }
    }
}

main().catch(console.error);
