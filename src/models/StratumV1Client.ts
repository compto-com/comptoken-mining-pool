import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import * as crypto from 'crypto';
import { Socket } from 'net';
import { Subscription } from 'rxjs';
import { clearInterval } from 'timers';

import { ConfigService } from '@nestjs/config';
import { PublicKey } from '@solana/web3.js';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { ComptoRpcService } from '../services/compto-rpc.service';
import {
    IJobTemplate,
    StratumV1JobsService,
} from '../services/stratum-v1-jobs.service';
import { assert, hasValue } from '../utils';
import { eRequestMethod } from './enums/eRequestMethod';
import { eStratumErrorCode } from './enums/eStratumErrorCode';
import { AuthorizationMessage } from './stratum-messages/AuthorizationMessage';
import { ConfigurationMessage } from './stratum-messages/ConfigurationMessage';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';
import { StratumBaseMessage } from './stratum-messages/StratumBaseMessage';
import { StratumErrorMessage } from './stratum-messages/StratumErrorMessage';
import { SubscriptionMessage } from './stratum-messages/SubscriptionMessage';
import { SuggestDifficulty } from './stratum-messages/SuggestDifficultyMessage';

export class StratumV1Client {
    private clientSubscription: SubscriptionMessage | null = null;
    private clientConfiguration: ConfigurationMessage | null = null;
    private clientAuthorization: AuthorizationMessage | null = null;
    private stratumSubscription: Subscription | null = null;
    private backgroundWork: NodeJS.Timeout[] = [];

    private stratumInitialized = false;

    private entity: ClientEntity | null = null;
    private creatingEntity: Promise<void> | null = null;

    public extraNonceAndSessionId: string | null = null;
    public sessionStart: Date | null = null;
    public noFee: boolean = false;
    public hashRate: number = 0;

    private buffer: string = '';

    constructor(
        public readonly socket: Socket,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly clientService: ClientService,
        private readonly comptoRpcService: ComptoRpcService,
        private readonly configService: ConfigService,
    ) {
        console.log('StratumV1Client created');
        this.socket.on('data', (data: Buffer) => {
            const accumulatedData = this.buffer + data.toString();
            const lines = accumulatedData.split('\n');
            this.buffer = lines.pop() || ''; // Save the last part of the data (incomplete line) to the buffer

            lines
                .filter((m) => m.length > 0)
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
        if (hasValue(this.extraNonceAndSessionId)) {
            await this.clientService.delete(this.extraNonceAndSessionId);
        }

        if (hasValue(this.stratumSubscription)) {
            this.stratumSubscription.unsubscribe();
        }

        this.backgroundWork.forEach((work) => {
            clearInterval(work);
        });
    }

    private getRandomHexString() {
        const randomBytes = crypto.randomBytes(4); // 4 bytes = 32 bits
        const randomNumber = randomBytes.readUInt32BE(0); // Convert bytes to a 32-bit unsigned integer
        const hexString = randomNumber.toString(16).padStart(8, '0'); // Convert to hex and pad with zeros
        return hexString;
    }

    private async validateMessage<MessageType extends StratumBaseMessage>(
        parsedMessage: StratumBaseMessage,
        messageType: new () => MessageType,
    ) {
        const message = plainToInstance(messageType, parsedMessage);

        const validatorOptions: ValidatorOptions = {
            whitelist: true,
            forbidNonWhitelisted: true,
        };

        const errors = await validate(message, validatorOptions);

        if (errors.length > 0) {
            console.error('Validation error');
            const err = new StratumErrorMessage(
                message.id,
                eStratumErrorCode.OtherUnknown,
                'Validation error',
                errors,
            ).response();
            console.error(err);
            return { error: await this.write(err) };
        }
        return { result: message as MessageType };
    }

    private async handleMessage(message: string) {
        console.log('Received message: ', message);
        console.log('----->');

        // Parse the message and check if it's the initial subscription message
        let parsedMessage: StratumBaseMessage;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            await this.socket.end();
            return;
        }

        switch (parsedMessage.method) {
            case eRequestMethod.SUBSCRIBE: {
                const success = await this.handleSubscriptionMessage(
                    parsedMessage,
                );
                if (!success) {
                    return;
                }
                break;
            }
            case eRequestMethod.CONFIGURE: {
                const success = await this.handleConfigureMessage(
                    parsedMessage,
                );
                if (!success) {
                    return;
                }
                break;
            }
            case eRequestMethod.AUTHORIZE: {
                const success = await this.handleAuthorizationMessage(
                    parsedMessage,
                );
                if (!success) {
                    return;
                }
                break;
            }
            case eRequestMethod.SUGGEST_DIFFICULTY: {
                // ignore: difficulty is constant for comptokens
                break;
            }
            case eRequestMethod.SUBMIT: {
                if (this.stratumInitialized == false) {
                    console.log('Submit before initalized');
                    await this.socket.end();
                    return;
                }

                const success = await this.handleSubmitMessage(parsedMessage);
                if (!success) {
                    return;
                }
                break;
            }
        }

        if (
            hasValue(this.clientSubscription) &&
            hasValue(this.clientAuthorization) &&
            this.stratumInitialized == false
        ) {
            await this.initStratum();
        }
    }

    private async handleSubscriptionMessage(parsedMessage: StratumBaseMessage) {
        const validationResult = await this.validateMessage(
            parsedMessage,
            SubscriptionMessage,
        );
        if (hasValue(validationResult.error)) {
            console.error('Invalid subscription message');
            return validationResult.error;
        }
        const subscriptionMessage =
            validationResult.result as SubscriptionMessage;

        if (!hasValue(this.sessionStart)) {
            this.sessionStart = new Date();
            this.extraNonceAndSessionId = this.getRandomHexString();
            console.log(
                `New client ID: : ${this.extraNonceAndSessionId}, ${this.socket.remoteAddress}:${this.socket.remotePort}`,
            );
        }

        this.clientSubscription = subscriptionMessage;
        return this.write(
            JSON.stringify(
                this.clientSubscription.response(
                    this.extraNonceAndSessionId as string,
                ),
            ) + '\n',
        );
    }

    private async handleConfigureMessage(parsedMessage: StratumBaseMessage) {
        const validationResult = await this.validateMessage(
            parsedMessage,
            ConfigurationMessage,
        );
        if (hasValue(validationResult.error)) {
            console.error('Invalid configuration message');
            return validationResult.error;
        }
        const configurationMessage =
            validationResult.result as ConfigurationMessage;

        this.clientConfiguration = configurationMessage;
        return this.write(
            JSON.stringify(this.clientConfiguration.response()) + '\n',
        );
    }

    private async handleAuthorizationMessage(
        parsedMessage: StratumBaseMessage,
    ) {
        const validationResult = await this.validateMessage(
            parsedMessage,
            AuthorizationMessage,
        );
        if (hasValue(validationResult.error)) {
            console.error('Invalid authorization message');
            return validationResult.error;
        }
        const authorizationMessage =
            validationResult.result as AuthorizationMessage;

        this.clientAuthorization = authorizationMessage;
        return this.write(
            JSON.stringify(this.clientAuthorization.response()) + '\n',
        );
    }

    private async handleSubmitMessage(parsedMessage: StratumBaseMessage) {
        const validationResult = await this.validateMessage(
            parsedMessage,
            MiningSubmitMessage,
        );
        if (hasValue(validationResult.error)) {
            console.error('Invalid mining submit message');
            return validationResult.error;
        }
        const miningSubmitMessage =
            validationResult.result as MiningSubmitMessage;

        console.log('configuration: ', this.clientConfiguration);

        if (
            this.clientConfiguration?.versionRolling !=
            hasValue(miningSubmitMessage.versionMask)
        ) {
            // If version rolling is enabled, the version mask is required
            // If version rolling is disabled, the version mask is not allowed
            const err = new StratumErrorMessage(
                miningSubmitMessage.id,
                eStratumErrorCode.OtherUnknown,
                !hasValue(miningSubmitMessage.versionMask)
                    ? 'Version mask is required for version rolling'
                    : 'Version mask is not allowed',
            ).response();
            await this.write(err);
            return false;
        }

        const result = await this.handleMiningSubmission(miningSubmitMessage);
        if (result === false) {
            return false;
        }
        return this.write(
            JSON.stringify(miningSubmitMessage.response()) + '\n',
        );
    }

    private async initStratum() {
        console.log('Initializing stratum');
        console.log('oooooooooooooooooooooooooo');
        assert(
            hasValue(this.clientSubscription),
            'Client subscription is null',
        );
        assert(
            hasValue(this.clientAuthorization),
            'Client autorization is null',
        );

        this.stratumInitialized = true;

        console.log('user agent: ', this.clientSubscription.userAgent);
        const cluster = this.configService.get<string>(
            'SOLANA_CLUSTER',
            'devnet',
        );

        const rawDifficulty = this.configService.get<number>(
            'COMPTOKEN_DIFFICULTY',
            cluster === 'mainnet-beta' ? 0x180eadd8 : 0x200eadd8, // default based on cluster
        );
        console.log('Raw difficulty: ', rawDifficulty);
        const sessionDifficulty =
            this.stratumV1JobsService.calculateNetworkDifficulty(rawDifficulty);

        const setDifficulty = JSON.stringify(
            new SuggestDifficulty().response(sessionDifficulty),
        );
        console.log('Setting difficulty to: ', setDifficulty);
        const success = await this.write(setDifficulty + '\n');
        if (!success) {
            return;
        }

        this.stratumSubscription =
            this.stratumV1JobsService.newMiningJob$.subscribe(
                async (jobTemplate) => {
                    try {
                        await this.sendNewMiningJob(jobTemplate);
                    } catch (e) {
                        await this.socket.end();
                        console.error(e);
                    }
                },
            );
    }

    private async sendNewMiningJob(jobTemplate: IJobTemplate) {
        console.log('Sending new job');
        console.log(jobTemplate);

        const job = this.stratumV1JobsService.addJob(jobTemplate);

        const success = await this.write(job.response(jobTemplate));
        if (!success) {
            return;
        }
    }

    private async handleMiningSubmission(submission: MiningSubmitMessage) {
        assert(
            hasValue(this.clientAuthorization),
            'Client authorization is null',
        );
        if (!hasValue(this.entity)) {
            if (!hasValue(this.creatingEntity)) {
                this.creatingEntity = new Promise(async (resolve, reject) => {
                    try {
                        assert(hasValue(this.extraNonceAndSessionId));
                        assert(hasValue(this.clientAuthorization));
                        assert(hasValue(this.clientSubscription));
                        this.entity = await this.clientService.insert({
                            sessionId: this.extraNonceAndSessionId ?? undefined,
                            address: this.clientAuthorization.address,
                            clientName: this.clientAuthorization.worker,
                            userAgent: this.clientSubscription.userAgent,
                            startTime: new Date(),
                            bestDifficulty: 0,
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
        if (!hasValue(job)) {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.JobNotFound,
                'Job not found',
            ).response();
            await this.write(err);
            return false;
        }
        const jobTemplate = this.stratumV1JobsService.getJobTemplateById(
            job.jobTemplateId,
        );
        assert(hasValue(jobTemplate), 'Job template not found');

        const xhashbuf = Buffer.from(
            jobTemplate.block.coinbasePart1 +
                this.extraNonceAndSessionId +
                submission.extraNonce2 +
                jobTemplate.block.coinbasePart2,
            'hex',
        );
        const extraDataHashed = this.doubleSHA256(xhashbuf);
        let version = jobTemplate.block.version;
        if (
            hasValue(this.clientConfiguration) &&
            this.clientConfiguration.versionRolling
        ) {
            // this is checked in the message handler, but we assert here again for type safety
            assert(
                hasValue(submission.versionMask),
                'Version mask is required for version rolling',
            );
            const versionMask = parseInt(submission.versionMask, 16);
            // Ensure that the version mask only contains bits that are allowed to be changed
            if (
                (versionMask & ~this.clientConfiguration.versionRollingMask) !=
                0
            ) {
                const err = new StratumErrorMessage(
                    submission.id,
                    eStratumErrorCode.OtherUnknown,
                    'Invalid version mask',
                ).response();
                return this.write(err);
            }
            version |= versionMask;
        }

        const FEE = this.configService.get<number>(
            'FEE',
            1_00, // 1% of 100_00 COMP
        );
        assert(0 <= FEE && FEE <= 100_00, 'FEE must be between 0 and 100_00');
        const mintComptokensResult = await this.comptoRpcService.submitProof(
            extraDataHashed,
            parseInt(submission.nonce, 16),
            version,
            parseInt(submission.ntime, 16),
            new PublicKey(this.clientAuthorization.address),
            FEE,
        );

        if (hasValue(mintComptokensResult.error)) {
            switch (mintComptokensResult.error) {
                case 'Difficulty too low': {
                    const err = new StratumErrorMessage(
                        submission.id,
                        eStratumErrorCode.LowDifficultyShare,
                        'Difficulty too low',
                    ).response();
                    const success = await this.write(err);
                    if (!success) {
                        return false;
                    }
                    return false;
                }
                default: {
                    console.error(
                        `Error mining comptokens: ${mintComptokensResult.error}`,
                    );
                    const err = new StratumErrorMessage(
                        submission.id,
                        eStratumErrorCode.OtherUnknown,
                        'Error mining comptokens',
                    ).response();
                    const success = await this.write(err);
                    if (!success) {
                        return false;
                    }
                    return false;
                }
            }
        }

        console.log(
            '==================================================================================',
        );
        console.log(
            `mintComptokens transaction confirmed: ${mintComptokensResult.result}`,
        );
        console.log(
            '==================================================================================',
        );

        //await this.checkDifficulty();
        return true;
    }

    private doubleSHA256(data: Buffer): Buffer {
        const firstHash = crypto.createHash('sha256').update(data).digest();
        const secondHash = crypto
            .createHash('sha256')
            .update(firstHash)
            .digest();
        return secondHash;
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
                console.error(
                    `Error: Cannot write to closed or ended socket. ${this.extraNonceAndSessionId} ${message}`,
                );
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
            console.error(
                `Error occurred while writing to socket: ${this.extraNonceAndSessionId}`,
                error,
            );
            return false;
        }
    }
}
