import { ComptokenProof } from '@compto/comptoken.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import {
    createAuthorizeMessage,
    createConfigureMessage,
    createSubmitMessage,
    createSubscribeMessage,
    parseAuthorizeResponse,
    parseConfigureResponse,
    parseNotify,
    parseSetVersionMask,
    parseSubmitResponse,
    parseSubscribeResponse,
} from './stratum_messages';

type PendingResolver = (msg: any) => void;

function hexLEFromNumber(n: number, bytes = 4) {
    const buf = Buffer.alloc(bytes);
    buf.writeUIntLE(n, 0, bytes);
    return buf.toString('hex');
}

// helpers removed if unused

async function getUserKeypair(): Promise<Keypair> {
    const raw = fs.readFileSync('solana-user-keypair.json', 'utf-8');
    const secret = Buffer.from(JSON.parse(raw));
    return Keypair.fromSecretKey(secret);
}

function applyVersionRolling(baseVersionHex: string, maskHex: string) {
    const baseVersion = parseInt(baseVersionHex, 16);
    const mask = parseInt(maskHex, 16);

    // choose lowest 2 set bits from mask to set in version
    let bitsSet = 0;
    let count = 0;
    for (let i = 0; i < 32; i++) {
        if ((mask & (1 << i)) !== 0) {
            bitsSet |= 1 << i;
            count++;
            if (count >= 2) break;
        }
    }
    const version = baseVersion | bitsSet;
    return {
        bitsSet,
        version,
    };
}

function doubleSHA256(data: Buffer): Buffer {
    const firstHash = createHash('sha256').update(data).digest();
    const secondHash = createHash('sha256').update(firstHash).digest();
    return secondHash;
}

function handleNotify(
    rawMsg: any,
    versionRollingMask: string,
    extraNonce2Size: number,
    sessionId: string,
    nextId: number,
) {
    const notifyStr = JSON.stringify(rawMsg);
    const notify = parseNotify(notifyStr);
    console.log('Received notify job:', notify.jobId);

    // base version provided by server is little-endian hex string
    const baseVersionHexLE = notify.version.toLowerCase();
    const { bitsSet, version } = applyVersionRolling(
        baseVersionHexLE,
        versionRollingMask,
    );

    console.log('Version rolling:', { bitsSet, version });

    // recentBlockHash is provided as big-endian hex; convert to bytes
    const recentBlockHashBE = notify.prevHash.toLowerCase();
    const recentBlockHash = Buffer.from(recentBlockHashBE, 'hex')
        .reverse()
        .swap32();

    // prepare submit params
    const extraNonce2 = hexLEFromNumber(
        Math.floor(Math.random() * 0xffffffff), // Math.random is not ideal for real mining but fine for testing
        extraNonce2Size,
    );

    // extraData: use miner's pubkey bytes
    const xhashbuf = Buffer.from(
        notify.coinbase1 + sessionId + extraNonce2 + notify.coinbase2,
        'hex',
    );
    const extraData = doubleSHA256(xhashbuf);

    // timestamp from server nTime is little-endian hex; convert to number
    const timestamp = parseInt(notify.nTime, 16);

    const pubkey = new PublicKey(Buffer.from(notify.merkleBranch[0], 'hex')); // use first merkle branch entry as pubkey for mining

    console.log(
        'Mining with params:',
        {
            pubkey: pubkey.toBuffer().toString('hex'),
            recentBlockHash: recentBlockHash.toString('hex'),
            extraData: extraData.toString('hex'),
            version: version.toString(16),
            timestamp: timestamp.toString(16),
        },
        'and version-rolling bits set:',
        bitsSet.toString(16),
    );

    // mine proof starting at nonce 0
    const proof = ComptokenProof.mine({
        pubkey,
        recentBlockHash: recentBlockHash,
        extraData: extraData,
        version,
        timestamp,
        startNonce: 0,
    });
    console.log('Mined nonce:', proof.nonce.toString(16));
    console.log('Proof header:', Buffer.from(proof.header).toString('hex'));
    console.log('Proof hash:', Buffer.from(proof.hash).toString('hex'));

    const nTime = notify.nTime; // reuse server-provided nTime

    const submitStr = createSubmitMessage(
        'worker1',
        notify.jobId,
        extraNonce2,
        nTime,
        proof.nonce.toString(16).padStart(8, '0'),
        bitsSet.toString(16),
        nextId++,
    );
    return {
        submitStr,
        nextId,
    };
}

async function run() {
    const socket = createConnection({ host: '127.0.0.1', port: 3333 });

    const keypair = await getUserKeypair();

    let versionRollingMask = '1fffe000'; // default; server may override
    let extraNonce2Size = 4;
    let sessionId = 'DEADBEEF'; // placeholder until subscribe response

    let nextId = 1;
    const send = (json: string) => socket.write(json + '\n');

    const pending: Record<number, PendingResolver> = {};

    // simple id tracking via pending resolvers

    let buffer = '';
    socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const parts = buffer.split('\n');
        // keep last partial if not ending with newline
        buffer = parts.pop() ?? '';
        for (const part of parts) {
            if (!part.trim()) continue;
            try {
                const msg = JSON.parse(part);
                // responses have id; notifications have method
                if ('id' in msg && pending[msg.id]) {
                    pending[msg.id](msg);
                    delete pending[msg.id];
                } else if (msg.method === 'mining.notify') {
                    const { submitStr, nextId: newNextId } = handleNotify(
                        msg,
                        versionRollingMask,
                        extraNonce2Size,
                        sessionId,
                        nextId++,
                    );
                    nextId = newNextId;
                    send(submitStr);
                    new Promise<any>((resolve) => {
                        pending[nextId - 1] = resolve;
                    }).then((submitResponse) => {
                        const parsed = parseSubmitResponse(
                            JSON.stringify(submitResponse),
                        );
                        console.log('Submit accepted:', parsed.accepted);
                        if (!parsed.accepted) {
                            console.log('Submit rejected:', submitResponse);
                        }
                    });
                } else if (msg.method === 'mining.set_version_mask') {
                    const parsed = parseSetVersionMask(part);
                    versionRollingMask = parsed.mask.toLowerCase();
                    console.log(
                        'Updated version-rolling mask:',
                        versionRollingMask,
                    );
                } else {
                    console.log('Unhandled message:', msg);
                }
            } catch (e) {
                console.error('Failed to parse message:', e);
            }
        }
    });

    socket.on('connect', async () => {
        console.log('Connected to stratum at localhost:3333');
        // 1) subscribe
        const subscribeStr = createSubscribeMessage(
            'ComptoMiner/0.1',
            null,
            nextId++,
        );
        send(subscribeStr);
        const subResponse = await new Promise<any>((resolve) => {
            pending[nextId - 1] = resolve;
        });
        const { sessionId: sId, extraNonce2Size: en2 } = parseSubscribeResponse(
            JSON.stringify(subResponse),
        );
        sessionId = sId;
        extraNonce2Size = en2;
        console.log(
            'Subscribed. sessionId:',
            sessionId,
            'extraNonce2Size:',
            extraNonce2Size,
        );

        // 2) configure version-rolling
        const configureStr = createConfigureMessage(
            ['version-rolling'],
            {
                'version-rolling.mask': versionRollingMask,
                'version-rolling.min-bit-count': 2,
            },
            nextId++,
        );
        send(configureStr);
        const cfgResponse = await new Promise<any>((resolve) => {
            pending[nextId - 1] = resolve;
        });
        const cfgParsed = parseConfigureResponse(JSON.stringify(cfgResponse));
        const maskFromServer = (
            cfgParsed.result['version-rolling.mask'] as string | undefined
        )?.toLowerCase();
        if (maskFromServer) {
            versionRollingMask = maskFromServer;
        }
        console.log('Configured version-rolling mask:', versionRollingMask);

        // 3) authorize
        const authorizeStr = createAuthorizeMessage(
            `${keypair.publicKey.toBase58()}.worker1`,
            'x',
            nextId++,
        );
        send(authorizeStr);
        const authResponse = await new Promise<any>((resolve) => {
            pending[nextId - 1] = resolve;
        });
        const { authorized } = parseAuthorizeResponse(
            JSON.stringify(authResponse),
        );
        console.log('Authorized:', authorized);
        if (!authorized) {
            console.error('Authorization failed.');
            socket.end();
            return;
        }
        console.log('Waiting for mining.notify...');
    });
}

run().catch((e) => {
    console.error('Fatal error:', e);
});
