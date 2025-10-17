import { Injectable, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import { BehaviorSubject, filter, shareReplay } from 'rxjs';

import { IComptoBlockTemplate } from '../models/compto-rpc/ComptoBlockTemplate';

import {
    COMPTOKEN_DECIMALS,
    ComptokenProof,
    ComptoPublicKeys,
    compto_public_keys as cpk, // to make it harder to accidentally use the wrong public keys; use <ComtpoRpcService>.compto_public_keys instead
    createProofSubmissionInstruction,
    devnet_compto_public_keys as devnet_cpk,
    getValidBlockhashes,
} from '@compto/comptoken.js';
import { ConfigService } from '@nestjs/config';
import {
    createTransferCheckedWithTransferHookInstruction,
    getAssociatedTokenAddressSync,
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
    private compto_public_keys!: ComptoPublicKeys; // assigned in onModuleInit
    private compto_keypair: Keypair;
    private solana_cluster!: string; // assigned in onModuleInit
    private connection!: Connection; // assigned in onModuleInit

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

        switch (this.solana_cluster) {
            case 'mainnet-beta':
                this.compto_public_keys = cpk;
                break;
            case 'testnet':
                throw new Error('Testnet not supported');
            case 'devnet':
                this.compto_public_keys = devnet_cpk;
                break;
            case 'local':
            default:
                this.compto_public_keys = ComptoPublicKeys.loadFromCache(
                    this.configService.getOrThrow('COMPTO_PUBLIC_KEYS_PATH'),
                );
                break;
        }
        console.log(
            `compto_public_keys: {\n` +
                `${(
                    Object.keys(
                        this.compto_public_keys,
                    ) as (keyof ComptoPublicKeys)[]
                )
                    .map((key) => `    ${key}: ${this.compto_public_keys[key]}`)
                    .join(',\n')}\n` +
                `}`,
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
        recentBlockHash.swap32();

        console.log(`pubkey: ${pubkey.toBuffer().toString('hex')}`);
        console.log(`recentBlockHash: ${this.blockHash.toString('hex')}`);
        console.log(`extraData: ${extraData.toString('hex')}`);
        console.log(`nonce: ${nonce}`);
        console.log(`version: ${version}`);
        console.log(`timestamp: ${timestamp}`);
        console.log(`target: ${Buffer.from(target).toString('hex')}`);

        try {
            return {
                result: new ComptokenProof({
                    pubkey,
                    recentBlockHash,
                    extraData,
                    nonce,
                    version,
                    timestamp,
                    target,
                }),
            };
        } catch (e) {
            if (
                e instanceof Error &&
                e.message.startsWith(
                    'The provided proof does not have enough zeroes',
                )
            ) {
                return { error: 'Difficulty too low' };
            }
            // Return unexpected error message
            return { error: e instanceof Error ? e.message : 'Unknown error' };
        }
    }

    private async mineComptokens(proof: ComptokenProof, pubkey: PublicKey) {
        try {
            const mintComptokensTransaction = new Transaction();
            mintComptokensTransaction.add(
                await createProofSubmissionInstruction(
                    proof,
                    this.compto_keypair.publicKey,
                    pubkey,
                    this.compto_public_keys,
                ),
            );

            const mintComptokensResult = await sendAndConfirmTransaction(
                this.connection,
                mintComptokensTransaction,
                [this.compto_keypair],
            );
            return { result: mintComptokensResult };
        } catch (e) {
            // Catch and return any errors during transaction
            return { error: e instanceof Error ? e.message : 'Unknown error' };
        }
    }

    private async processFees(
        compto_comptoken_pubkey: PublicKey,
        recipient: PublicKey,
        fee: number,
    ) {
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
                this.connection,                               // connection
                compto_comptoken_pubkey,                       // source
                this.compto_public_keys.comptoken_mint_pubkey, // mint
                recipient,                                     // destination
                this.compto_keypair.publicKey,                 // owner
                BigInt(userPayoutAmount),                      // amount
                COMPTOKEN_DECIMALS,                            // decimals
                undefined,                                     // multiSigners
                undefined,                                     // commitment
                TOKEN_2022_PROGRAM_ID,                         // programId
            ),
        );

        try {
            const transferResult = await sendAndConfirmTransaction(
                this.connection,
                transferTransaction,
                [this.compto_keypair],
            );
            console.log('Transfer result:', transferResult);

            return { result: transferResult };
        } catch (e) {
            console.error(
                'Error processing fees',
                e instanceof Error ? e.message : e,
            );
            return { error: e instanceof Error ? e.message : 'Unknown error' };
        }
    }

    public async submitProof(
        extraData: Buffer,
        nonce: number,
        version: number,
        timestamp: number,
        recipient: PublicKey,
        fee: number,
    ) {
        const compto_comptoken_pubkey = getAssociatedTokenAddressSync(
            this.compto_public_keys.comptoken_mint_pubkey,
            this.compto_keypair.publicKey,
            false,
            TOKEN_2022_PROGRAM_ID,
        );

        const proofResult = this.verifyProof(
            extraData,
            nonce,
            version,
            timestamp,
            compto_comptoken_pubkey,
        );
        if (proofResult.error) {
            return { error: proofResult.error };
        }
        const proof = proofResult.result as ComptokenProof;

        const mineResult = await this.mineComptokens(
            proof,
            compto_comptoken_pubkey,
        );
        if (mineResult.error) {
            return { error: mineResult.error };
        }

        console.log('Mine Transaction Signature:', mineResult.result);

        const processFeesResult = await this.processFees(
            compto_comptoken_pubkey,
            recipient,
            fee,
        );
        if (processFeesResult.error) {
            return { error: processFeesResult.error };
        }

        console.log('Fees Transaction Signature:', processFeesResult.result);

        return { result: true };
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
        const testuser_comptoken_account = getAssociatedTokenAddressSync(
            this.compto_public_keys.comptoken_mint_pubkey,
            this.compto_keypair.publicKey,
            false,
            TOKEN_2022_PROGRAM_ID,
        );
        const hexTestComptoAccount = testuser_comptoken_account
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
            const getvalidblockhash = await getValidBlockhashes(
                this.connection,
                this.compto_keypair,
                this.compto_public_keys,
            );

            return Buffer.from(getvalidblockhash.validBlockhash);
        } catch (e) {
            console.error(
                'Error getmininginfo',
                e instanceof Error ? e.message : e,
            );
            throw e;
        }
    }
}
