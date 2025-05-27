import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import * as crypto from 'crypto';
import { Socket } from 'net';
import { firstValueFrom, Subscription } from 'rxjs';
import { clearInterval } from 'timers';

import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { ComptoRpcService } from '../services/compto-rpc.service';
import {
    IJobTemplate,
    StratumV1JobsService,
} from '../services/stratum-v1-jobs.service';
import { eRequestMethod } from './enums/eRequestMethod';
import { eResponseMethod } from './enums/eResponseMethod';
import { eStratumErrorCode } from './enums/eStratumErrorCode';
import { MiningJob } from './MiningJob';
import { AuthorizationMessage } from './stratum-messages/AuthorizationMessage';
import { ConfigurationMessage } from './stratum-messages/ConfigurationMessage';
import { MiningSubmitMessage } from './stratum-messages/MiningSubmitMessage';
import { StratumBaseMessage } from './stratum-messages/StratumBaseMessage';
import { StratumErrorMessage } from './stratum-messages/StratumErrorMessage';
import { SubscriptionMessage } from './stratum-messages/SubscriptionMessage';
import { SuggestDifficulty } from './stratum-messages/SuggestDifficultyMessage';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';

export class StratumV1Client {
    private clientSubscription: SubscriptionMessage | null = null;
    private clientConfiguration: ConfigurationMessage | null = null;
    private clientAuthorization: AuthorizationMessage | null = null;
    private clientSuggestedDifficulty: SuggestDifficulty | null = null;
    private stratumSubscription: Subscription | null = null;
    private backgroundWork: NodeJS.Timeout[] = [];

    private statistics: StratumV1ClientStatistics | null = null;
    private stratumInitialized = false;
    private sessionDifficulty: number = 16384;

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
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly comptoRpcService: ComptoRpcService,
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
        if (this.extraNonceAndSessionId) {
            await this.clientService.delete(this.extraNonceAndSessionId);
        }

        if (this.stratumSubscription != null) {
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
                    plainToInstance(ConfigurationMessage, parsedMessage),
                );
                if (!success) {
                    return;
                }
                break;
            }
            case eRequestMethod.AUTHORIZE: {
                const success = await this.handleAuthorizationMessage(
                    plainToInstance(AuthorizationMessage, parsedMessage),
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

                const success = await this.handleSubmitMessage(
                    plainToInstance(MiningSubmitMessage, parsedMessage),
                );
                if (!success) {
                    return;
                }
                break;
            }
        }

        if (
            this.clientSubscription != null &&
            this.clientAuthorization != null &&
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
        if (validationResult.error) {
            console.error('Invalid subscription message');
            return validationResult.error;
        }
        const subscriptionMessage =
            validationResult.result as SubscriptionMessage;

        if (this.sessionStart == null) {
            this.sessionStart = new Date();
            this.statistics = new StratumV1ClientStatistics(
                this.clientStatisticsService,
            );
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
        if (validationResult.error) {
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
        if (validationResult.error) {
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
        if (validationResult.error) {
            console.error('Invalid mining submit message');
            return validationResult.error;
        }
        const miningSubmitMessage =
            validationResult.result as MiningSubmitMessage;

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
        assert(this.clientSubscription != null, 'Client subscription is null');

        this.stratumInitialized = true;

        console.log('user agent: ', this.clientSubscription.userAgent);
        switch (this.clientSubscription.userAgent) {
            case 'cpuminer': {
                this.sessionDifficulty = 0.01;
            }
        }

        if (this.clientSuggestedDifficulty == null) {
            const setDifficulty = JSON.stringify(
                new SuggestDifficulty().response(this.sessionDifficulty),
            );
            console.log('Setting difficulty to: ', setDifficulty);
            const success = await this.write(setDifficulty + '\n');
            if (!success) {
                return;
            }
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

        this.backgroundWork.push(
            setInterval(async () => {
                await this.checkDifficulty();
            }, 60 * 1000),
        );
    }

    private async sendNewMiningJob(jobTemplate: IJobTemplate) {
        console.log('Sending new job');
        console.log(jobTemplate);

        const job = new MiningJob(
            this.stratumV1JobsService.getNextId(),
            jobTemplate,
        );

        this.stratumV1JobsService.addJob(job);

        const success = await this.write(job.response(jobTemplate));
        if (!success) {
            return;
        }
    }

    private async handleMiningSubmission(submission: MiningSubmitMessage) {
        if (this.entity == null) {
            if (this.creatingEntity == null) {
                this.creatingEntity = new Promise(async (resolve, reject) => {
                    try {
                        assert(this.extraNonceAndSessionId != null);
                        assert(this.clientAuthorization != null);
                        assert(this.clientSubscription != null);
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
        if (job == null) {
            const err = new StratumErrorMessage(
                submission.id,
                eStratumErrorCode.JobNotFound,
                'Job not found',
            ).response();
            const success = await this.write(err);
            if (!success) {
                return false;
            }
            return false;
        }
        const jobTemplate = this.stratumV1JobsService.getJobTemplateById(
            job.jobTemplateId,
        );
        assert(jobTemplate != null, 'Job template not found');

        const xhashbuf = Buffer.from(
            this.extraNonceAndSessionId + submission.extraNonce2,
            'hex',
        );
        const extraDataHashed = this.doubleSHA256(xhashbuf);
        const versionBuffer = Buffer.alloc(4);
        versionBuffer.writeUInt32LE(jobTemplate.block.version);

        const mintComptokensResult = await this.comptoRpcService.mineComptokens(
            extraDataHashed,
            parseInt(submission.nonce, 16),
            jobTemplate.block.version,
            parseInt(submission.ntime, 16),
        );

        if (mintComptokensResult.error != null) {
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

    private async checkDifficulty() {
        assert(
            this.statistics != null,
            'Statistics service is not initialized',
        );
        const targetDiff = this.statistics.getSuggestedDifficulty(
            this.sessionDifficulty,
        );
        if (targetDiff == null) {
            return;
        }

        if (targetDiff != this.sessionDifficulty) {
            this.sessionDifficulty = targetDiff;

            const data =
                JSON.stringify({
                    id: null,
                    method: eResponseMethod.SET_DIFFICULTY,
                    params: [targetDiff],
                }) + '\n';

            await this.socket.write(data);
            console.log('start to await newMiningJob$.');
            const jobTemplate = await firstValueFrom(
                this.stratumV1JobsService.newMiningJob$,
            );
            console.log('finish await newMiningJob$');
            // we need to clear the jobs so that the difficulty set takes effect. Otherwise the different miner implementations can cause issues
            jobTemplate.blockData.clearJobs = true;
            await this.sendNewMiningJob(jobTemplate);
        }
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

// for some reason importing 'assert' from 'node:assert' isn't working
function assert(condition: any, message?: string): asserts condition {
    if (!condition) {
        throw new Error(message || 'Assertion failed');
    }
}
