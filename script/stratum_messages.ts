type StratumBaseMessage<Method extends string, Params extends any[] = any[]> = {
    id: number | null;
    method: Method;
    params: Params;
};

type StratumBaseResponse<Result = unknown> = {
    id: number | null;
} & (
    | {
          result: Result;
          error: null;
      }
    | {
          result: null;
          error: [number, string, unknown | null];
      }
);

// -----------------------------
// mining.subscribe
// -----------------------------
type StratumSubscribeMessage = StratumBaseMessage<
    'mining.subscribe',
    [name: string, sessionId: string | null]
>;
type StratumSubscribeResponse = StratumBaseResponse<
    [
        _: [_: 'mining.notify', sessionId: string],
        sessionId: string,
        extraNonce2Size: number,
    ]
>;

export function createSubscribeMessage(
    name: string,
    prevSessionId: string | null = null,
    id = 1,
) {
    return JSON.stringify({
        id,
        method: 'mining.subscribe',
        params: [name, prevSessionId],
    } as StratumSubscribeMessage);
}

export function parseSubscribeResponse(message: string) {
    const response = JSON.parse(message) as StratumSubscribeResponse;
    if (response.error !== null) {
        throw new Error(`Subscribe error: ${JSON.stringify(response.error)}`);
    }
    return {
        id: response.id,
        sessionId: response.result[1],
        extraNonce2Size: response.result[2],
    };
}

// -----------------------------
// mining.configure
// -----------------------------
type StratumConfigureMessage = StratumBaseMessage<
    'mining.configure',
    [extensions: string[], extensionParams: Record<string, unknown>]
>;
type StratumConfigureResponse = StratumBaseResponse<Record<string, unknown>>;

export function createConfigureMessage(
    extensions: string[],
    extensionParams: Record<string, unknown>,
    id = 2,
) {
    return JSON.stringify({
        id,
        method: 'mining.configure',
        params: [extensions, extensionParams],
    } as StratumConfigureMessage);
}

export function parseConfigureResponse(message: string) {
    const response = JSON.parse(message) as StratumConfigureResponse;
    if (response.error !== null) {
        throw new Error(`Configure error: ${JSON.stringify(response.error)}`);
    }
    return {
        id: response.id,
        result: response.result,
    };
}

// -----------------------------
// mining.authorize
// -----------------------------
type StratumAuthorizeMessage = StratumBaseMessage<
    'mining.authorize',
    [workerName: string, workerPassword: string | null]
>;
type StratumAuthorizeResponse = StratumBaseResponse<boolean>;

export function createAuthorizeMessage(
    workerName: string,
    workerPassword: string | null = 'x',
    id = 3,
) {
    return JSON.stringify({
        id,
        method: 'mining.authorize',
        params: [workerName, workerPassword],
    } as StratumAuthorizeMessage);
}

export function parseAuthorizeResponse(message: string) {
    const response = JSON.parse(message) as StratumAuthorizeResponse;
    if (response.error !== null) {
        throw new Error(`Authorize error: ${JSON.stringify(response.error)}`);
    }
    return {
        id: response.id,
        authorized: response.result === true,
    };
}

// -----------------------------
// mining.submit
// -----------------------------
type SubmitParamsBase = [
    userId: string,
    jobId: string,
    extraNonce2: string,
    nTime: string,
    nonce: string,
];
type SubmitParamsWithVersionRolling = [
    userId: string,
    jobId: string,
    extraNonce2: string,
    nTime: string,
    nonce: string,
    versionSetBits: string,
];

type StratumSubmitMessage = StratumBaseMessage<
    'mining.submit',
    SubmitParamsBase | SubmitParamsWithVersionRolling
>;
type StratumSubmitResponse = StratumBaseResponse<boolean>;

export function createSubmitMessage(
    userId: string,
    jobId: string,
    extraNonce2: string,
    nTime: string,
    nonce: string,
    bitsSet?: string,
    id = 4,
) {
    const params: SubmitParamsBase | SubmitParamsWithVersionRolling =
        bitsSet !== undefined
            ? [userId, jobId, extraNonce2, nTime, nonce, bitsSet]
            : [userId, jobId, extraNonce2, nTime, nonce];

    return JSON.stringify({
        id,
        method: 'mining.submit',
        params,
    } as StratumSubmitMessage);
}

export function parseSubmitResponse(message: string) {
    const response = JSON.parse(message) as StratumSubmitResponse;
    if (response.error !== null) {
        throw new Error(`Submit error: ${JSON.stringify(response.error)}`);
    }
    return {
        id: response.id,
        accepted: response.result === true,
    };
}

// -----------------------------
// Server -> Client notifications
// -----------------------------
type StratumNotifyMessage = StratumBaseMessage<
    'mining.notify',
    [
        jobId: string,
        prevHash: string,
        coinbase1: string,
        coinbase2: string,
        merkleBranch: string[],
        version: string,
        nBits: string,
        nTime: string,
        clear: boolean | null,
    ]
>;

export function parseNotify(message: string) {
    const obj = JSON.parse(message) as StratumNotifyMessage;
    if (obj.method !== 'mining.notify') {
        throw new Error('Expected mining.notify message');
    }
    const [
        jobId,
        prevHash,
        coinbase1,
        coinbase2,
        merkleBranch,
        version,
        nBits,
        nTime,
        clear,
    ] = obj.params;
    return {
        id: obj.id,
        jobId,
        prevHash,
        coinbase1,
        coinbase2,
        merkleBranch,
        version,
        nBits,
        nTime,
        clear: clear ?? false,
    };
}

type StratumSetVersionMaskMessage = StratumBaseMessage<
    'mining.set_version_mask',
    [string]
>;

export function parseSetVersionMask(message: string) {
    const obj = JSON.parse(message) as StratumSetVersionMaskMessage;
    if (obj.method !== 'mining.set_version_mask') {
        throw new Error('Expected mining.set_version_mask message');
    }
    const [mask] = obj.params;
    return { id: obj.id, mask };
}
