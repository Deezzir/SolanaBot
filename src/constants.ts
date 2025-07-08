import dotenv from 'dotenv';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
dotenv.config({ path: './.env' });

function get_env_variable(var_name: string, default_value: string = ''): any {
    const variable = process.env[var_name] || default_value;
    if (!variable) {
        console.error(`${var_name} is not set`);
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
export const COMMANDS_DELAY_MS = 100;

// WALLET CONSTANTS
export const WALLETS_FILE = 'keys.csv';
export const WALLETS_RESCUE_DIR_PATH = '.rescue';
export const WALLETS_FILE_HEADERS = ['name', 'private_key', 'is_reserve', 'public_key', 'created_at'];

// IPFS CONSTANTS
export const IPFS = 'https://ipfs.io/ipfs/';
export const IPFS_API = 'https://uploads.pinata.cloud/v3/files';
export const IPFS_JWT = get_env_variable('PINATA_IPFS_JWT');

// TRADE COMMON CONSTANTS
export const TRADE_RAYDIUM_SWAP_TAX = 0.0025; // 0.25%
export const TRADE_TX_RETRIES = 0;
export const TRADE_RETRIES = 5;
export const TRADE_RETRY_INTERVAL_MS = 1000;
export const TRADE_MAX_SLIPPAGE = 5.0;
export const TRADE_DEFAULT_CURVE_DECIMALS = 6;
export const TRADE_SWAP_SEED = 'swap';
export const TRADE_MAX_WALLETS_PER_CREATE_BUNDLE = 20;
export const TRADE_MAX_WALLETS_PER_CREATE_TX = 5;
export const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
export const RENT_PROGRAM_ID = new PublicKey('SysvarRent111111111111111111111111111111111');
export const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const JUPITER_API_URL = 'https://quote-api.jup.ag/v6/';
export const JITO_MIN_TIP = 1000 / LAMPORTS_PER_SOL;
export const JITO_BUNDLE_SIZE = 5;
export const JITO_BUNDLE_INTERVAL_MS = 1000;
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

// TRADE DEX CONSTANTS
export const RAYDIUM_AUTHORITY = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
export const RAYDIUM_AMM_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

// MOON CONSTANTS
export const MOONSHOT_TRADE_PROGRAM_ID = new PublicKey('MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG');

// METEORA CONSTANTS
export const METEORA_DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
export const METEORA_DAMM_V1_PROGRAM_ID = new PublicKey('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB');
export const METEORA_DAMM_V2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
export const METEORA_VAULT_PROGRAM_ID = new PublicKey('24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi');
export const METEORA_DBC_POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM');
export const METEORA_DBC_EVENT_AUTHORITY = new PublicKey('8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF');
export const METEORA_LTA_ACCOUNT = new PublicKey('F1geeThcTKPq5nJDpJ9Eh7gk7t4k22PKpcGjbzzPJD14');
export const METEORA_LTA_ACCOUNT_EXTRA = new PublicKey('6WgD151HNpmFfv5Hzf2NsPTVNoSC1JjeMoJ8sEFtpDKh');
export const METEORA_DAMM_V1_STATE_HEADER = new Uint8Array([241, 154, 109, 4, 17, 177, 109, 188]);
export const METEORA_DAMM_V2_STATE_HEADER = new Uint8Array([241, 154, 109, 4, 17, 177, 109, 188]);
export const METEORA_DBC_VAULT_SEED = new Uint8Array([116, 111, 107, 101, 110, 95, 118, 97, 117, 108, 116]);
export const METEORA_DBC_STATE_HEADER = new Uint8Array([213, 224, 5, 209, 98, 69, 119, 92]);
export const METEORA_CONFIG_HEADER = new Uint8Array([26, 108, 14, 123, 116, 230, 129, 43]);
export const METEORA_VAULT_HEADER = new Uint8Array([211, 8, 232, 43, 2, 152, 117, 119]);
export const METEORA_SWAP_DISCRIMINATOR = new Uint8Array([248, 198, 158, 145, 225, 117, 135, 200]);

// PUMP CONSTANTS
export const PUMP_FETCH_API_URL = 'https://frontend-api-v3.pump.fun';
export const PUMP_IPFS_API_URL = 'https://frontend-api-v3.pump.fun/ipfs/token-metadata';
export const PUMP_CURVE_TOKEN_DECIMALS = 6;
export const PUMP_FEE_PERCENTAGE = 0.01; // 1%
export const PUMP_SWAP_PERCENTAGE = 0.0025; // 0.25%
export const PUMP_LTA_ACCOUNT_EXTRA = new PublicKey('FNbKyKh4LjC1kSmhMahZ2gJPwt1anynVUdaCNmmuxzac');
export const PUMP_LTA_ACCOUNT = new PublicKey('J5edBug5X1G1PoUgtnBjNUpcrhpeJiRKy7TWqs5Yvuk3');
export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_GLOBAL_ACCOUNT = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
export const PUMP_FEE_ACCOUNT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
export const PUMP_EVENT_AUTHORITUY_ACCOUNT = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
export const PUMP_MINT_AUTHORITY_ACCOUNT = new PublicKey('TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM');
export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const PUMP_AMM_GLOBAL_ACCOUNT = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
export const PUMP_AMM_EVENT_AUTHORITY_ACCOUNT = new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
export const PUMP_AMM_FEE_ACCOUNT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
export const PUMP_AMM_FEE_TOKEN_ACCOUNT = new PublicKey('94qWNrtmfn42h3ZjUZwWvK1MEo9uVmmrBPd2hpNjYDjb');
export const PUMP_STATE_HEADER = new Uint8Array([0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60]);
export const PUMP_AMM_STATE_HEADER = new Uint8Array([241, 154, 109, 4, 17, 177, 109, 188]);
export const PUMP_BONDING_SEED = new Uint8Array([98, 111, 110, 100, 105, 110, 103, 45, 99, 117, 114, 118, 101]);
export const PUMP_META_SEED = new Uint8Array([109, 101, 116, 97, 100, 97, 116, 97]);
export const PUMP_CREATOR_VAULT_SEED = new Uint8Array([99, 114, 101, 97, 116, 111, 114, 45, 118, 97, 117, 108, 116]);
export const PUMP_AMM_CREATOR_VAULT_SEED = new Uint8Array([
    99, 114, 101, 97, 116, 111, 114, 95, 118, 97, 117, 108, 116
]);
export const PUMP_BUY_DISCRIMINATOR = new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234]);
export const PUMP_SELL_DISCRIMINATOR = new Uint8Array([51, 230, 133, 164, 1, 127, 131, 173]);
export const PUMP_CREATE_DISCRIMINATOR = new Uint8Array([24, 30, 200, 40, 5, 28, 7, 119]);
export const PUMP_EXTEND_DISCRIMINATOR = new Uint8Array([234, 102, 194, 203, 150, 72, 62, 229]);

// SNIPE CONSTANTS
export const SNIPE_BUY_SLIPPAGE = 0.85;
export const SNIPE_SELL_SLIPPAGE = 0.5;
export const SNIPE_MIN_BUY_THRESHOLD = 0.00001;
export const SNIPE_MIN_BUY = 0.005;
export const SNIPE_TRADE_BATCH = 1;
export const SNIPE_META_UPDATE_INTERVAL_MS = 300;
export const SNIPE_MIN_MCAP = 5000;
export const SNIPE_RETRIES = 5;
export const SNIPE_RETRY_INTERVAL_MS = 500;

// TRANSFER CONSTANTS
export const TRANSFER_INTERVAL_MS: number = 1000;
export const TRANSFER_MAX_DEPTH: number = 23;
export const TRANSFER_MAX_WALLETS_PER_TX: number = 7;

// DROP CONSTANTS
export const DROP_RECORDS_PER_ITERATION = 10;
export const DROP_AIRDROP_CSV = 'airdropusers.csv';
export const DROP_PRESALE_CSV = 'presaleusers.csv';

// VOLUME CONSTANTS
export const VOLUME_MAX_WALLETS_PER_EXEC = 20;
export const VOLUME_TRADE_SLIPPAGE = 0.9;
export const VOLUME_MAX_WALLETS_PER_TRADE_BUNDLE = 10;
export const VOLUME_MAX_WALLETS_PER_TRADE_TX = 2;
export const VOLUME_MAX_WALLETS_PER_COLLECT_TX = 10;
export const VOLUME_MAX_WALLETS_PER_FUND_TX = 20;

// WALLET PNL CONSTANTS
export const PNL_BATCH_SIZE = 50;
export const PNL_BATCH_DELAY_MS = 0;
