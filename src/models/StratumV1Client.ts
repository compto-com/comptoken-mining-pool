import { ConfigService } from '@nestjs/config';
import Big from 'big.js';
import * as bitcoinjs from 'bitcoinjs-lib';
import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import * as crypto from 'crypto';
import { Socket } from 'net';
import { firstValueFrom, Subscription } from 'rxjs';
import { clearInterval } from 'timers';
import { createInterface } from 'readline';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { NotificationService } from '../services/notification.service';
import { IJobTemplate, StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { eRequestMethod } from './enums/eRequestMethod';
import { eResponseMethod } from './enums/eResponseMethod';
import { eStratumErrorCode } from './enums/eStratumErrorCode';
import { MiningJob } from './MiningJob';
import { AuthorizationMessage } from './stratum-messages/AuthorizationMessage';
import { ConfigurationMessage } from './stratum-messages/ConfigurationMessage';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';
import { StratumErrorMessage } from './stratum-messages/StratumErrorMessage';
import { SubscriptionMessage } from './stratum-messages/SubscriptionMessage';
import { SuggestDifficulty } from './stratum-messages/SuggestDifficultyMessage';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';
import { PublicKey, sendAndConfirmTransaction, Transaction, Connection, Keypair }  from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
// import { compto_program_id_pubkey } from 'comptoken-js-offchain-cjs';
import * as compto from '@compto/comptoken-js-offchain';
import * as fs from 'fs';
import * as path from 'path';
import e from 'express';

(async () => {
  console.log(compto);
})();

export class StratumV1Client {

    private clientSubscription: SubscriptionMessage;
    private clientConfiguration: ConfigurationMessage;
    private clientAuthorization: AuthorizationMessage;
    private clientSuggestedDifficulty: SuggestDifficulty;
    private stratumSubscription: Subscription;
    private backgroundWork: NodeJS.Timer[] = [];

    private statistics: StratumV1ClientStatistics;
    private stratumInitialized = false;
    private usedSuggestedDifficulty = false;
    private sessionDifficulty: number = 16384;

    private entity: ClientEntity;
    private creatingEntity: Promise<void>;

    public extraNonceAndSessionId: string;
    public sessionStart: Date;
    public noFee: boolean;
    public hashRate: number = 0;

    private buffer: string = '';

    constructor(
        public readonly socket: Socket,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly notificationService: NotificationService,
        private readonly blocksService: BlocksService,
        private readonly configService: ConfigService,
        private readonly addressSettingsService: AddressSettingsService
    ) {
        console.log('StratumV1Client created');
        this.socket.on('data', (data: Buffer) => {
            this.buffer += data.toString();
            let lines = this.buffer.split('\n');
            this.buffer = lines.pop() || ''; // Save the last part of the data (incomplete line) to the buffer

            lines
                .filter(m => m.length > 0)
                .forEach(async (m) => {
                    try {
                        await this.handleMessage(m);
                    } catch (e) {
                        await this.socket.end();
                        console.error(e);
                    }
                });
        });


    }

    public async destroy() {

        if (this.extraNonceAndSessionId) {
            await this.clientService.delete(this.extraNonceAndSessionId);
        }

        if (this.stratumSubscription != null) {
            this.stratumSubscription.unsubscribe();
        }

        this.backgroundWork.forEach(work => {
            clearInterval(work);
        });
    }

    private getRandomHexString() {
        const randomBytes = crypto.randomBytes(4); // 4 bytes = 32 bits
        const randomNumber = randomBytes.readUInt32BE(0); // Convert bytes to a 32-bit unsigned integer
        const hexString = randomNumber.toString(16).padStart(8, '0'); // Convert to hex and pad with zeros
        return hexString;
    }


    private async handleMessage(message: string) {
        console.log('Received message: ', message);
        console.log('----->');

        // console.log(compto_program_id_pubkey);
        //console.log(`Received from ${this.extraNonceAndSessionId}`, message);

        // Parse the message and check if it's the initial subscription message
        let parsedMessage = null;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            //console.log("Invalid JSON");
            await this.socket.end();
            return;
        }



        switch (parsedMessage.method) {
            case eRequestMethod.SUBSCRIBE: {
                const subscriptionMessage = plainToInstance(
                    SubscriptionMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    forbidNonWhitelisted: true,
                };

                const errors = await validate(subscriptionMessage, validatorOptions);

                if (errors.length === 0) {

                    if (this.sessionStart == null) {
                        this.sessionStart = new Date();
                        this.statistics = new StratumV1ClientStatistics(this.clientStatisticsService);
                        this.extraNonceAndSessionId = this.getRandomHexString();
                        console.log(`New client ID: : ${this.extraNonceAndSessionId}, ${this.socket.remoteAddress}:${this.socket.remotePort}`);
                    }

                    this.clientSubscription = subscriptionMessage;
                    const success = await this.write(JSON.stringify(this.clientSubscription.response(this.extraNonceAndSessionId)) + '\n');
                    if (!success) {
                        return;
                    }
                } else {
                    console.error('Subscription validation error');
                    const err = new StratumErrorMessage(
                        subscriptionMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Subscription validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }

                break;
            }
            case eRequestMethod.CONFIGURE: {

                const configurationMessage = plainToInstance(
                    ConfigurationMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    forbidNonWhitelisted: true,
                };

                const errors = await validate(configurationMessage, validatorOptions);

                if (errors.length === 0) {
                    this.clientConfiguration = configurationMessage;
                    //const response = this.buildSubscriptionResponse(configurationMessage.id);
                    const success = await this.write(JSON.stringify(this.clientConfiguration.response()) + '\n');
                    if (!success) {
                        return;
                    }

                } else {
                    console.error('Configuration validation error');
                    const err = new StratumErrorMessage(
                        configurationMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Configuration validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }

                break;
            }
            case eRequestMethod.AUTHORIZE: {

                const authorizationMessage = plainToInstance(
                    AuthorizationMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    forbidNonWhitelisted: true,
                };
                console.log(authorizationMessage);
                console.log("------------==--------------->")
                console.log(validatorOptions);
                const errors = await validate(authorizationMessage, validatorOptions);

                if (errors.length === 0) {
                    this.clientAuthorization = authorizationMessage;
                    const success = await this.write(JSON.stringify(this.clientAuthorization.response()) + '\n');
                    if (!success) {
                        return;
                    }
                } else {
                    console.error('Authorization validation error');
                    const err = new StratumErrorMessage(
                        authorizationMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Authorization validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }

                break;
            }
            case eRequestMethod.SUGGEST_DIFFICULTY: {
                return;
                // No suggested difficulty for comptoken mining

                // if (this.usedSuggestedDifficulty == true) {
                //     return;
                // }

                // const suggestDifficultyMessage = plainToInstance(
                //     SuggestDifficulty,
                //     parsedMessage
                // );

                // const validatorOptions: ValidatorOptions = {
                //     whitelist: true,
                //     forbidNonWhitelisted: true,
                // };

                // const errors = await validate(suggestDifficultyMessage, validatorOptions);

                // if (errors.length === 0) {

                //     this.clientSuggestedDifficulty = suggestDifficultyMessage;
                //     this.sessionDifficulty = suggestDifficultyMessage.suggestedDifficulty;
                //     const success = await this.write(JSON.stringify(this.clientSuggestedDifficulty.response(this.sessionDifficulty)) + '\n');
                //     if (!success) {
                //         return;
                //     }
                //     this.usedSuggestedDifficulty = true;
                // } else {
                //     console.error('Suggest difficulty validation error');
                //     const err = new StratumErrorMessage(
                //         suggestDifficultyMessage.id,
                //         eStratumErrorCode.OtherUnknown,
                //         'Suggest difficulty validation error',
                //         errors).response();
                //     console.error(err);
                //     const success = await this.write(err);
                //     if (!success) {
                //         return;
                //     }
                // }
                // break;
            }
            case eRequestMethod.SUBMIT: {

                if (this.stratumInitialized == false) {
                    console.log('Submit before initalized');
                    await this.socket.end();
                    return;
                }


                const miningSubmitMessage = plainToInstance(
                    MiningSubmitMessage,
                    parsedMessage,
                );

                const validatorOptions: ValidatorOptions = {
                    whitelist: true,
                    forbidNonWhitelisted: true,
                };

                const errors = await validate(miningSubmitMessage, validatorOptions);

                if (errors.length === 0 && this.stratumInitialized == true) {
                    const result = await this.handleMiningSubmission(miningSubmitMessage);
                    if (result == true) {
                        const success = await this.write(JSON.stringify(miningSubmitMessage.response()) + '\n');
                        if (!success) {
                            return;
                        }
                    }


                } else {
                    console.log('Mining Submit validation error');
                    const err = new StratumErrorMessage(
                        miningSubmitMessage.id,
                        eStratumErrorCode.OtherUnknown,
                        'Mining Submit validation error',
                        errors).response();
                    console.error(err);
                    const success = await this.write(err);
                    if (!success) {
                        return;
                    }
                }
                break;
            }
            // default: {
            //     console.log("Invalid message");
            //     console.log(parsedMessage);
            //     await this.socket.end();
            //     return;
            // }
        }


        if (this.clientSubscription != null
            && this.clientAuthorization != null
            && this.stratumInitialized == false) {

            await this.initStratum();

        }
    }

    private async initStratum() {
        console.log('Initializing stratum');
        console.log('oooooooooooooooooooooooooo')

        this.stratumInitialized = true;

        console.log('user agent: ', this.clientSubscription.userAgent);
        switch (this.clientSubscription.userAgent) {
            case 'cpuminer': {
                this.sessionDifficulty = 0.01;
            }
        }

        if (this.clientSuggestedDifficulty == null) {
            //console.log(`Setting difficulty to ${this.sessionDifficulty}`)
            const setDifficulty = JSON.stringify(new SuggestDifficulty().response(this.sessionDifficulty));
            console.log("Setting difficulty to: ", setDifficulty);
            const success = await this.write(setDifficulty + '\n');
            if (!success) {
                return;
            }
        }

        this.stratumSubscription = this.stratumV1JobsService.newMiningJob$.subscribe(async (jobTemplate) => {
            try {
                await this.sendNewMiningJob(jobTemplate);
            } catch (e) {
                await this.socket.end();
                console.error(e);
            }
        });

        this.backgroundWork.push(
            setInterval(async () => {
                await this.checkDifficulty();
            }, 60 * 1000)
        );

    }

    private async sendNewMiningJob(jobTemplate: IJobTemplate) {
        console.log('Sending new job');
        console.log(jobTemplate);

        // let payoutInformation;
        // const devFeeAddress = this.configService.get('DEV_FEE_ADDRESS');
        // //50Th/s
        // this.noFee = false;
        // if (this.entity) {
        //     this.hashRate = await this.clientStatisticsService.getHashRateForSession(this.clientAuthorization.address, this.clientAuthorization.worker, this.extraNonceAndSessionId);
        //     this.noFee = this.hashRate != 0 && this.hashRate < 50000000000000;
        // }
        // if (this.noFee || devFeeAddress == null || devFeeAddress.length < 1) {
        //     payoutInformation = [
        //         { address: this.clientAuthorization.address, percent: 100 }
        //     ];

        // } else {
        //     payoutInformation = [
        //         { address: devFeeAddress, percent: 1.5 },
        //         { address: this.clientAuthorization.address, percent: 98.5 }
        //     ];
        // }

        const networkConfig = this.configService.get('NETWORK');
        let network;

        if (networkConfig === 'mainnet') {
            network = bitcoinjs.networks.bitcoin;
        } else if (networkConfig === 'testnet') {
            network = bitcoinjs.networks.testnet;
        } else if (networkConfig === 'regtest') {
            network = bitcoinjs.networks.regtest;
        } else {
            throw new Error('Invalid network configuration');
        }

        const job = new MiningJob(
            network,
            this.stratumV1JobsService.getNextId(),
            jobTemplate
        );

        this.stratumV1JobsService.addJob(job);


        const success = await this.write(job.response(jobTemplate));
        if (!success) {
            return;
        }


        //console.log(`Sent new job to ${this.clientAuthorization.worker}.${this.extraNonceAndSessionId}. (clearJobs: ${jobTemplate.blockData.clearJobs}, fee?: ${!this.noFee})`)

    }


    private async handleMiningSubmission(submission: MiningSubmitMessage) {

        if (this.entity == null) {
            if (this.creatingEntity == null) {
                this.creatingEntity = new Promise(async (resolve, reject) => {
                    try {
                        this.entity = await this.clientService.insert({
                            sessionId: this.extraNonceAndSessionId,
                            address: this.clientAuthorization.address,
                            clientName: this.clientAuthorization.worker,
                            userAgent: this.clientSubscription.userAgent,
                            startTime: new Date(),
                            bestDifficulty: 0
                        });
                    } catch (e) {
                        reject(e);
                    }
                    resolve();
                });
                await this.creatingEntity;

            } else {
                await this.creatingEntity;
            }
        }


        const job = this.stratumV1JobsService.getJobById(submission.jobId);

        // a miner may submit a job that doesn't exist anymore if it was removed by a new block notification
        if (job == null) {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.JobNotFound,
                'Job not found').response();
            //console.log(err);
            const success = await this.write(err);
            if (!success) {
                return false;
            }
            return false;
        }
        const jobTemplate = this.stratumV1JobsService.getJobTemplateById(job.jobTemplateId);

        // const updatedJobBlock = job.copyAndUpdateBlock(
        //     jobTemplate,
        //     parseInt(submission.versionMask, 16),
        //     parseInt(submission.nonce, 16),
        //     this.extraNonceAndSessionId,
        //     submission.extraNonce2,
        //     parseInt(submission.ntime, 16)
        // );
        // const header = updatedJobBlock.toBuffer(true);
        const versionMask = parseInt(submission.versionMask, 16);
        let version = 0x20000000;
        if (versionMask !== undefined && versionMask != 0) {
            version = version ^ versionMask;
        }

        const xhashbuf = Buffer.from(this.extraNonceAndSessionId + submission.extraNonce2, 'hex');
        let extraDataHashed = this.doubleSHA256(xhashbuf);
        const versionBuffer = Buffer.alloc(4);
        versionBuffer.writeUInt32LE(jobTemplate.block.version);
        const comptokenProof = new compto.ComptokenProof(
            Buffer.from(jobTemplate.block.transactions[0], 'hex'),
            this.hexStringToLittleEndianBuffer(jobTemplate.block.currentblockhash),
            extraDataHashed,
            this.hexStringToLittleEndianBuffer(submission.nonce),
            versionBuffer,
            this.hexStringToLittleEndianBuffer(submission.ntime),
        ); 

        let connection = new Connection("http://localhost:8899");
        let testuser_compto_pubkey = getAssociatedTokenAddressSync(compto.comptoken_mint_pubkey, compto.test_account.publicKey, false, TOKEN_2022_PROGRAM_ID);
        let mintComptokensTransaction = new Transaction();
        mintComptokensTransaction.add(
            await compto.createProofSubmissionInstruction(comptokenProof, compto.test_account.publicKey, testuser_compto_pubkey),
        );


        let mintComptokensResult = await sendAndConfirmTransaction(connection, mintComptokensTransaction, [compto.test_account, compto.test_account]);
        console.log("==================================================================================");
        console.log("mintComptokens transaction confirmed", mintComptokensResult);
        console.log("==================================================================================");

        // const { submissionDifficulty } = this.calculateDifficulty(header);

        //console.log(`DIFF: ${submissionDifficulty} of ${this.sessionDifficulty} from ${this.clientAuthorization.worker + '.' + this.extraNonceAndSessionId}`);


        // if (submissionDifficulty >= this.sessionDifficulty) {

        //     if (submissionDifficulty >= jobTemplate.blockData.networkDifficulty) {
        //         console.log('!!! BLOCK FOUND !!!');
        //         const blockHex = updatedJobBlock.toHex(false);
        //         const result = await this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);
        //         await this.blocksService.save({
        //             height: jobTemplate.blockData.height,
        //             minerAddress: this.clientAuthorization.address,
        //             worker: this.clientAuthorization.worker,
        //             sessionId: this.extraNonceAndSessionId,
        //             blockData: blockHex
        //         });

        //         await this.notificationService.notifySubscribersBlockFound(this.clientAuthorization.address, jobTemplate.blockData.height, updatedJobBlock, result);
        //         //success
        //         if (result == null) {
        //             await this.addressSettingsService.resetBestDifficultyAndShares();
        //         }
        //     }
        //     try {
        //         await this.statistics.addShares(this.entity, this.sessionDifficulty);
        //         const now = new Date();
        //         // only update every minute
        //         if (this.entity.updatedAt == null || now.getTime() - this.entity.updatedAt.getTime() > 1000 * 60) {
        //             await this.clientService.heartbeat(this.entity.address, this.entity.clientName, this.entity.sessionId, this.hashRate, now);
        //             this.entity.updatedAt = now;
        //         }

        //     } catch (e) {
        //         console.log(e);
        //         const err = new StratumErrorMessage(
        //             submission.id,
        //             eStratumErrorCode.DuplicateShare,
        //             'Duplicate share').response();
        //         console.error(err);
        //         const success = await this.write(err);
        //         if (!success) {
        //             return false;
        //         }staticxtraNonceAndSessionId, submissionDifficulty);
        //         this.entity.bestDifficulty = submissionDifficulty;
        //         if (submissionDifficulty > (await this.addressSettingsService.getSettings(this.clientAuthorization.address, true)).bestDifficulty) {
        //             await this.addressSettingsService.updateBestDifficulty(this.clientAuthorization.address, submissionDifficulty, this.entity.userAgent);
        //         }
        //     }



        // } else {
        //     const err = new StratumErrorMessage(
        //         submission.id,
        //         eStratumErrorCode.LowDifficultyShare,
        //         'Difficulty too low').response();

        //     const success = await this.write(err);
        //     if (!success) {
        //         return false;
        //     }

        //     return false;
        // }

        await this.checkDifficulty();
        return true;

    }

    private doubleSHA256(data: Buffer): Buffer {
        const firstHash = crypto.createHash('sha256').update(data).digest();
        const secondHash = crypto.createHash('sha256').update(firstHash).digest();
        return secondHash;
    }

    private async checkDifficulty() {
        const targetDiff = this.statistics.getSuggestedDifficulty(this.sessionDifficulty);
        if (targetDiff == null) {
            return;
        }

        if (targetDiff != this.sessionDifficulty) {
            //console.log(`Adjusting ${this.extraNonceAndSessionId} difficulty from ${this.sessionDifficulty} to ${targetDiff}`);
            this.sessionDifficulty = targetDiff;

            const data = JSON.stringify({
                id: null,
                method: eResponseMethod.SET_DIFFICULTY,
                params: [targetDiff]
            }) + '\n';


            await this.socket.write(data);
            console.log('start to await newMiningJob$.');
            const jobTemplate = await firstValueFrom(this.stratumV1JobsService.newMiningJob$);
            console.log('finish await newMiningJob$');
            // we need to clear the jobs so that the difficulty set takes effect. Otherwise the different miner implementations can cause issues
            jobTemplate.blockData.clearJobs = true;
            await this.sendNewMiningJob(jobTemplate);

        }
    }

    private calculateDifficulty(header: Buffer): { submissionDifficulty: number, submissionHash: string } {

        const hashResult = bitcoinjs.crypto.hash256(header);

        let s64 = this.le256todouble(hashResult);

        const truediffone = Big('26959535291011309493156476344723991336010898738574164086137773096960');
        const difficulty = truediffone.div(s64.toString());
        return { submissionDifficulty: difficulty.toNumber(), submissionHash: hashResult.toString('hex') };
    }


    private le256todouble(target: Buffer): bigint {

        const number = target.reduceRight((acc, byte) => {
            // Shift the number 8 bits to the left and OR with the current byte
            return (acc << BigInt(8)) | BigInt(byte);
        }, BigInt(0));

        return number;
    }

    private hexStringToUint8Array(hexString: string): Uint8Array {
        // Remove any potential '0x' prefix from the hex string
        if (hexString.startsWith('0x')) {
          hexString = hexString.slice(2);
        }
      
        // Ensure the hex string has an even length
        if (hexString.length % 2 !== 0) {
          throw new Error('Invalid hex string: length must be a multiple of 2');
        }
      
        const byteArray = new Uint8Array(hexString.length / 2);
      
        for (let i = 0; i < hexString.length; i += 2) {
          const byteHex = hexString.substr(i, 2);
          const byteValue = parseInt(byteHex, 16);
          if (isNaN(byteValue)) {
            throw new Error(`Invalid hex string: contains non-hex characters at position ${i}`);
          }
          byteArray[i / 2] = byteValue;
        }
      
        return byteArray;
      }

    private loadKeypairFromFile(keypairPath: string): Keypair {
        const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
        return Keypair.fromSecretKey(Uint8Array.from(keypairData));
    }

    private hexStringToLittleEndianBuffer(hexString: string): Buffer {
        // Remove any leading "0x" if present
        if (hexString.startsWith('0x') || hexString.startsWith('0X')) {
            hexString = hexString.slice(2);
        }
    
        // Ensure hex string length is even (full bytes)
        if (hexString.length % 2 !== 0) {
            hexString = '0' + hexString; // Pad with leading zero
        }
    
        // Split hex string into an array of bytes (two hex characters each)
        const bytes = hexString.match(/.{2}/g);
        if (!bytes) {
            return Buffer.alloc(0); // Return empty buffer if no bytes
        }
    
        const wordSize = 4; // Word size in bytes (e.g., 4 bytes for 32-bit word)
        const bufferArray: number[] = [];
    
        for (let i = 0; i < bytes.length; i += wordSize) {
            // Get the next word's bytes
            const wordBytes = bytes.slice(i, i + wordSize);
    
            // Reverse the bytes within the word for little-endian representation
            const reversedWordBytes = wordBytes.reverse();
    
            // Convert the hex strings to numbers and add to buffer array
            reversedWordBytes.forEach(byteStr => {
                bufferArray.push(parseInt(byteStr, 16));
            });
        }
    
        // Create a Buffer from the array of bytes
        return Buffer.from(bufferArray);
    }


    private async write(message: string): Promise<boolean> {
        console.log('Writing message: ', message);
        try {
            if (!this.socket.destroyed && !this.socket.writableEnded) {

                await new Promise((resolve, reject) => {
                    this.socket.write(message, (error) => {
                        if (error) {
                            reject(error);
                        } else {
                            resolve(true);
                        }
                    });
                });

                return true;
            } else {
                console.error(`Error: Cannot write to closed or ended socket. ${this.extraNonceAndSessionId} ${message}`);
                this.destroy();
                if (!this.socket.destroyed) {
                    this.socket.destroy();
                }
                return false;
            }
        } catch (error) {
            this.destroy();
            if (!this.socket.writableEnded) {
                await this.socket.end();
            } else if (!this.socket.destroyed) {
                this.socket.destroy();
            }
            console.error(`Error occurred while writing to socket: ${this.extraNonceAndSessionId}`, error);
            return false;
        }
    }

}
