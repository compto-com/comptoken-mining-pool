import { Injectable, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import { BehaviorSubject, filter, shareReplay } from 'rxjs';

import { IComptoBlockTemplate } from '../models/compto-rpc/ComptoBlockTemplate';

import {
    addresses,
    type ComptokenProgram,
    ComptokenProof,
    createComptokenProgram,
    getDefaultComptokenIdl,
    transactions,
} from '@compto/comptoken.js';
import { AnchorError, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { ConfigService } from '@nestjs/config';
import {
    createTransferCheckedWithTransferHookInstruction,
    TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
    clusterApiUrl,
    Connection,
    Keypair,
    type PublicKey,
    sendAndConfirmTransaction,
    Transaction,
} from '@solana/web3.js';
import { assert, hasValue } from '../utils';

@Injectable()
export class ComptoRpcService implements OnModuleInit {
    private compto_keypair: Keypair;
    private solana_cluster!: string; // assigned in onModuleInit
    private connection!: Connection; // assigned in onModuleInit
    private comptoken_program!: ComptokenProgram; // assigned in onModuleInit

    private blockHash: Buffer | undefined;
    private _newBlock$: BehaviorSubject<Buffer> = new BehaviorSubject<Buffer>(
        Buffer.alloc(0), // Initial value, will be replaced on first poll
    );
    public newBlock$ = this._newBlock$.pipe(
        filter((block) => hasValue(block)),
        shareReplay({ refCount: true, bufferSize: 1 }),
    );

    constructor(private readonly configService: ConfigService) {
        const solana_user_raw = this.configService.get('SOLANA_USER');
        const solana_user = Buffer.from(
            JSON.parse(
                solana_user_raw == ''
                    ? fs.readFileSync(
                          this.configService.getOrThrow('SOLANA_USER_PATH'),
                          'utf-8',
                      )
                    : solana_user_raw,
            ),
        );

        this.compto_keypair = Keypair.fromSecretKey(solana_user);
    }

    async onModuleInit() {
        const solana_cluster = this.configService.get('SOLANA_CLUSTER');
        assert(
            hasValue(solana_cluster),
            'SOLANA_CLUSTER must be set in the config',
        );
        this.solana_cluster = solana_cluster;
        const commitment = this.configService.get('SOLANA_COMMITMENT');

        switch (this.solana_cluster) {
            case 'mainnet-beta':
            case 'testnet':
            case 'devnet':
                this.connection = new Connection(
                    clusterApiUrl(this.solana_cluster),
                    commitment,
                );
                break;
            case 'local':
                this.connection = new Connection(
                    'http://localhost:8899',
                    commitment,
                ); // default test-validator port
                break;
            default:
                // assume custom cluster URL
                this.connection = new Connection(
                    this.solana_cluster,
                    commitment,
                );
                break;
        }

        this.comptoken_program = createComptokenProgram(
            getDefaultComptokenIdl(),
            new AnchorProvider(
                this.connection,
                new Wallet(this.compto_keypair),
                {
                    commitment: this.configService.get('SOLANA_COMMITMENT'),
                },
            ),
        );

        // Poll mining info immediately on startup
        this.pollMiningInfo();

        // Schedule the next poll for midnight UTC
        const now = new Date();
        const nextMidnightUTC = new Date(
            Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth(),
                now.getUTCDate() + 1,
                0,
                0,
                0,
                0,
            ),
        );
        const msUntilMidnight = nextMidnightUTC.getTime() - now.getTime();

        setTimeout(() => {
            this.pollMiningInfo();
            setInterval(this.pollMiningInfo.bind(this), 24 * 60 * 60 * 1000); // every 24h
        }, msUntilMidnight);
    }

    private verifyProof(
        extraData: Buffer,
        nonce: number,
        version: number,
        timestamp: number,
        pubkey: PublicKey,
    ) {
        assert(
            hasValue(this.blockHash),
            'Block hash must be set before mining comptokens',
        );
        const target =
            this.solana_cluster === 'mainnet-beta'
                ? ComptokenProof.TARGET_BYTES
                : ComptokenProof.TARGET_BYTES_DEVNET;

        const recentBlockHash = Buffer.from(this.blockHash);

        console.log(`pubkey: ${pubkey.toBuffer().toString('hex')}`);
        console.log(`recentBlockHash: ${this.blockHash.toString('hex')}`);
        console.log(`extraData: ${extraData.toString('hex')}`);
        console.log(`nonce: ${nonce.toString(16)}`);
        console.log(`version: ${version.toString(16)}`);
        console.log(`timestamp: ${timestamp.toString(16)}`);
        console.log(`target: ${Buffer.from(target).toString('hex')}`);

        const proof = new ComptokenProof({
            pubkey,
            recentBlockHash,
            extraData,
            nonce,
            version,
            timestamp,
            target,
        });

        console.log(`header: ${Buffer.from(proof.header).toString('hex')}`);
        console.log(
            `Computed proof hash: ${Buffer.from(proof.hash).toString('hex')}`,
        );

        if (!ComptokenProof.isLowerThanTarget(proof.hash, proof.target)) {
            return { error: 'Difficulty too low' };
        }

        return { result: proof };
    }

    private async mineComptokens(
        proof: ComptokenProof,
    ): Promise<{ result?: string; error?: string }> {
        const mintComptokensResult = await tryWithLog(
            async () =>
                transactions.submitMiningProof({
                    program: this.comptoken_program,
                    proof,
                    accounts: {
                        userWallet: this.compto_keypair,
                    },
                }),
            'Submit mining proof',
        );

        if ('result' in mintComptokensResult) {
            return { result: mintComptokensResult.result };
        }
        // handle error
        if (
            (mintComptokensResult.rawError as AnchorError)?.error?.errorCode
                ?.code === 'UserDataProofsCapacityExceeded'
        ) {
            const increaseCapacityResult =
                await this.increaseUserDataCapacity();
            if ('error' in increaseCapacityResult) {
                return { error: increaseCapacityResult.error };
            }
            console.log('Increased user data capacity, retrying mining proof');

            // retry mining proof submission
            return tryWithLog(
                async () =>
                    transactions.submitMiningProof({
                        program: this.comptoken_program,
                        proof,
                        accounts: {
                            userWallet: this.compto_keypair,
                        },
                    }),
                'Submit mining proof',
            );
        }

        return { error: mintComptokensResult.error };
    }

    private async increaseUserDataCapacity(additionalCapacity = 100) {
        // get current capacity
        const userDataAccountInfoResult = await tryWithLog(
            async () =>
                await this.comptoken_program.account.userData.fetch(
                    addresses.getUserDataAddress(
                        this.comptoken_program,
                        this.compto_keypair.publicKey,
                    ),
                ),
            'Fetch user data account info',
        );
        if ('error' in userDataAccountInfoResult) {
            return { error: userDataAccountInfoResult.error };
        }
        const currentCapacity = userDataAccountInfoResult.result.proofs.length; // number of proofs currently stored (assumed to be at capacity)
        const newCapacity = currentCapacity + additionalCapacity;

        const resizeResult = await tryWithLog(
            async () =>
                await transactions.resizeUserDataAccount({
                    program: this.comptoken_program,
                    newCapacity: newCapacity,
                    accounts: {
                        userWallet: this.compto_keypair,
                    },
                }),
            'Resize user data account',
        );
        if ('error' in resizeResult) {
            return { error: resizeResult.error };
        }
        return { result: resizeResult.result };
    }

    private async processFees(
        recipient: PublicKey,
        fee: number,
    ): Promise<{ result?: string; error?: string }> {
        assert(fee >= 0 && fee <= 100_00, 'Invalid fee rate');
        const mineAmount = 100_00; // 100.00 COMP
        const userPayoutAmount = mineAmount - fee;

        if (userPayoutAmount <= 0) {
            // negative payouts should never happen due to the fee validation above
            return { result: 'No payout to process' };
        }

        const transferTransaction = new Transaction();
        transferTransaction.add(
            /* prettier-ignore */ // prettier doesn't like the 'extra' spaces here
            await createTransferCheckedWithTransferHookInstruction(
                this.connection,                                          // connection
                addresses.getUserUnstakedAssociatedTokenAddress(
                    this.comptoken_program,
                    this.compto_keypair.publicKey,
                ),                                                        // source
                addresses.getUnstakedMintAddress(this.comptoken_program), // mint
                recipient,                                                // destination
                this.compto_keypair.publicKey,                            // owner
                BigInt(userPayoutAmount),                                 // amount
                this.comptoken_program.constants.mintDecimals,            // decimals
                undefined,                                                // multiSigners
                undefined,                                                // commitment
                TOKEN_2022_PROGRAM_ID,                                    // programId
            ),
        );

        return tryWithLog(async () => {
            const transferResult = await sendAndConfirmTransaction(
                this.connection,
                transferTransaction,
                [this.compto_keypair],
            );
            console.log('Transfer result:', transferResult);

            return transferResult;
        }, 'Process fees transfer');
    }

    public async submitProof(
        extraData: Buffer,
        nonce: number,
        version: number,
        timestamp: number,
        recipient: PublicKey,
        fee: number,
    ) {
        const proofResult = this.verifyProof(
            extraData,
            nonce,
            version,
            timestamp,
            this.compto_keypair.publicKey,
        );
        if (hasValue(proofResult.error)) {
            return { error: proofResult.error };
        }
        const proof = proofResult.result as ComptokenProof;

        const mineResult = await this.mineComptokens(proof);
        if (mineResult.error) {
            return { error: mineResult.error };
        }

        console.log('Mine Transaction Signature:', mineResult.result);

        const processFeesResult = await this.processFees(recipient, fee);
        if (processFeesResult.error) {
            return { error: processFeesResult.error };
        }

        console.log('Fees Transaction Signature:', processFeesResult.result);

        return { result: true };
    }

    async updateUserData() {
        // when a new block is found, we need to update the user data account to clear out old proofs
        return tryWithLog(
            async () =>
                await transactions.collect({
                    program: this.comptoken_program,
                    accounts: {
                        userWallet: this.compto_keypair,
                    },
                }),
            'Collect user data proofs',
        );
    }

    public async pollMiningInfo() {
        const _pollMiningInfo = async () => {
            const miningInfo = await this.getMiningInfo();
            if (
                !hasValue(this.blockHash) ||
                (hasValue(miningInfo) && !miningInfo.equals(this.blockHash))
            ) {
                console.log('blockhash change!!!');
                this._newBlock$.next(miningInfo);
                this.blockHash = miningInfo;

                await this.updateUserData();

                return true;
            }
            return false;
        };
        // poll every 10 seconds until a new block hash is received
        const interval = setInterval(async () => {
            const done = await _pollMiningInfo();
            if (done) {
                clearInterval(interval);
            }
        }, 10_000);
    }

    public getBlockTemplate(blockHash: Buffer): IComptoBlockTemplate {
        console.log('getBlockTemplate');
        const testuser_account = this.compto_keypair.publicKey;
        const hexTestComptoAccount = testuser_account
            .toBuffer()
            .toString('hex');
        const blockTemplate: IComptoBlockTemplate = {
            version: 0x20000000,
            currentblockhash: blockHash.toString('hex'), // Example previous block hash
            coinbasePart1: '',
            coinbasePart2: '',
            transactions: [hexTestComptoAccount],
            bits: '180eadd8', // Compressed target representation
            timestamp: Math.floor(new Date().getTime() / 1000), // Current timestamp in UNIX epoch time
        };
        return blockTemplate;
    }

    public async getMiningInfo(): Promise<Buffer> {
        try {
            const { result: getvalidblockhash } =
                await transactions.syncValidBlockhashes({
                    program: this.comptoken_program,
                });

            return Buffer.from(getvalidblockhash.valid);
        } catch (e) {
            console.error(
                'Error getmininginfo',
                e instanceof Error ? e.message : e,
            );
            throw e;
        }
    }
}

async function tryWithLog<T>(fn: () => Promise<T>, logPrefix: string) {
    try {
        return { result: await fn() };
    } catch (e) {
        console.error(
            `${logPrefix} - error:`,
            e instanceof Error ? e.message : e,
        );
        return {
            error: e instanceof Error ? e.message : 'Unknown error',
            rawError: e,
        };
    }
}
