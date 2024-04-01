import figlet from 'figlet';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { readdir } from 'fs/promises';
import path from 'path';

interface BotConfig {
    thread_cnt: number;
    buy_interval: number;
    spend_limit: number;
    return_pubkey: string;
    mcap_threshold: number;
}

async function count_keys(): Promise<number> {
    try {
        const files = await readdir('./keys');
        return files.filter(file => path.extname(file) === '.json').length;
    } catch (err) {
        console.error('Error reading keys directory:', err);
        return 0;
    }
}

async function clear_lines_up(lines: number): Promise<void> {
    process.stdout.moveCursor(0, -lines);
    process.stdout.clearScreenDown();
}

async function get_config(): Promise<BotConfig> {
    let answers: BotConfig;
    const keys_cnt = await count_keys();
    do {
        answers = await inquirer.prompt<BotConfig>([
            {
                type: 'number',
                name: 'thread_cnt',
                message: `Enter the number of bots to run(${keys_cnt} accounts available):`,
                validate: input => {
                    if (input <= 0) return "Please enter a positive number.";
                    if (input > keys_cnt) return `Please enter a number less than or equal to ${keys_cnt}.`;
                    return true;
                },
            },
            {
                type: 'number',
                name: 'buy_interval',
                message: 'Enter the interval between each buy in seconds:',
                validate: input => input > 0 || "Please enter a positive number."
            },
            {
                type: 'number',
                name: 'spend_limit',
                message: 'Enter the limit of Solana that each bot can spend:',
                validate: input => input > 0 || "Please enter a positive number."
            },
            {
                type: 'input',
                name: 'return_pubkey',
                message: 'Enter the return public key:',
                validate: input => /[a-zA-Z0-9]{43,44}/.test(input) || "Please enter a valid public key."
            },
            {
                type: 'number',
                name: 'mcap_threshold',
                message: 'Enter the threshold market cap:',
                validate: input => input > 0 || "Please enter a positive number."
            },
        ]);

        await clear_lines_up(Object.keys(answers).length);
        console.table(answers);
        const confirm = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'confirmation',
                message: 'Do you want to start the bot with the above configuration?',
            }
        ]);

        if (confirm.confirmation) break;
    } while (true);

    return answers;
}

async function start() {
    const config = await get_config();
    clear_lines_up(1);
    if (!config) return;
    console.log('Bot started');
}

const program = new Command();

console.log(figlet.textSync('Solana Buy Bot', { horizontalLayout: 'full' }));

program
    .version('1.0.0')
    .description('Solana Buy Bot CLI');

program
    .command('start')
    .alias('s')
    .description('Start the bot')
    .action(start);

program.parse(process.argv);

if (!process.argv.slice(2).length) {
    program.outputHelp();
}
