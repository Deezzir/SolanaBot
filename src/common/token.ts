import { AccountInfo, Commitment, Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
    findAssociatedTokenPda,
    getCreateAssociatedTokenIdempotentInstruction,
    getBurnInstruction,
    getCloseAccountInstruction,
    getTransferInstruction,
    getSyncNativeInstruction,
    getTokenDecoder,
    getMintDecoder
} from '@solana-program/token';
import {
    TOKEN_2022_PROGRAM_ADDRESS,
    getMintDecoder as getMint2022Decoder,
    getTokenDecoder as getToken2022Decoder
} from '@solana-program/token-2022';

export const TOKEN_PROGRAM_ID = new PublicKey(TOKEN_PROGRAM_ADDRESS);
export const TOKEN_2022_PROGRAM_ID = new PublicKey(TOKEN_2022_PROGRAM_ADDRESS);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);

type TokenInstruction = {
    programAddress: string;
    accounts: readonly { address: string; role: number }[];
    data: ArrayLike<number>;
};

function instruction(input: TokenInstruction, signer?: PublicKey): TransactionInstruction {
    const authority = signer?.toBase58();
    return new TransactionInstruction({
        programId: new PublicKey(input.programAddress),
        keys: input.accounts.map((account) => ({
            pubkey: new PublicKey(account.address),
            isSigner: (account.role & 2) !== 0 || account.address === authority,
            isWritable: (account.role & 1) !== 0
        })),
        data: Uint8Array.from(input.data)
    });
}

export async function getAssociatedTokenAddress(
    mint: PublicKey,
    owner: PublicKey,
    program = TOKEN_PROGRAM_ID
): Promise<PublicKey> {
    const [address] = await findAssociatedTokenPda({
        mint: mint.toBase58(),
        owner: owner.toBase58(),
        tokenProgram: program.toBase58()
    });
    return new PublicKey(address);
}

export function createAssociatedTokenAccountIdempotentInstruction(
    payer: Keypair,
    ata: PublicKey,
    owner: PublicKey,
    mint: PublicKey,
    program = TOKEN_PROGRAM_ID
): TransactionInstruction {
    return instruction(
        getCreateAssociatedTokenIdempotentInstruction({
            payer,
            ata: ata.toBase58(),
            owner: owner.toBase58(),
            mint: mint.toBase58(),
            tokenProgram: program.toBase58()
        })
    );
}

export function createCloseAccountInstruction(
    account: PublicKey,
    destination: PublicKey,
    owner: PublicKey,
    program = TOKEN_PROGRAM_ID
): TransactionInstruction {
    return instruction(
        getCloseAccountInstruction(
            { account: account.toBase58(), destination: destination.toBase58(), owner: owner.toBase58() },
            { programAddress: program.toBase58() }
        ),
        owner
    );
}

export function createTransferInstruction(
    source: PublicKey,
    destination: PublicKey,
    owner: PublicKey,
    amount: bigint | number,
    program = TOKEN_PROGRAM_ID
): TransactionInstruction {
    return instruction(
        getTransferInstruction(
            { source: source.toBase58(), destination: destination.toBase58(), authority: owner.toBase58(), amount },
            { programAddress: program.toBase58() }
        ),
        owner
    );
}

export function createBurnInstruction(
    account: PublicKey,
    mint: PublicKey,
    owner: PublicKey,
    amount: bigint | number,
    program = TOKEN_PROGRAM_ID
): TransactionInstruction {
    return instruction(
        getBurnInstruction(
            { account: account.toBase58(), mint: mint.toBase58(), authority: owner.toBase58(), amount },
            { programAddress: program.toBase58() }
        ),
        owner
    );
}

export function createSyncNativeInstruction(account: PublicKey, program = TOKEN_PROGRAM_ID): TransactionInstruction {
    return instruction(
        getSyncNativeInstruction({ account: account.toBase58() }, { programAddress: program.toBase58() })
    );
}

export function decode_token_account(info: Pick<AccountInfo<Uint8Array>, 'data' | 'owner'>) {
    const { data, owner } = info;
    if (data.length < 165 || (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)))
        throw new Error('Invalid token account owner or length.');
    if (
        owner.equals(TOKEN_PROGRAM_ID)
            ? data.length !== 165
            : data.length > 165 && (data.length === 355 || data[165] !== 2)
    )
        throw new Error('Invalid token account type or length.');
    const decoded = owner.equals(TOKEN_2022_PROGRAM_ID)
        ? getToken2022Decoder().decode(data)
        : getTokenDecoder().decode(data);
    return { ...decoded, mint: new PublicKey(decoded.mint), owner: new PublicKey(decoded.owner) };
}

export function decode_mint_account(info: Pick<AccountInfo<Uint8Array>, 'data' | 'owner'>) {
    if (info.data.length < 82) throw new Error('Invalid mint account length.');
    if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        if (info.data.length !== 82 && (info.data.length < 166 || info.data.length === 355 || info.data[165] !== 1))
            throw new Error('Invalid Token-2022 mint type or length.');
        return getMint2022Decoder().decode(info.data);
    }
    if (!info.owner.equals(TOKEN_PROGRAM_ID) || info.data.length !== 82)
        throw new Error('Invalid mint program or length.');
    return { ...getMintDecoder().decode(info.data), extensions: { __option: 'None' as const } };
}

export async function getMint(
    connection: Connection,
    mint: PublicKey,
    commitment: Commitment = 'finalized',
    program?: PublicKey
): Promise<ReturnType<typeof decode_mint_account>> {
    const info = await connection.getAccountInfo(mint, commitment);
    if (!info || (program && !info.owner.equals(program))) throw new Error(`Invalid mint account: ${mint}`);
    return decode_mint_account(info);
}
