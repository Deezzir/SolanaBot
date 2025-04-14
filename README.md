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
HELIUS_API_KEY=
```

5. Build the project

```bash
npm run build
```

6. Run the project

```bash
> node dist/bot.js -h

Usage: bot [options] [command]

Solana Bot CLI

Options:
  -V, --version                                               output the version number
  -k, --keys <path>                                           Path to the CSV file with the wallets (default: keys.csv)
  -h, --help                                                  display help for command

Commands:
  snipe|sn [options]                                          Start the snipe bot
  volume|v [options]                                          Generate the volume for a token
  generate|g [options] <count> <name>                         Generate the wallets. Optionally, a file with secret keys (separated by newline) can be provided to convert them to keypairs.
  balance|b                                                   Get the balance of the wallets
  wallet-pnl|pnl <address>                                    Get the PNL of the wallet
  token-balance|tb <mint>                                     Get the total balance of a token of the wallets
  warmup|w [options]                                          Warmup the wallets with the tokens
  collect|c [options] <receiver>                              Collect all the SOL from the wallets to the provided address
  buy-token-once|bto [options] <amount> <mint> <buyer_index>  Buy the token once with the provided amount
  sell-token-once|sto [options] <mint> <seller_index>         Sell the token once with the provided amount
  buy-token|bt [options] <mint>                               Buy the token by the mint from the wallets
  sell-token|st [options] <mint>                              Sell all the token by the mint from the wallets
  transfer|tr <amount> <receiver> <sender_index>              Transfer SOL from the specified keypair to the receiver
  token-collect|tc [options] <mint> <receiver>                Collect all the token by the mint from the wallets to the provided address
  topup|t [options] <amount> <sender_index>                   Topup the wallets with SOL using the provided wallet
  create-metadata|cm <json_path> <image_path>                 Upload the metadata of the token using the provided JSON file and image
  promote|pr [options] <count> <cid> <creator_index>          Create promotion tokens using the provided wallet
  create-token|ct [options] <cid> <creator_index>             Create a token
  clean|cl                                                    Clean the wallets
  drop|dr [options] <mint> <drop_index>                       Do the drop
  benchmark|bh [options] <requests>                           Benchmark the RPC node
  help [command]                                              display help for command
```
