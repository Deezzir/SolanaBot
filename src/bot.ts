import figlet from 'figlet';
import dotenv from 'dotenv';
import { Command, InvalidArgumentError, InvalidOptionArgumentError, Option } from 'commander';
import { existsSync } from 'fs';
import * as common from './common.js';
import * as run from './pump_start.js';
import * as token_drop from './token_drop.js';
import * as commands from './commands.js';
import { exit } from 'process';
import { Connection, PublicKey } from '@solana/web3.js';
import { Helius } from 'helius-sdk';
import { Environment, Moonshot } from '@wen-moon-ser/moonshot-sdk';
dotenv.config({ path: './.env' });

//------------------------------------------------------------
// MAIN
// -----------------------------------------------------------

function reserve_wallet_preaction(wallets: common.Wallet[]) {
    if (!common.check_reserve_exists(wallets)) {
        common.error('[ERROR] Reserve keypair not found.');
        exit(1);
    }
}

async function main() {
    let workers = new Array<common.WorkerJob>();
    const wallets = await common.get_wallets(common.WALLETS_FILE);
    const wallet_cnt = wallets.length;
    if (wallet_cnt === 0) {
        common.error('[ERROR] No wallets files found.');
        exit(1);
    }

    global.CONNECTION = new Connection(process.env.RPC || '', 'confirmed');
    global.HELIUS_CONNECTION = new Helius(process.env.HELIUS_API_KEY || '');
    global.MOONSHOT = new Moonshot({
        rpcUrl: global.CONNECTION.rpcEndpoint,
        environment: Environment.MAINNET,
        chainOptions: {
            solana: { confirmOptions: { commitment: 'confirmed' } }
        }
    });

    const program = new Command();

    common.log(figlet.textSync('Solana Bot', { horizontalLayout: 'full' }));

    program
        .version('3.0.0')
        .description('Solana Bot CLI');

    program
        .command('start')
        .alias('s')
        .description('Start the bot')
        .option('-c, --config <path>', 'Path to the JSON config file', (value) => {
            if (!existsSync(value))
                throw new InvalidOptionArgumentError('Config file does not exist.');
            const json = common.read_json(value);
            const config = common.validate_bot_config(json);
            if (!config)
                throw new InvalidOptionArgumentError('Invalid Config JSON format.');
            return config;
        })
        .hook('preAction', () => reserve_wallet_preaction(wallets))
        .action(async (options: any) => {
            let { config } = options;
            const bot_config = await run.setup_config(config, wallet_cnt);
            if (!bot_config) {
                common.error('[ERROR] Invalid configuration.');
                exit(1);
            }
            run.setup_cmd_interface(workers, bot_config)
            await commands.start(wallets, bot_config, workers)
            global.RL.close();
        });

    program
        .command('generate')
        .alias('g')
        .argument('<count>', 'Number of wallets to generate', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value))
                throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 1)
                throw new InvalidArgumentError('Invalid count. Must be greater than 0.');
            return parsed_value;
        })
        .argument('<name>', 'Name of the file to save the wallets', (value) => {
            if (existsSync(value))
                throw new InvalidArgumentError('File with the same name already exists.');
            return value;
        })
        .option('-k, --keys_path <path>', 'Path to the file with secret keys to convert', (value) => {
            if (!existsSync(value))
                throw new InvalidOptionArgumentError('Keys file does not exist.');
            return value;
        })
        .option('-i, --index <index>', 'Starting index of the wallets', (value) => {
            if (!common.validate_int(value, 0))
                throw new InvalidOptionArgumentError(`Index should be greater than 0.`);
            return parseInt(value, 10);
        })
        .option('-r, --reserve', 'Generate the reserve wallet', false)
        .action((count, name, options) => {
            let { keys_path, index, reserve } = options;
            commands.generate(count, name, reserve, keys_path, index);
        })
        .description('Generate the wallets. Optionally, a file with secret keys (separated by newline) can be provided to convert them to keypairs.');

    program
        .command('balance')
        .alias('b')
        .description('Get the balance of the accounts')
        .action(() => commands.balance(wallets));

    program
        .command('spl-balance')
        .alias('sb')
        .description('Get the total balance of a token of the accounts')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value)
        })
        .action((mint) => commands.spl_balance(wallets, mint));

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
            if (isNaN(parsed_value))
                throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 1)
                throw new InvalidOptionArgumentError('Invalid minimum amount. Must be greater than 0.');
            return parsed_value;
        })
        .option('-M, --max <value>', 'Maximum amount of tokens for each wallet', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value))
                throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 1 || parsed_value > 50)
                throw new InvalidOptionArgumentError('Invalid maximum amount. Must be between 1 and 50')
            return parsed_value;
        })
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .hook('preAction', () => reserve_wallet_preaction(wallets))
        .action((options) => {
            const { from, to, list, min, max, program } = options;
            commands.warmup(common.filter_wallets(wallets, from, to, list), program, min, max);
        });

    program
        .command('collect')
        .alias('c')
        .argument('<receiver>', 'Public address of the receiver', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
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
        .description('Collect all the SOL from the accounts to the provided address')
        .hook('preAction', () => reserve_wallet_preaction(wallets))
        .action((receiver, options) => {
            const { from, to, list } = options;
            commands.collect(common.filter_wallets(wallets, from, to, list), receiver);
        });

    program
        .command('spl-buy-once')
        .alias('bto')
        .argument('<amount>', 'Amount to buy in SOL', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value))
                throw new InvalidArgumentError('Not a number.');
            return parsed_value;
        })
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
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
        .description('Buy the token once with the provided amount')
        .hook('preAction', () => reserve_wallet_preaction(wallets))
        .action((amount, mint, buyer, options) => {
            const { program } = options
            commands.buy_token_once(amount, mint, buyer, program);
        });

    program
        .command('spl-sell-once')
        .alias('sto')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
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
            if (isNaN(parsed_value))
                throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 0.0 || parsed_value > 100.0)
                throw new InvalidOptionArgumentError('Invalid range (0.0 - 100.0).');
            return parsed_value;
        })
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .description('Sell the token once with the provided amount')
        .hook('preAction', () => reserve_wallet_preaction(wallets))
        .action((mint, seller, options) => {
            const { percent, program } = options;
            commands.sell_token_once(mint, seller, percent, program);
        });

    program
        .command('spl-buy')
        .alias('bt')
        .argument('<amount>', 'Amount to buy in SOL', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value))
                throw new InvalidArgumentError('Not a number.');
            return parsed_value;
        })
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
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
        .description('Buy the token by the mint from the accounts')
        .hook('preAction', () => reserve_wallet_preaction(wallets))
        .action((amount, mint, options) => {
            const { from, to, list, program } = options;
            commands.buy_token(common.filter_wallets(wallets, from, to, list), amount, mint, program);
        });

    program
        .command('spl-sell')
        .alias('st')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
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
            if (isNaN(parsed_value))
                throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 0.0 || parsed_value > 100.0)
                throw new InvalidOptionArgumentError('Invalid range (0.0 - 100.0).');
            return parsed_value;
        })
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .description('Sell all the token by the mint from the accounts')
        .hook('preAction', () => reserve_wallet_preaction(wallets))
        .action((mint, options) => {
            const { from, to, list, percent, program } = options;
            commands.sell_token(common.filter_wallets(wallets, from, to, list), mint, program, percent);
        });

    program
        .command('transfer')
        .alias('tr')
        .argument('<amount>', 'Amount of SOL to transfer', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value))
                throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 0)
                throw new InvalidArgumentError('Invalid amount. Must be greater than 0.0');
            return parsed_value;
        })
        .argument('<receiver>', 'Public address of the receiver', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<sender_index>', 'Index of the sender wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0-${wallet_cnt}).`);
            const sender_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!sender_wallet) throw new InvalidArgumentError('Invalid index.');
            return sender_wallet.keypair;
        })
        .description('Transfer SOL from the specified keypair to the receiver')
        .hook('preAction', () => reserve_wallet_preaction(wallets))
        .action((amount, receiver, sender) => {
            commands.transfer_sol(amount, receiver, sender);
        });

    program
        .command('spl-collect')
        .alias('sc')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<receiver>', 'Public address of the receiver', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
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
        .description('Collect all the token by the mint from the accounts to the provided address')
        .hook('preAction', () => reserve_wallet_preaction(wallets))
        .action((mint, receiver, options) => {
            const { from, to, list } = options;
            commands.collect_token(common.filter_wallets(wallets, from, to, list), mint, receiver);
        });

    program
        .command('topup')
        .argument('<amount>', 'Amount of SOL to topup', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value))
                throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 0)
                throw new InvalidArgumentError('Invalid amount. Must be greater than 0.0');
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
        .alias('t')
        .description('Topup the accounts with SOL using the provided wallet')
        .hook('preAction', () => reserve_wallet_preaction(wallets))
        .action((amount, sender, options) => {
            const { from, to, list, spider } = options;
            commands.topup(common.filter_wallets(wallets, from, to, list), amount, sender, spider);
        });

    program
        .command('metadata')
        .alias('m')
        .argument('<json_path>', 'Path to the JSON file', (value) => {
            if (!existsSync(value))
                throw new InvalidOptionArgumentError('Config file does not exist.');
            const json = common.read_json(value);
            if (!json) throw new InvalidOptionArgumentError('Invalid JSON format.');
            return json as common.IPFSMetadata;
        })
        .argument('<image_path>', 'Path to the image file', (value) => {
            if (!existsSync(value))
                throw new InvalidOptionArgumentError('Image file does not exist.');
            return value;
        })
        .description('Upload the metadata of the token using the provided JSON file')
        .action(async (json_path, image_path) => {
            console.log('Uploading metadata...');
            console.log(`CID: ${await common.create_metadata(json_path, image_path)}`);
        });

    program
        .command('promote')
        .alias('pr')
        .argument('<count>', 'Number of promotion tokens to create', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value))
                throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 1)
                throw new InvalidArgumentError('Invalid count. Must be greater than 0.');
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
        .description('Create promotion tokens using the provided wallet')
        .action((count, cid, creator, options) => {
            const { program } = options;
            commands.promote(count, cid, creator, program);
        });

    program
        .command('create-token')
        .alias('ct')
        .argument('<cid>', 'CID of the metadata on Quicknode IPFS')
        .argument('<creator_index>', 'Index to the creator wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0-${wallet_cnt}).`);
            const creator_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!creator_wallet) throw new InvalidArgumentError('Invalid index.');
            return creator_wallet;
        })
        .option('-m, --mint <mint_private_key>', 'Private key of the mint to create', (value) => {
            const mint_keypair = common.get_keypair_from_private_key(value);
            if (!mint_keypair) throw new InvalidOptionArgumentError('Invalid private key provided.');
            return mint_keypair;
        })
        .option('-b, --buy <number>', 'Amount of SOL to buy the token', (value) => {
            const parsed_value = parseFloat(value);
            if (isNaN(parsed_value) || parsed_value <= 0)
                throw new InvalidOptionArgumentError('Not a number.');
            return parsed_value;
        })
        .addOption(
            new Option('-g, --program <type>', 'specify program')
                .choices(Object.values(common.Program) as string[])
                .default(common.Program.Pump, common.Program.Pump)
        )
        .description('Create a token')
        .action((cid, creator, options) => {
            const { mint, buy, program } = options;
            commands.create_token(cid, creator, program, buy, mint);
        });
    program
        .command('clean')
        .alias('cl')
        .description('Clean the accounts')
        .action(() => commands.clean(wallets));

    program
        .command('drop')
        .alias('dr')
        .argument('<airdrop>', 'Percent of tokens to be airdroped', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value))
                throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 0 || parsed_value > 100)
                throw new InvalidArgumentError('Invalid range (0-100).');
            return parsed_value;
        })
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<drop_index>', 'Index of the drop wallet', (value) => {
            if (!common.validate_int(value, 0, wallet_cnt))
                throw new InvalidArgumentError(`Not a valid range (0-${wallet_cnt}).`);
            const drop_wallet = common.get_wallet(parseInt(value, 10), wallets);
            if (!drop_wallet) throw new InvalidArgumentError('Invalid index.');
            return drop_wallet.keypair;
        })
        .option('-p, --presale <number>', 'Turn on the presale', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value))
                throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 0 || parsed_value > 100)
                throw new InvalidOptionArgumentError('Invalid range (0-100).');
            return parsed_value;
        })
        .description('Do the drop')
        .action(async (airdrop, mint, drop, options) => {
            const { presale } = options;
            await token_drop.drop(airdrop, mint, drop, presale);
        });

    program
        .command('benchmark')
        .argument('<requests>', 'Number of requests to send', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value))
                throw new InvalidArgumentError('Not a number.');
            if (parsed_value < 1)
                throw new InvalidArgumentError('Invalid count. Must be greater than 0.');
            return parsed_value;
        })
        .option('-t, --thread <number>', 'Number of threads to use', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value))
                throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 1)
                throw new InvalidOptionArgumentError('Invalid count. Must be greater than 0.');
            return parsed_value;
        })
        .option('-i --interval <number>', 'Interval between console logs', (value) => {
            const parsed_value = parseInt(value);
            if (isNaN(parsed_value))
                throw new InvalidOptionArgumentError('Not a number.');
            if (parsed_value < 1)
                throw new InvalidOptionArgumentError('Invalid count. Must be greater than 0.');
            return parsed_value;
        })
        .description('Benchmark the RPC node')
        .action((requests, options) => {
            const { thread, interval } = options;
            commands.benchmark(requests, '7536JKDpY6bGNq3qUcn87CAmwGPA4WcRctzsFDTr9i8N', thread, interval);
        });

    program.parse(process.argv);
    if (!process.argv.slice(2).length) {
        program.outputHelp();
    }
}

main().catch(console.error);
