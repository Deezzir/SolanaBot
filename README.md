# Solana Bot

## Quick Start

1. Open the terminal and clone the repo

```bash
git clone https://github.com/Deezzir/SolanaBot.git
```

2. Change the directory to the cloned repo

```bash
cd SolanaBot
```

3. Install Node.js and npm if you haven't already, and install the dependencies

A good way to install Node.js and NPM is to use [npm DOCS](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)

```bash
npm install
```

4. Create a `.env` file in the root directory and add the following

```bash
RPC=
HELIUS_API_KEY=
KEYS_FILE=keys.csv
IPFS_API_KEY=
MONGO_URI=
MONGO_DB_NAME=
JITOTIP_AUTH_KEY=
```

5. Build the project

```bash
npm run build
```

6. Run the project

```bash
node dist/bot.js -h

Usage: bot [options] [command]

Solana Bot CLI

Options:
  -V, --version                                             output the version number
  -h, --help                                                display help for command

Commands:
  start|s [options]                                         Start the bot
  generate|g [options] <count> <name>                       Generate the keypairs. Optionally, a file with secret keys (separated by newline) can be provided to convert them to keypairs.
  balance|b                                                 Get the balance of the accounts
  spl-balance|sb <mint>                                     Get the total balance of a token of the accounts
  warmup|w [options]                                        Warmup the accounts with the tokens
  collect|c [options] <receiver>                            Collect all the SOL from the accounts to the provided address
  spl-buy-once|bto [options] <amount> <mint> <buyer_index>  Buy the token once with the provided amount
  spl-sell-once|sto [options] <mint> <seller_index>         Sell the token once with the provided amount
  spl-buy|bt [options] <amount> <mint>                      Buy the token by the mint from the accounts
  spl-sell|st [options] <mint>                              Sell all the token by the mint from the accounts
  transfer|tr <amount> <receiver> <sender_index>            Transfer SOL from the specified keypair to the receiver
  spl-collect|sc [options] <mint> <receiver>                Collect all the token by the mint from the accounts to the provided address
  topup|t [options] <amount> <sender_index>                 Topup the accounts with SOL using the provided keypair
  metadata|m <json_path> <image_path>                       Upload the metadata of the token using the provided JSON file
  promote|pr [options] <count> <cid> <creator_index>        Create promotion tokens using the provided keypair
  create-token|ct [options] <cid> <creator_index>           Create a token
  clean|cl                                                  Clean the accounts
  drop|dr [options] <airdrop> <mint> <drop_index>           Do the drop
  clear-drop|cd <airdrop_file_path>                         Clear the drop
  benchmark [options] <requests>                            Benchmark the RPC node
  help [command]                                            display help for command
```
