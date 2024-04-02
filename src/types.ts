import { Keypair } from '@solana/web3.js';

interface BotConfig {
    thread_cnt: number;
    buy_interval: number;
    spend_limit: number;
    return_pubkey: string;
    mcap_threshold: number;
    token_name: string;
    token_ticker: string;
}

interface WorkerConfig {
    secret: Uint8Array;
    id: number;
    config: BotConfig;
}

export { BotConfig, WorkerConfig };