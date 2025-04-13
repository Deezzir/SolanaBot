import dotenv from 'dotenv';
import * as common from './common/common.js';
import { PublicKey } from '@solana/web3.js';
dotenv.config({ path: './.env' });

function get_env_variable(var_name: string, default_value: string = ''): any {
    const variable = process.env[var_name] || default_value;
    if (!variable) {
        common.error(common.red(`${var_name} is not set`));
        process.exit(1);
    }
    return variable;
}

// NETWORK CONSTANTS
export const HELIUS_API_KEY = get_env_variable('HELIUS_API_KEY');
export const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
export const COMMITMENT = 'confirmed';

// COMMANDS CONSTANTS
export const COMMANDS_INTERVAL_MS = 50;
export const COMMANDS_SELL_SLIPPAGE = 0.1;
export const COMMANDS_BUY_SLIPPAGE = 0.05;
export const COMMANDS_MAX_RETRIES = 5;
export const COMMANDS_DELAY_MS = 100;

// WALLET CONSTANTS
export const WALLETS_FILE = 'keys.csv';
export const WALLETS_FILE_HEADERS = ['name', 'private_key', 'is_reserve', 'public_key', 'created_at'];

// IPFS CONSTANTS
export const IPFS = 'https://ipfs.io/ipfs/';
export const IPFS_API = 'https://uploads.pinata.cloud/v3/files';
export const IPFS_JWT = get_env_variable('PINATA_IPFS_JWT');

// TRADE COMMON CONSTANTS
export const TRADE_MAX_RETRIES = 0;
export const TRADE_RETRY_INTERVAL_MS = 1000;
export const TRADE_MAX_SLIPPAGE = 5.0;
export const TRADE_DEFAULT_CURVE_DECIMALS = 6;
export const TRADE_SWAP_SEED = 'swap';
export const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
export const RENT_PROGRAM_ID = new PublicKey('SysvarRent111111111111111111111111111111111');
export const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const JUPITER_API_URL = 'https://quote-api.jup.ag/v6/';
export const RAYDIUM_AUTHORITY = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
export const RAYDIUM_AMM_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
export const JITO_BUNDLE_SIZE = 5;
export const JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'
];
export const JITO_ENDPOINTS = [
    'https://mainnet.block-engine.jito.wtf/api/v1',
    'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1',
    'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1',
    'https://ny.mainnet.block-engine.jito.wtf/api/v1',
    'https://tokyo.mainnet.block-engine.jito.wtf/api/v1'
];
export enum PriorityLevel {
    MIN = 'Min',
    LOW = 'Low',
    MEDIUM = 'Medium',
    HIGH = 'High',
    VERY_HIGH = 'VeryHigh',
    UNSAFE_MAX = 'UnsafeMax',
    DEFAULT = 'Default'
}

// MOON CONSTANTS
export const MOONSHOT_TRADE_PROGRAM_ID = new PublicKey('MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG');

// PUMP CONSTANTS
export const PUMP_FETCH_API_URL = 'https://frontend-api-v3.pump.fun';
export const PUMP_CURVE_TOKEN_DECIMALS = 6;
export const PUMP_FEE_PERCENTAGE = 0.01;
export const PUMP_SWAP_PERCENTAGE = 0.0025;
export const PUMP_BONDING_ADDR = new Uint8Array([98, 111, 110, 100, 105, 110, 103, 45, 99, 117, 114, 118, 101]);
export const PUMP_META_ADDR = new Uint8Array([109, 101, 116, 97, 100, 97, 116, 97]);
export const PUMP_TRADE_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_CURVE_STATE_SIGNATURE = Uint8Array.from([0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60]);
export const PUMP_GLOBAL_ACCOUNT = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
export const PUMP_FEE_ACCOUNT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
export const PUMP_EVENT_AUTHORITUY_ACCOUNT = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
export const PUMP_MINT_AUTHORITY_ACCOUNT = new PublicKey('TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM');
export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const PUMP_AMM_GLOBAL_ACCOUNT = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
export const PUMP_AMM_EVENT_AUTHORITY_ACCOUNT = new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
export const PUMP_AMM_FEE_ACCOUNT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
export const PUMP_AMM_FEE_TOKEN_ACCOUNT = new PublicKey('94qWNrtmfn42h3ZjUZwWvK1MEo9uVmmrBPd2hpNjYDjb');
export const PUMP_BUY_DISCRIMINATOR: Uint8Array = new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234]);
export const PUMP_SELL_DISCRIMINATOR: Uint8Array = new Uint8Array([51, 230, 133, 164, 1, 127, 131, 173]);
export const PUMP_CREATE_DISCRIMINATOR: Uint8Array = new Uint8Array([24, 30, 200, 40, 5, 28, 7, 119]);

// SNIPE CONSTANTS
export const SNIPE_BUY_SLIPPAGE = 0.85;
export const SNIPE_SELL_SLIPPAGE = 0.5;
export const SNIPE_MIN_BUY_THRESHOLD = 0.00001;
export const SNIPE_MIN_BUY = 0.005;
export const SNIPE_ITERATIONS = 1;
export const SNIPE_META_UPDATE_INTERVAL_MS = 300;

// SPIDER CONSTANTS
export const SPIDER_RESCUE_DIR_PATH: string = process.env.PROCESS_DIR_PATH || '.rescue';
export const SPIDER_EXTRA_SOL: number = 0.005;
export const SPIDER_INTERVAL_MS: number = 1000;

// DROP CONSTANTS
export const DROP_MONGO_URI = get_env_variable('MONGO_URI', 'mongodb://localhost:27017');
export const DROP_MONGO_DB_NAME = get_env_variable('MONGO_DB_NAME', 'test');
export const DROP_RECORDS_PER_ITERATION = 10;
export const DROP_AIRDROP_COLLECTION = 'airdropusers';
export const DROP_PRESALE_COLLECTION = 'presaleusers';

// VOLUME CONSTANTS
export const VOLUME_RAYDIUM_SWAP_TAX = 0.0025; // 0.25%

// WALLET PNL CONSTANTS
export const PNL_BATCH_SIZE = 50;
export const PNL_BATCH_DELAY_MS = 0;
