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
ACCOUNT_0=
ACCOUNT_1=
ACCOUNT_2=
ACCOUNT_3=
KEYS_DIR=./keys
JITOTIP=
FETCH_MINT_API_URL=
LIQUIDITY_FILE=
BLOCK_URL=
IPFS_API_KEY=
MONGO_URI=
```

5. Build the project

```bash
npm run build
```

6. Run the project

```bash
node dist/bot.js -h
```
