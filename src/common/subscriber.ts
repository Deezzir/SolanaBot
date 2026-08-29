import {
    Commitment,
    ParsedInstruction,
    ParsedTransactionWithMeta,
    PartiallyDecodedInstruction,
    PublicKey
} from '@solana/web3.js';
import * as common from './common';
import { WS_URL } from '../constants';

export enum SubscriberType {
    Logs = 'logs',
    Tx = 'tx'
}

export interface Subscriber {
    type: SubscriberType;
    subscribe(on_logs: (data: any) => void): Promise<void>;
    unsubscribe(): Promise<void>;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number;
    result: number | boolean;
}

type StringPublicKeys<T> = T extends PublicKey
    ? string
    : T extends Array<infer U>
      ? Array<StringPublicKeys<U>>
      : T extends object
        ? { [K in keyof T]: StringPublicKeys<T[K]> }
        : T;

type RawParsedTransaction = StringPublicKeys<ParsedTransactionWithMeta>;
type RawInstruction = RawParsedTransaction['transaction']['message']['instructions'][number];

interface TransactionSubscribeResult {
    signature: string;
    slot: number;
    transactionIndex?: number;
    transaction: {
        transaction: RawParsedTransaction['transaction'];
        meta: RawParsedTransaction['meta'];
    };
}

interface TransactionSubscribeNotification {
    jsonrpc: '2.0';
    method: 'transactionNotification';
    params: {
        result: TransactionSubscribeResult;
        subscription: number;
    };
}

export type TransactionSubscribeMessage = JsonRpcResponse | TransactionSubscribeNotification;

function deserialize_instruction(instruction: RawInstruction): ParsedInstruction | PartiallyDecodedInstruction {
    if ('accounts' in instruction) {
        return {
            ...instruction,
            programId: new PublicKey(instruction.programId),
            accounts: instruction.accounts.map((account) => new PublicKey(account))
        };
    }
    return { ...instruction, programId: new PublicKey(instruction.programId) };
}

export function deserialize_transaction_notification(
    message: TransactionSubscribeMessage
): ParsedTransactionWithMeta | null {
    if (!('method' in message) || message.method !== 'transactionNotification') return null;

    const result = message.params.result;
    const transaction = result.transaction.transaction;
    const meta = result.transaction.meta;

    return {
        slot: result.slot,
        transaction: {
            signatures: transaction.signatures,
            message: {
                ...transaction.message,
                accountKeys: transaction.message.accountKeys.map((account) => ({
                    ...account,
                    pubkey: new PublicKey(account.pubkey)
                })),
                instructions: transaction.message.instructions.map(deserialize_instruction),
                addressTableLookups: transaction.message.addressTableLookups?.map((lookup) => ({
                    ...lookup,
                    accountKey: new PublicKey(lookup.accountKey)
                }))
            }
        },
        meta: meta
            ? {
                  ...meta,
                  innerInstructions: meta.innerInstructions?.map((group) => ({
                      ...group,
                      instructions: group.instructions.map(deserialize_instruction)
                  })),
                  loadedAddresses: meta.loadedAddresses
                      ? {
                            writable: meta.loadedAddresses.writable.map((address) => new PublicKey(address)),
                            readonly: meta.loadedAddresses.readonly.map((address) => new PublicKey(address))
                        }
                      : undefined
              }
            : null
    };
}

export class LogsSubscriber implements Subscriber {
    type: SubscriberType = SubscriberType.Logs;
    private sub_id: number | null = null;
    private commitment: Commitment;
    private address: PublicKey;

    constructor(address: PublicKey, commitment: Commitment) {
        this.address = address;
        this.commitment = commitment;
    }

    async subscribe(on_logs: (logs: string[], signature?: string) => void): Promise<void> {
        this.sub_id = global.CONNECTION.onLogs(
            this.address,
            async ({ err, logs, signature }) => {
                if (err) return;
                if (logs) on_logs(logs, signature);
            },
            this.commitment
        );
        if (this.sub_id === undefined) throw new Error('Failed to subscribe to logs');
    }

    async unsubscribe(): Promise<void> {
        if (this.sub_id !== null) {
            global.CONNECTION.removeOnLogsListener(this.sub_id)
                .then(() => (this.sub_id = null))
                .catch((err) => common.error(common.red(`Failed to unsubscribe from onLogs: ${err}`)));
        }
    }
}

export class TxSubscriber implements Subscriber {
    type: SubscriberType = SubscriberType.Tx;
    private commitment: Commitment;
    private address: PublicKey;
    private ws: WebSocket | null = null;
    private ping_interval: NodeJS.Timeout | null = null;
    private ping_interval_ms: number = 30000;
    private reconnecting: boolean = false;
    private reconnect_attempts: number = 0;
    private subscription_id: number | null = null;
    private stopped: boolean = true;

    static readonly PingID = 421;
    static readonly SubscribeID = 420;
    static readonly SubscribeMethod = 'transactionSubscribe';

    constructor(address: PublicKey, commitment: Commitment) {
        this.address = address;
        this.commitment = commitment;
        this.ws = null;
    }

    private start_ping() {
        this.ping_interval = setInterval(() => {
            if (this.ws && this.ws.readyState !== WebSocket.OPEN) return;
            if (!this.ws) return;

            this.ws.send(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: TxSubscriber.PingID,
                    method: 'ping'
                })
            );
        }, this.ping_interval_ms);
    }

    private reconnect(on_logs: (message: TransactionSubscribeMessage) => void) {
        if (this.stopped || this.reconnecting) return;
        this.reconnecting = true;

        if (this.ping_interval) {
            clearInterval(this.ping_interval);
            this.ping_interval = null;
        }

        if (this.ws) {
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.close();
            this.ws = null;
        }

        const delay = common.compute_backoff_delay(this.reconnect_attempts, {
            initial_delay_ms: 1000,
            backoff_multiplier: 2,
            max_delay_ms: 30000
        });
        this.reconnect_attempts++;
        setTimeout(() => {
            if (this.stopped) return;
            this.reconnecting = false;
            this.subscribe(on_logs).catch((err) =>
                common.error(common.red(`Failed to reconnect to WebSocket: ${err}`))
            );
        }, delay);
    }

    private prepare_request(
        encoding: 'jsonParsed' | 'base64' = 'jsonParsed',
        show_rewards: boolean = false,
        details: 'full' | 'signatures' = 'full'
    ) {
        return {
            jsonrpc: '2.0',
            id: TxSubscriber.SubscribeID,
            method: TxSubscriber.SubscribeMethod,
            params: [
                {
                    accountInclude: [this.address.toBase58()]
                },
                {
                    commitment: String(this.commitment),
                    encoding: encoding,
                    transactionDetails: details,
                    showRewards: show_rewards,
                    maxSupportedTransactionVersion: 0
                }
            ]
        };
    }

    async subscribe(on_logs: (message: TransactionSubscribeMessage) => void): Promise<void> {
        this.stopped = false;
        this.subscription_id = null;
        this.ws = new WebSocket(WS_URL);

        this.ws.onopen = () => {
            this.start_ping();
            const request = this.prepare_request();
            this.ws!.send(JSON.stringify(request));
        };

        this.ws.onmessage = (event: MessageEvent) => {
            const raw = typeof event.data === 'string' ? event.data : event.data.toString();
            try {
                const message: TransactionSubscribeMessage = JSON.parse(raw);
                if ('id' in message && message.id === TxSubscriber.PingID) return;
                if ('id' in message && message.id === TxSubscriber.SubscribeID) {
                    if (typeof message.result !== 'number')
                        throw new Error('Invalid transaction subscription response.');
                    this.subscription_id = message.result;
                    this.reconnect_attempts = 0;
                    return;
                }
                if (!('method' in message) || message.params.subscription !== this.subscription_id) return;
                on_logs(message);
            } catch (e) {
                common.error(common.red(`Failed to parse WebSocket message: ${raw}`));
                return;
            }
        };

        this.ws.onerror = (event: Event) => {
            if (event instanceof ErrorEvent) {
                common.error(common.red(`WebSocket error: ${event.message}`));
            } else {
                common.error(common.red(`WebSocket error: ${event.type}`));
            }
            if (!this.stopped && this.ws && this.ws.readyState !== WebSocket.OPEN) this.reconnect(on_logs);
        };

        this.ws.onclose = (event: CloseEvent) => {
            if (this.stopped) return;
            const reason = event.reason || 'unknown';
            common.warn(`WebSocket closed. Code: ${event.code}, Reason: ${reason}. Attempting to reconnect...`);
            if (this.ping_interval) clearInterval(this.ping_interval);
            this.reconnect(on_logs);
        };
    }

    async unsubscribe(): Promise<void> {
        this.stopped = true;
        this.subscription_id = null;
        if (this.ping_interval) clearInterval(this.ping_interval);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
        this.ws = null;
        this.reconnecting = false;
        this.reconnect_attempts = 0;
    }
}
