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
    fund|f [options] <amount> <sender_index>                   Fund the wallets with SOL using the provided wallet
    create-metadata|cm <json_path> <image_path>                 Upload the metadata of the token using the provided JSON file and image
    promote|pr [options] <count> <cid> <creator_index>          Create promotion tokens using the provided wallet
    create-token|ct [options] <cid> <creator_index>             Create a token
    clean|cl                                                    Clean the wallets
    drop|dr [options] <mint> <drop_index>                       Do the drop
    benchmark|bh [options] <requests>                           Benchmark the RPC connection
    help [command]                                              display help for command
    ```

> ⚠️ Help is available for each command. Use `node dist/bot.js <command> -h` to see the options for that command.

## Snipe Config (JSON)

The `snipe` subcommand optionally accepts a JSON config with the following fields:

### Required fields

- `thread_cnt` (`number`) – Number of threads (≤ `keys_cnt`)
- `spend_limit` (`number`) – Max total spend (> `SNIPE_MIN_MCAP`)
- `start_buy` (`number`) – Initial buy amount (> `SNIPE_MIN_BUY`, < `spend_limit`)
- Token must be identified via:
  - `mint` (`string`, valid pubkey) **OR**
  - `token_name` (`string`) **AND** `token_ticker` (`string`)

> ⚠️ `mint` and `token_name/token_ticker` are **mutually exclusive**

### Optional fields

| Field            | Type      | Default                  | Notes |
|------------------|-----------|---------------------------|-------|
| `buy_interval`    | `number`  | `0`                       | Required if `is_buy_once = false` |
| `mcap_threshold`  | `number`  | `Infinity`                | Must be ≥ `SNIPE_MIN_MCAP` |
| `start_interval`  | `number`  | `0`                       | Must be ≥ 0 |
| `is_buy_once`     | `boolean` | `false`                   | If `true`, `buy_interval` must not be set |
| `sell_slippage`   | `number`  | `SNIPE_SELL_SLIPPAGE`     | 0.0 – `TRADE_MAX_SLIPPAGE` |
| `buy_slippage`    | `number`  | `SNIPE_BUY_SLIPPAGE`      | 0.0 – `TRADE_MAX_SLIPPAGE` |
| `priority_level`  | `string`  | `Default`                 | See **Priority Levels** below |
| `protection_tip`  | `number`  | `undefined`               | Must be ≥ 0.0 |

---

### Priority Levels

```ts
export enum PriorityLevel {
  MIN = 'Min',
  LOW = 'Low',
  MEDIUM = 'Medium',
  HIGH = 'High',
  VERY_HIGH = 'VeryHigh',
  UNSAFE_MAX = 'UnsafeMax',
  DEFAULT = 'Default'
}
```

Set `priority_level` to control transaction fees.

---

### Example Config

```json
{
  "thread_cnt": 3,
  "spend_limit": 100,
  "start_buy": 10,
  "mint": "So11111111111111111111111111111111111111112",
  "is_buy_once": false,
  "buy_interval": 5,
  "priority_level": "MEDIUM"
}
```

## Token Metadata Config (JSON)

The `create-metadata` subcommand accepts a JSON config with the following fields:

```json
{
    "name": "string",
    "symbol": "string",
    "description": "string",
    "image": "string | undefined",
    "showName": "boolean | undefined",
    "createdOn": "string | undefined",
    "twitter": "string | undefined",
    "telegram": "string | undefined",
    "website": "string | undefined",
}
```

### Required fields

- `name` (`string`) – Name of the token
- `symbol` (`string`) – Symbol of the token
- `description` (`string`) – Description of the token

> ⚠️ `image` is optional, because it will be uploaded separately using the `create-metadata` command and populated in the metadata JSON file uploaded to IPFS, check the `image_path` argument in the command.
