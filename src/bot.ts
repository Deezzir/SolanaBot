import figlet from 'figlet';
import dotenv from 'dotenv'
import { Command, InvalidArgumentError, InvalidOptionArgumentError } from 'commander';
import { existsSync, } from 'fs';
import { clearLine, cursorTo, moveCursor } from 'readline';
import * as common from './common.js';
import * as trade from './trade.js';
import * as run from './run.js';
import * as commands from './commands.js';
import * as drop from './drop.js';
import { exit } from 'process';
import { Connection, PublicKey } from '@solana/web3.js';
import { Helius } from "helius-sdk";
dotenv.config({ path: './.env' });

//------------------------------------------------------------
// MAIN
// -----------------------------------------------------------


async function main() {
    if (!existsSync(common.RESERVE_KEY_PATH))
        throw new Error("No reserve key available. Please create the 'key0.json' first.");

    let bot_config: common.BotConfig;
    let workers = new Array<common.WorkerPromise>();
    const keys = await common.get_keys(common.KEYS_DIR);
    const keys_cnt = keys.length;
    const helius_rpc = process.env.RPC || '';

    global.START_COLLECT = false;
    global.CONNECTION = new Connection(helius_rpc, 'confirmed');
    global.HELIUS_CONNECTION = new Helius(process.env.HELIUS_API_KEY || '');

    const program = new Command();

    common.log(figlet.textSync('Solana Buy Bot', { horizontalLayout: 'full' }));
    // common.log(`Using RPC: ${helius_rpc}\n`);

    program
        .version('2.0.0')
        .description('Solana Buy Bot CLI');

    program
        .command('start')
        .alias('s')
        .description('Start the bot')
        .option('-c, --config <path>', 'Path to the JSON config file', (value) => {
            if (!existsSync(value))
                throw new InvalidOptionArgumentError('Config file does not exist.');
            const json = common.read_json(value);
            if (!json) throw new InvalidOptionArgumentError('Invalid JSON format.');
            return json as common.BotConfig;
        })
        .action(async (options) => {
            let selling = false;
            let stopping = false;
            let { config } = options;

            if (config) {
                config.collect_address = new PublicKey(config.collect_address);
                if (config.mint) {
                    config.mint = new PublicKey(config.mint);
                } else if (config.token_name && config.token_ticker) {
                    common.log('Sniping mint address...');
                } else {
                    console.error('Invalid config file.');
                    exit(1);
                }
                bot_config = config;
                console.table(common.BotConfigDisplay(bot_config));
                common.setup_readline();
                await new Promise<void>(resolve => global.RL.question('Press ENTER to start the bot...', () => resolve()));
            } else {
                bot_config = await run.get_config(keys_cnt - 1);
                common.clear_lines_up(1);
                if (!bot_config) return;
            }

            if (global.RL === undefined) common.setup_readline();
            global.RL.setPrompt('Command (stop/config/collect/sell/set)> ');
            global.RL.prompt(true);

            global.RL.on('line', async (line) => {
                moveCursor(process.stdout, 0, -1);
                clearLine(process.stdout, 0);
                switch (line.trim().split(' ')[0]) {
                    case 'stop':
                        if (!stopping) {
                            if (workers.length > 0) {
                                run.worker_post_message(workers, 'stop');
                                stopping = true;
                            }
                        } else {
                            common.log('[Main Worker] Stopping is already in progress...');
                        }
                        break;
                    case 'config':
                        if (bot_config !== undefined)
                            console.table(common.BotConfigDisplay(bot_config));
                        break;
                    case 'collect':
                        if (!global.START_COLLECT) {
                            run.worker_post_message(workers, 'collect');
                            global.START_COLLECT = true;
                        } else {
                            common.log('[Main Worker] Collecting is already in progress...');
                        }
                        break;
                    case 'sell':
                        if (!selling) {
                            if (workers.length > 0) {
                                run.worker_post_message(workers, 'sell');
                                selling = true;
                            }
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
                        common.update_bot_config(bot_config, key, value);
                        break;
                    default:
                        common.log(`Unknown command: ${line.trim()}`);
                        break;
                }
                global.RL.prompt(true);
            }).on('close', () => {
                common.log('[Main Worker] Stopping the bot...');
                cursorTo(process.stdout, 0);
                clearLine(process.stdout, 0);
                process.exit(0);
            });
            await commands.start(keys, bot_config, workers)
            global.RL.close();
        });

    program
        .command('balance')
        .alias('b')
        .description('Get the balance of the accounts')
        .action(() => commands.balance(keys));

    program
        .command('spl-balance')
        .alias('sb')
        .description('Get the total balance of a token of the accounts')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value)
        })
        .action((mint) => commands.spl_balance(keys, mint));

    program
        .command('warmup')
        .alias('w')
        .description('Warmup the accounts with the tokens')
        .option('-f, --from <value>', 'Warmup starting from the provided index', (value) => {
            if (!common.validate_int(value, 1, keys_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range (1-${keys_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-t --to <value>', 'Warmup ending at the provided index', (value) => {
            if (!common.validate_int(value, 1, keys_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range (1-${keys_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-l, --list <keys...>', 'Specify the list of key files', (value, prev: any) => {
            const key_path = `${common.KEYS_DIR}/key${value}.json`;
            if (!existsSync(key_path))
                throw new InvalidOptionArgumentError(`Key file '${key_path}' does not exist.`);
            return prev ? prev?.concat(parseInt(value, 10)) : [parseInt(value, 10)];
        })
        .option('-m, --min <value>', 'Minimum amount of tokens for each key', (value) => {
            const parsedValue = parseInt(value);
            if (isNaN(parsedValue))
                throw new InvalidOptionArgumentError('Not a number.');
            if (parsedValue < 1)
                throw new InvalidOptionArgumentError('Invalid minimum amount. Must be greater than 0.');
            return parsedValue;
        })
        .option('-M, --max <value>', 'Maximum amount of tokens for each key', (value) => {
            const parsedValue = parseInt(value);
            if (isNaN(parsedValue))
                throw new InvalidOptionArgumentError('Not a number.');
            if (parsedValue < 1 || parsedValue > 50)
                throw new InvalidOptionArgumentError('Invalid maximum amount. Must be between 1 and 50')
            return parsedValue;
        })
        .action((options) => {
            const { from, to, list, min, max } = options;
            commands.warmup(keys, from, to, list, min, max);
        });

    program
        .command('collect')
        .alias('c')
        .argument('<receiver>', 'Public address of the receiver', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .option('-r, --reserve', 'Collect from the reserve account as well')
        .description('Collect all the SOL from the accounts to the provided address')
        .action((receiver, options) => {
            const { reserve } = options;
            commands.collect(keys, receiver, reserve);
        });

    program
        .command('spl-buy-once')
        .alias('bto')
        .argument('<amount>', 'Amount to buy in SOL', (value) => {
            const parsedValue = parseFloat(value);
            if (isNaN(parsedValue))
                throw new InvalidArgumentError('Not a number.');
            return parsedValue;
        })
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<buyer_path>', 'Path to the keypair file', (value) => {
            if (!existsSync(value))
                throw new InvalidArgumentError('Buyer file does not exist.');
            const buyer_keypair = common.get_keypair(value);
            if (!buyer_keypair) throw new InvalidArgumentError('Invalid keypair file.');
            return buyer_keypair;
        })
        .description('Buy the token once with the provided amount')
        .action((amount, mint, buyer) => {
            commands.buy_token_once(amount, mint, buyer);
        });

    program
        .command('spl-sell-once')
        .alias('sto')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<seller_path>', 'Path to the keypair file', (value) => {
            if (!existsSync(value))
                throw new InvalidArgumentError('Seller file does not exist.');
            const seller_keypair = common.get_keypair(value);
            if (!seller_keypair) throw new InvalidArgumentError('Invalid keypair file.');
            return seller_keypair;
        })
        .option('-p, --percent <number>', 'Percentage of the token to sell', (value) => {
            const parsedValue = parseFloat(value);
            if (isNaN(parsedValue))
                throw new InvalidOptionArgumentError('Not a number.');
            if (parsedValue < 0.0 || parsedValue > 100.0)
                throw new InvalidOptionArgumentError('Invalid range (0.0 - 100.0).');
            return parsedValue;
        })
        .description('Sell the token once with the provided amount')
        .action((mint, seller, options) => {
            const { percent } = options;
            commands.sell_token_once(mint, seller, percent);
        });

    program
        .command('spl-sell')
        .alias('st')
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .option('-l, --list <keys...>', 'Specify the list of key files', (value, prev: any) => {
            const key_path = `${common.KEYS_DIR}/key${value}.json`;
            if (!existsSync(key_path))
                throw new InvalidOptionArgumentError(`Key file '${key_path}' does not exist.`);
            return prev ? prev?.concat(parseInt(value, 10)) : [parseInt(value, 10)];
        })
        .option('-p, --percent <number>', 'Percentage of the token to sell', (value) => {
            const parsedValue = parseFloat(value);
            if (isNaN(parsedValue))
                throw new InvalidOptionArgumentError('Not a number.');
            if (parsedValue < 0.0 || parsedValue > 100.0)
                throw new InvalidOptionArgumentError('Invalid range (0.0 - 100.0).');
            return parsedValue;
        })
        .description('Sell all the token by the mint from the accounts')
        .action((mint, options) => {
            const { list, percent } = options;
            commands.sell_token(mint, list, percent);
        });

    program
        .command('transfer')
        .alias('tr')
        .argument('<amount>', 'Amount of SOL to topup', (value) => {
            const parsedValue = parseFloat(value);
            if (isNaN(parsedValue))
                throw new InvalidArgumentError('Not a number.');
            if (parsedValue < 0)
                throw new InvalidArgumentError('Invalid amount. Must be greater than 0.0');
            return parsedValue;
        })
        .argument('<receiver>', 'Public address of the receiver', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<sender_path>', 'Path to the keypair file', (value) => {
            if (!existsSync(value))
                throw new InvalidArgumentError('Sender file does not exist.');
            const sender_keypair = common.get_keypair(value);
            if (!sender_keypair) throw new InvalidArgumentError('Invalid keypair file.');
            return sender_keypair;
        })
        .description('Transfer SOL from the specified keypair to the receiver')
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
        .option('-r, --reserve', 'Collect from the reserve account as well')
        .description('Collect all the token by the mint from the accounts to the provided address')
        .action((mint, receiver, options) => {
            const { reserve } = options;
            commands.collect_token(keys, mint, receiver, reserve);
        });

    program
        .command('topup')
        .argument('<amount>', 'Amount of SOL to topup', (value) => {
            const parsedValue = parseFloat(value);
            if (isNaN(parsedValue))
                throw new InvalidArgumentError('Not a number.');
            if (parsedValue < 0)
                throw new InvalidArgumentError('Invalid amount. Must be greater than 0.0');
            return parsedValue;
        })
        .argument('<sender_path>', 'Path to the keypair file of the sender', (value) => {
            if (!existsSync(value))
                throw new InvalidArgumentError('Sender file does not exist.');
            const sender_keypair = common.get_keypair(value);
            if (!sender_keypair) throw new InvalidArgumentError('Invalid keypair file.');
            return sender_keypair;
        })
        .option('-f, --from <value>', 'Topup starting from the provided index', (value) => {
            if (!common.validate_int(value, 1, keys_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(1 - ${keys_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-t --to <value>', 'Topup ending at the provided index', (value) => {
            if (!common.validate_int(value, 1, keys_cnt))
                throw new InvalidOptionArgumentError(`Not a valid range(1 - ${keys_cnt}).`);
            return parseInt(value, 10);
        })
        .option('-l, --list <keys...>', 'Specify the list of key files', (value, prev: any) => {
            const key_path = `${common.KEYS_DIR}/key${value}.json`;
            if (!existsSync(key_path)) // || !common.validate_int(value, 1, keys_cnt))
                throw new InvalidOptionArgumentError(`Key file '${key_path}' does not exist.`);
            return prev ? prev?.concat(parseInt(value, 10)) : [parseInt(value, 10)];
        })
        .alias('t')
        .description('Topup the accounts with SOL using the provided keypair')
        .action((amount, sender, options) => {
            const { from, to, list } = options;
            commands.topup(keys, amount, sender, from, to, list);
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
            const parsedValue = parseInt(value);
            if (isNaN(parsedValue))
                throw new InvalidArgumentError('Not a number.');
            if (parsedValue < 1)
                throw new InvalidArgumentError('Invalid count. Must be greater than 0.');
            return parsedValue;
        })
        .argument('<cid>', 'CID of the metadata on Quicknode IPFS')
        .argument('<creator_path>', 'Path to the keypair file of the creator', (value) => {
            if (!existsSync(value))
                throw new InvalidArgumentError('Creator file does not exist.');
            const creator_keypair = common.get_keypair(value);
            if (!creator_keypair) throw new InvalidArgumentError('Invalid keypair file.');
            return creator_keypair;
        })
        .description('Create promotion tokens using the provided keypair')
        .action((count, cid, creator) => {
            commands.promote(count, cid, creator);
        });

    program
        .command('create-token')
        .alias('ct')
        .argument('<cid>', 'CID of the metadata on Quicknode IPFS')
        .argument('<creator_path>', 'Path to the keypair file of the creator', (value) => {
            if (!existsSync(value))
                throw new InvalidArgumentError('Creator file does not exist.');
            const creator_keypair = common.get_keypair(value);
            if (!creator_keypair) throw new InvalidArgumentError('Invalid keypair file.');
            return creator_keypair;
        })
        .option('-m, --mint <mint_path>', 'Path to the mint keypair file', (value) => {
            if (!existsSync(value))
                throw new InvalidOptionArgumentError('Mint file does not exist.');
            const mint_keypair = common.get_keypair(value);
            if (!mint_keypair) throw new InvalidOptionArgumentError('Invalid keypair file.');
            return mint_keypair;
        })
        .option('-b, --buy <number>', 'Amount of SOL to buy the token', (value) => {
            const parsedValue = parseFloat(value);
            if (isNaN(parsedValue) || parsedValue <= 0)
                throw new InvalidOptionArgumentError('Not a number.');
            return parsedValue;
        })
        .description('Create a token')
        .action((cid, creator, options) => {
            const { mint, buy } = options;
            commands.create_token(cid, creator, buy, mint);
        });

    program
        .command('drop')
        .alias('dr')
        .argument('<airdrop>', 'Percent of tokens to be airdroped', (value) => {
            const parsedValue = parseInt(value);
            if (isNaN(parsedValue))
                throw new InvalidArgumentError('Not a number.');
            if (parsedValue < 0 || parsedValue > 100)
                throw new InvalidArgumentError('Invalid range (0-100).');
            return parsedValue;
        })
        .argument('<mint>', 'Public address of the mint', (value) => {
            if (!common.is_valid_pubkey(value))
                throw new InvalidArgumentError('Not an address.');
            return new PublicKey(value);
        })
        .argument('<drop_path>', 'Path to the keypair file of the dropper', (value) => {
            if (!existsSync(value))
                throw new InvalidArgumentError('Dropper file does not exist.');
            const dropper_keypair = common.get_keypair(value);
            if (!dropper_keypair) throw new InvalidArgumentError('Invalid keypair file.');
            return dropper_keypair;
        })
        .option('-p, --presale <number>', 'Turn on the presale', (value) => {
            const parsedValue = parseInt(value);
            if (isNaN(parsedValue))
                throw new InvalidOptionArgumentError('Not a number.');
            if (parsedValue < 0 || parsedValue > 100)
                throw new InvalidOptionArgumentError('Invalid range (0-100).');
            return parsedValue;
        })
        .description('Do the drop')
        .action(async (airdrop, mint, drop, options) => {
            const { presale } = options;
            await drop.drop(airdrop, mint, drop, presale);
        });

    program
        .command('clean')
        .alias('cl')
        .description('Clean the accounts')
        .action(commands.clean);

    program
        .command('clear-drop')
        .alias('cd')
        .argument('<airdrop_file_path>', 'Path to the airdrop file', (value) => {
            if (!existsSync(value))
                throw new InvalidArgumentError('Airdrop file does not exist.');
            return value;
        })
        .description('Clear the drop')
        .action((airdrop_file_path) => {
            drop.clear_drop(airdrop_file_path);
        });

    program.parse(process.argv);
    if (!process.argv.slice(2).length) {
        program.outputHelp();
    }
}

main().catch(console.error);