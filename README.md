# Solana Buy Bot

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
TRADE_PROGRAM_ID=
GLOBAL_ACCOUNT=
FEE_RECIPIENT_ACCOUNT=
EVENT_AUTHORITUY_ACCOUNT=
MINT_AUTHORITY_ACCOUNT=
KEYS_DIR=./keys
FETCH_MINT_API_URL=
IPFS_API_KEY=
MONGO_URI=
MONGO_DB_NAME=
```

5. Build the project

```bash
npm run build
```

6. Run the project

```bash
node dist/bot.js -h

Usage: bot [options] [command]

Solana Buy Bot CLI

Options:
  -V, --version                                     output the version number
  -h, --help                                        display help for command

Commands:
  start|s [options]                                 Start the bot
  balance|b                                         Get the balance of the accounts
  spl-balance|sb <mint>                             Get the total balance of a token of the accounts
  warmup|w [options]                                Warmup the accounts with the tokens
  collect|c [options] <receiver>                    Collect all the SOL from the accounts to the provided address
  spl-buy-once|bto <amount> <mint> <buyer_path>     Buy the token once with the provided amount
  spl-sell-once|sto [options] <mint> <seller_path>  Sell the token once with the provided amount
  spl-buy|bt [options] <amount> <mint>              Buy the token by the mint from the accounts
  spl-sell|st [options] <mint>                      Sell all the token by the mint from the accounts
  transfer|tr <amount> <receiver> <sender_path>     Transfer SOL from the specified keypair to the receiver
  spl-collect|sc [options] <mint> <receiver>        Collect all the token by the mint from the accounts to the provided address
  topup|t [options] <amount> <sender_path>          Topup the accounts with SOL using the provided keypair
  metadata|m <json_path> <image_path>               Upload the metadata of the token using the provided JSON file
  promote|pr <count> <cid> <creator_path>           Create promotion tokens using the provided keypair
  create-token|ct [options] <cid> <creator_path>    Create a token
  clean|cl                                          Clean the accounts
  drop|dr [options] <airdrop> <mint> <drop_path>    Do the drop
  clear-drop|cd <airdrop_file_path>                 Clear the drop
  help [command]                                    display help for command
```
