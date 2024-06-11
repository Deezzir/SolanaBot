import { ComputeBudgetProgram, Connection, TransactionInstruction } from "@solana/web3.js";
import { Priority } from "./common.js";

interface RequestPayload {
    method: string;
    params: {
        last_n_blocks: number;
        account: string;
    };
    id: number;
    jsonrpc: string;
}

interface FeeEstimates {
    extreme: number;
    high: number;
    low: number;
    medium: number;
    percentiles: {
        [key: string]: number;
    };
}

interface ResponseData {
    jsonrpc: string;
    result: {
        context: {
            slot: number;
        };
        per_compute_unit: FeeEstimates;
        per_transaction: FeeEstimates;
    };
    id: number;
}

interface EstimatePriorityFeesParams {
    last_n_blocks?: number;
    account?: string;
    endpoint: string;
}

async function fetch_priority_fees({
    last_n_blocks,
    account,
    endpoint
}: EstimatePriorityFeesParams): Promise<ResponseData> {
    const params: any = {};
    if (last_n_blocks !== undefined) {
        params.last_n_blocks = last_n_blocks;
    }
    if (account !== undefined) {
        params.account = account;
    }

    const payload: RequestPayload = {
        method: 'qn_estimatePriorityFees',
        params,
        id: 1,
        jsonrpc: '2.0',
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data: ResponseData = await response.json();
    return data;
}

export async function create_priority_fee_instruction(endpoint: string, priority: Priority, account?: string): Promise<TransactionInstruction> {
    const params: EstimatePriorityFeesParams = {
        last_n_blocks: 100,
        account: account || 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
        endpoint: endpoint
    };

    const { result } = await fetch_priority_fees(params);
    let priority_fee = result.per_compute_unit.low;

    switch (priority) {
        case 'low':
            priority_fee = result.per_compute_unit.low;
            break;
        case 'medium':
            priority_fee = result.per_compute_unit.medium;
            break;
        case 'high':
            priority_fee = result.per_compute_unit.high;
            break;
        case 'extreme':
            priority_fee = result.per_compute_unit.extreme;
            break;
    }

    const priority_fee_instruction = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority_fee });
    return priority_fee_instruction;
}