declare module '@compto/comptoken-js-offchain' {
    export function getValidBlockhashes(connection: Connection): Promise<ValidBlockhashes>;
    export function createProofSubmissionInstruction(
        comptoken_proof: ComptokenProof,
        user_wallet_address: PublicKey,
        user_comptoken_token_account_address: PublicKey
    ): Promise<TransactionInstruction>;
  }