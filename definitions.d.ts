declare module '@compto/comptoken-js-offchain' {
    export function getValidBlockhashes(connection: Connection): Promise<ValidBlockhashes>;
    export function createProofSubmissionInstruction(
        comptoken_proof: ComptokenProof,
        user_wallet_address: PublicKey,
        user_comptoken_token_account_address: PublicKey
    ): Promise<TransactionInstruction>;
    export declare class ComptokenProof {
        pubkey: Buffer;
        recentBlockHash: Buffer;
        extraData: Buffer;
        nonce: Buffer;
        version: Buffer;
        timestamp: Buffer;
        hash: Buffer;
        static MIN_NUM_ZEROED_BITS: number;
        constructor(
            pubkey: Buffer,
            recentBlockHash: Buffer,
            extraData: Buffer,
            nonce: Buffer,
            version: Buffer,
            timestamp: Buffer,
        );
        generateHash(): Buffer;
        static leadingZeroes(hash: Buffer): number;
        serializeData(): Buffer;
    }
    export const comptoken_mint_pubkey: PublicKey;
    export const test_account: Keypair;
  }