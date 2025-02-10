import figlet from 'figlet';
import { Command, InvalidArgumentError, InvalidOptionArgumentError, Option } from 'commander';
import { existsSync } from 'fs';
import * as common from './common/common.js';
import * as commands from './commands.js';
import { exit } from 'process';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Helius } from 'helius-sdk';
import { Environment, Moonshot } from '@wen-moon-ser/moonshot-sdk';
import { Wallet } from './common/common.js';
import { COMMITMENT, HELIUS_API_KEY, RPC, WALLETS_FILE } from './constants.js';
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

async function main() {
    let wallets: Wallet[] = [];

    try {
        wallets = await common.get_wallets(WALLETS_FILE);
    } catch (error) {
        if (error instanceof Error) {
            common.error(common.yellow(`[WARNING] ${error.message}`));
        }
    }

    const wallet_cnt = wallets.length;
    global.CONNECTION = new Connection(RPC, COMMITMENT);
    global.HELIUS_CONNECTION = new Helius(HELIUS_API_KEY);
    global.MOONSHOT = new Moonshot({
        rpcUrl: global.CONNECTION.rpcEndpoint,
        environment: Environment.MAINNET,
        chainOptions: {
            solana: { confirmOptions: { commitment: COMMITMENT } }
        }
    });

    const program = new Command();

    program.version('3.5.0').description('Solana Bot CLI');

    program.addHelpText('beforeAll', figlet.textSync('Solana Bot', { horizontalLayout: 'full' }));
    program.showHelpAfterError('Use --help for additional information');

    program.configureOutput({
        writeOut: (str) => process.stdout.write(str),
        writeErr: (str) => process.stderr.write(str),
        outputError: (str, write) => write(common.red(str))
    });

    program
        .command('start')
        .alias('s')
        .description('Start the bot')
        .option('-c, --config <path>', 'Path to the JSON config file', (value) => {
            if (!existsSync(value)) throw new InvalidOptionArgumentError('Config file does not exist.');
            return common.read_json(value);
        })
        .option('-f, --from <value>', 'Warmup starting from the provided index', (value) => {
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
            await commands.start(common.filter_wallets(wallets, from), program, config);
        });

    program
        .command('volume')
        .alias('v')
        .description('Generate the volume for the Raydium pool')
        .option('-c, --config <path>', 'Path to the JSON config file', (value) => {
            if (!existsSync(value)) throw new InvalidOptionArgumentError('Config file does not exist.');
            return common.read_json(value);
        })
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (options: any) => {
            const { config } = options;
            await commands.start_volume(config);
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
        .description('Get the balance of the accounts')
        .action(async () => await commands.balance(wallets));

    program
        .command('spl-balance')
        .alias('sb')
        .description('Get the total balance of a token of the accounts')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .action(async (mint) => await commands.spl_balance(wallets, mint));

    program
        .command('warmup')
        .alias('w')
        .description('Warmup the accounts with the tokens')
        .option('-f, --from <value>', 'Warmup starting from the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-t, --to <value>', 'Warmup ending at the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-l, --list <wallets...>', 'Specify the list of wallet files', (value, prev: any) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return prev ? prev?.concat(parseInt(value, 10)) : [parseInt(value, 10)];
        })
        .option('-m, --min <value>', 'Minimum amount of tokens for each wallet', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 1)
                throw new InvalidOptionArgumentError('Invalid minimum amount. Must be greater than 0.');
            return parsed_value;
        })
        .option('-M, --max <value>', 'Maximum amount of tokens for each wallet', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 1 || parsed_value > 50)
                throw new InvalidOptionArgumentError('Invalid maximum amount. Must be between 1 and 50');
            return parsed_value;
        })
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (options) => {
            const { from, to, list, min, max, program } = options;
            await commands.warmup(common.filter_wallets(wallets, from, to, list), program, min, max);
        });

    program
        .command('collect')
        .alias('c')
        .description('Collect all the SOL from the accounts to the provided address')
        .argument('<receiver>', 'Public address of the receiver', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .option('-f, --from <value>', 'Colllect starting from the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-t, --to <value>', 'Collect ending at the provided index', (value) => {
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
        .command('spl-buy-once')
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
                throw new InvalidArgumentError(`Not a valid range (0-${wallet_cnt}).`);
            const buyer_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!buyer_wallet) throw new InvalidArgumentError('Invalid index.');
            return buyer_wallet.keypair;
        })
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (amount, mint, buyer, options) => {
            const { program } = options;
            await commands.buy_token_once(amount, mint, buyer, program);
        });

    program
        .command('spl-sell-once')
        .alias('sto')
        .description('Sell the token once with the provided amount')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<seller_index>', 'Index of the seller wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0-${wallet_cnt}).`);
            const seller_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!seller_wallet) throw new InvalidArgumentError('Invalid index.');
            return seller_wallet.keypair;
        })
        .option('-p, --percent <number>', 'Percentage of the token to sell', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 0.0 || parsed_value > 100.0)
                throw new InvalidOptionArgumentError('Invalid range (0.0 - 100.0).');
            return parsed_value;
        })
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (mint, seller, options) => {
            const { percent, program } = options;
            await commands.sell_token_once(mint, seller, percent, program);
        });

    program
        .command('spl-buy')
        .alias('bt')
        .description('Buy the token by the mint from the accounts')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .option('-a --amount <amount>', 'Amount to buy in SOL', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            return parsed_value;
        })
        .option('-m, --min <value>', 'Minimum amount for random buy in SOL', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value <= 0.0)
                throw new InvalidOptionArgumentError('Invalid minimum amount. Must be greater than 0.0.');
            return parsed_value;
        })
        .option('-M, --max <value>', 'Maximum amount for random buy in SOL', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value <= 0.0)
                throw new InvalidOptionArgumentError('Invalid maximum amount. Must be greater than 0.0.');
            return parsed_value;
        })
        .option('-f, --from <value>', 'Buy starting from the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-t, --to <value>', 'Buy ending at the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-l, --list <wallets...>', 'Specify the list of wallet files', (value, prev: any) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return prev ? prev?.concat(parseInt(value, 10)) : [parseInt(value, 10)];
        })
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (mint, options) => {
            const { amount, min, max, from, to, list, program } = options;
            await commands.buy_token(common.filter_wallets(wallets, from, to, list), mint, program, amount, min, max);
        });

    program
        .command('spl-sell')
        .alias('st')
        .description('Sell all the token by the mint from the accounts')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .option('-f, --from <value>', 'Sell starting from the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-t, --to <value>', 'Sell ending at the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-l, --list <wallets...>', 'Specify the list of wallet files', (value, prev: any) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return prev ? prev?.concat(parseInt(value, 10)) : [parseInt(value, 10)];
        })
        .option('-p, --percent <number>', 'Percentage of the token to sell', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 0.0 || parsed_value > 100.0)
                throw new InvalidOptionArgumentError('Invalid range (0.0 - 100.0).');
            return parsed_value;
        })
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (mint, options) => {
            const { from, to, list, percent, program } = options;
            await commands.sell_token(common.filter_wallets(wallets, from, to, list), mint, program, percent);
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
                throw new InvalidArgumentError(`Not a valid range (0-${wallet_cnt}).`);
            const sender_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!sender_wallet) throw new InvalidArgumentError('Invalid index.');
            return sender_wallet.keypair;
        })
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (amount, receiver, sender) => {
            await commands.transfer_sol(amount, receiver, sender);
        });

    program
        .command('spl-collect')
        .alias('sc')
        .description('Collect all the token by the mint from the accounts to the provided address')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<receiver>', 'Public address of the receiver', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .option('-f, --from <value>', 'Collect starting from the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-t, --to <value>', 'Collect ending at the provided index', (value) => {
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
        .description('Topup the accounts with SOL using the provided wallet')
        .argument('<amount>', 'Amount of SOL to topup', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 0) throw new InvalidArgumentError('Invalid amount. Must be greater than 0.0');
            return parsed_value;
        })
        .argument('<sender_index>', 'Index of the sender wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0-${wallet_cnt}).`);
            const sender_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!sender_wallet) throw new InvalidArgumentError('Invalid index.');
            return sender_wallet.keypair;
        })
        .option('-f, --from <value>', 'Topup starting from the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-t, --to <value>', 'Topup ending at the provided index', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-l, --list <wallets...>', 'Specify the list of wallet files', (value, prev: any) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(0 - ${wallet_cnt}).`);
            return prev ? prev?.concat(parseInt(value, 10)) : [parseInt(value, 10)];
        })
        .option('-s, --spider', 'Topup the account using the spider')
        .option('-r, --random', 'Topup with random values using <amount> argument as a mean value')
        .hook('preAction', () => reserve_wallet_check(wallets))
        .action(async (amount, sender, options) => {
            const { from, to, list, spider, random } = options;
            await commands.topup(common.filter_wallets(wallets, from, to, list), amount, sender, spider, random);
        });

    program
        .command('metadata')
        .alias('m')
        .description('Upload the metadata of the token using the provided JSON file')
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
        .action(async (json_path, image_path) => {
            console.log('Uploading metadata...');
            console.log(`CID: ${await common.create_metadata(json_path, image_path)}`);
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
        .argument('<cid>', 'CID of the metadata on Quicknode IPFS')
        .argument('<creator_index>', 'Index of the creator wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0-${wallet_cnt}).`);
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
        .argument('<cid>', 'CID of the metadata on Quicknode IPFS')
        .argument('<creator_index>', 'Index of the creator wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0-${wallet_cnt}).`);
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
        .description('Clean the accounts')
        .action(async () => await commands.clean(wallets));

    program
        .command('drop')
        .alias('dr')
        .description('Do the drop')
        .argument('<airdrop_percent>', 'Percent of tokens to be airdroped', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 0 || parsed_value > 100) throw new InvalidArgumentError('Invalid range (0-100).');
            return parsed_value;
        })
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value)) throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<drop_index>', 'Index of the drop wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0-${wallet_cnt}).`);
            const drop_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!drop_wallet) throw new InvalidArgumentError('Invalid index.');
            return drop_wallet.keypair;
        })
        .option('-p, --presale <percent>', 'Turn on the presale', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value)) throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 0 || parsed_value > 100) throw new InvalidOptionArgumentError('Invalid range (0-100).');
            return parsed_value;
        })
        .action(async (airdrop_percent, mint, drop, options) => {
            const { presale_percent } = options;
            await commands.drop(airdrop_percent, mint, drop, presale_percent);
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
