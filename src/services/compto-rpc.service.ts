import { Injectable, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import { BehaviorSubject, filter, shareReplay } from 'rxjs';

import { IComptoBlockTemplate } from '../models/compto-rpc/ComptoBlockTemplate';

import {
    ComptokenProof,
    ComptoPublicKeys,
    compto_public_keys as cpk, // to make it harder to accidentally use the wrong public keys; use <ComtpoRpcService>.compto_public_keys instead
    createProofSubmissionInstruction,
    devnet_compto_public_keys as devnet_cpk,
    getValidBlockhashes,
} from '@compto/comptoken.js';
import { ConfigService } from '@nestjs/config';
import {
    getAssociatedTokenAddressSync,
    TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
    clusterApiUrl,
    Connection,
    Keypair,
    sendAndConfirmTransaction,
    Transaction,
} from '@solana/web3.js';

@Injectable()
export class ComptoRpcService implements OnModuleInit {
    private compto_public_keys: ComptoPublicKeys;
    private user_keypair: Keypair;
    private solana_cluster: string;
    private connection: Connection;

    private blockHash: Buffer = null;
    private _newBlock$: BehaviorSubject<Buffer> = new BehaviorSubject(
        undefined,
    );
    public newBlock$ = this._newBlock$.pipe(
        filter((block) => block != null),
        shareReplay({ refCount: true, bufferSize: 1 }),
    );

    constructor(private readonly configService: ConfigService) {
        const solana_user =
            (this.configService.get('SOLANA_USER') == ''
                ? undefined
                : this.configService.get('SOLANA_USER')) ??
            Buffer.from(
                JSON.parse(
                    fs.readFileSync(
                        this.configService.getOrThrow('SOLANA_USER_PATH'),
                        'utf-8',
                    ),
                ),
            );

        console.log(`solana_user: ${solana_user}`);

        this.user_keypair = Keypair.fromSecretKey(solana_user);
    }

    async onModuleInit() {
        this.solana_cluster = this.configService.get('SOLANA_CLUSTER');
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
                `${Object.keys(this.compto_public_keys)
                    .map((key) => `    ${key}: ${this.compto_public_keys[key]}`)
                    .join(',\n')}\n` +
                `}`,
        );
        setInterval(this.pollMiningInfo.bind(this), 10_000);
    }

    public async mineComptokens(
        extraData: Buffer,
        nonce: number,
        version: number,
        timestamp: number,
    ) {
        const testuser_compto_pubkey = getAssociatedTokenAddressSync(
            this.compto_public_keys.comptoken_mint_pubkey,
            this.user_keypair.publicKey,
            false,
            TOKEN_2022_PROGRAM_ID,
        );
        const target =
            this.solana_cluster === 'mainnet-beta'
                ? ComptokenProof.TARGET_BYTES
                : ComptokenProof.TARGET_BYTES_DEVNET;

        const recentBlockHash = Buffer.from(this.blockHash);
        recentBlockHash.swap32();

        console.log(
            `testuser_compto_pubkey: ${testuser_compto_pubkey
                .toBuffer()
                .toString('hex')}`,
        );
        console.log(`recentBlockHash: ${this.blockHash.toString('hex')}`);
        console.log(`extraData: ${extraData.toString('hex')}`);
        console.log(`nonce: ${nonce}`);
        console.log(`version: ${version}`);
        console.log(`timestamp: ${timestamp}`);
        console.log(`target: ${Buffer.from(target).toString('hex')}`);

        let proof: ComptokenProof;
        try {
            proof = new ComptokenProof({
                pubkey: testuser_compto_pubkey,
                recentBlockHash,
                extraData,
                nonce,
                version,
                timestamp,
                target,
            });
        } catch (e) {
            if (
                e instanceof Error &&
                e.message.startsWith(
                    'The provided proof does not have enough zeroes',
                )
            ) {
                return { error: 'Difficultu too low' };
            }
        }

        let mintComptokensTransaction = new Transaction();
        mintComptokensTransaction.add(
            await createProofSubmissionInstruction(
                proof,
                this.user_keypair.publicKey,
                testuser_compto_pubkey,
                this.compto_public_keys,
            ),
        );

        let mintComptokensResult = await sendAndConfirmTransaction(
            this.connection,
            mintComptokensTransaction,
            [this.user_keypair],
        );
        return { result: mintComptokensResult };
    }

    public async pollMiningInfo() {
        const miningInfo = await this.getMiningInfo();
        if (
            this.blockHash == null ||
            (miningInfo != null && !miningInfo.equals(this.blockHash))
        ) {
            console.log('blockhash change!!!');
            this._newBlock$.next(miningInfo);
            this.blockHash = miningInfo;
        }
    }

    public getBlockTemplate(blockHash: Buffer): IComptoBlockTemplate {
        console.log('getBlockTemplate');
        let testuser_comptoken_account = getAssociatedTokenAddressSync(
            this.compto_public_keys.comptoken_mint_pubkey,
            this.user_keypair.publicKey,
            false,
            TOKEN_2022_PROGRAM_ID,
        );
        const hexTestComptoAccount = testuser_comptoken_account
            .toBuffer()
            .toString('hex');
        const blockTemplate: IComptoBlockTemplate = {
            version: 0x20000000,
            currentblockhash: blockHash.toString('hex'), // Example previous block hash
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
                this.user_keypair,
                this.compto_public_keys,
            );

            return Buffer.from(getvalidblockhash.validBlockhash);
        } catch (e) {
            console.error('Error getmininginfo', e.message);
            return null;
        }
    }
}
