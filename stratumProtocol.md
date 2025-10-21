the stratum protocol is a json-based message format for communicating between
crypto miners (esp. bitcoin) and mining pools.

a stratum message consists of a json object followed by a newline. the fields of
the json object depend on the specific type of message, but most (all?) messages
follow a few standard formats.

newlines in examples for legibility.

a request message consists of

-   id: `int | null`- id for a specific message, increments per message
-   method: `string` - a method dependent string that indicates what kind of
    message this is
-   params: `array` - a json array of the method dependent params

```json
{
    "id": null,
    "method": "mining.subscribe",
    "params": ["MyMiner/1.0.0", null, "my.pool.com", 1234]
}\n
```

a response message consists of

-   id: integer - id for a specific message, increments per message

and either

-   error: [errorCode, errorMessage, data]
    -   errorCode: `int` - a code for the error see [Error Codes](#Error-Codes)
    -   errorMessage: `string` - concise human readable description of the error
    -   data: `object | null` - additional information
-   result: `null`

or

-   error: `null`
-   result: `any` - method dependent result field

```json
{
    "id": 2,
    "error": [20, "Other/Unknown", null],
    "result": null
}\n

{
    "id": 4,
    "error": null,
    "result": true
}\n
```

# Client -> Server Methods

## mining.subscribe

initiate or resume a session with the server

### request

-   method: "mining.subscribe"
-   params:
    -   name: `string` - name of software / version e.g. "MyMiner/1.0.0"
    -   sessionId: `string | null` - sessionId of previous session if applicable

```json
{
    "id": 1,
    "method": "mining.subscribe",
    "params": ["MyMiner/1.0.0", null]
}\n
```

### response

-   result: [sessionId, extraNonce2_size]
    -   sessionId: `string` - unique session Id
    -   extraNonce2_size: `int` - number of bytes the miner should use for it's extraNonce2
        counter

```json
{
    "id": 2,
    "error": null,
    "result": ["DEADBEEF", 4]
}\n
```

## mining.configure

configure [extensions](#Extensions), must be 2nd call (after subscribe)

### request

-   method: "mining.configure"
-   params: [extensions, extensionParams]
    -   extensions: `ExtensionCode[]` - list of extension codes the miner supports
    -   extensionParams: `Map<string, any>` - map of extension param names to values

```json
{
    "id": 3,
    "method": "mining.configure",
    "params": [
        ["version-rolling"],
        {
            "version-rolling.mask": "1fffe000",
            "version-rolling.min-bit-count": 2
        }
    ]
}\n
```

### response

-   result: `Map<string, any>` - map of `ExtensionCode`s to `ExtensionResult`s
    and extension specific additional key-values

```json
{
    "id": 4,
    "error": null,
    "result": {
        "version-rolling": true,
        "version-rolling.mask": "1fffe000"
    }
}\n
```

## mining.authorize

authorize a worker to submit on behalf of a miner

### Request

-   method: 'mining.authorize'
-   params: [workerName, workerPassword]
    -   workerName: string - name for the worker, in the form `<address>.<userId>`
        -   address - address of the wallet to receive funds
        -   userId - unique name for a worker
    -   password: string | null - password for closed pool verification often
        ommitted, ignored, or just `"x"` for open pools

```json
{
    "id": 5,
    "method": "mining.authorize",
    "params": ["1BCLEbbsG66y53LWNr5wqarh2JatCEsu6h.worker1", "x"]
}\n
```

## mining.submit

submit solutions

### Request

-   method: "mining.submit"
-   params: [userId, jobId, extraNonce2, nTime, nonce]
    -   userId: string - userId from authorization
    -   jobId: string - unique jobId associated with this problem
    -   extraNonce2: string - little-endian hex-encoded miner generated extraNonce2.
    -   nTime: string - little-endian hex-encoded nTime field used to create PoW
    -   nonce: string - little-endian hex-encoded miner generated nonce value

```json
{
    "id": 7,
    "method": "mining.submit",
    "params": ["worker1", "DEADBEEF", "CAFEBABE", "68365200", "FEEDFACE"]
}\n
```

### Response

-   result: boolean - whether authorization succeeded

```json
{
    "id": 6,
    "error": null,
    "result": true
}\n
```

# Server -> Client Methods

## mining.notify

-   method: "mining.notify"
-   params: [jobId, coinbase1, coinbase2, merkleBranch, version, nBits, nTime, clear]
    -   jobId: string - the id of this job
    -   prevHash: string - hash of the previous block
    -   coinbase1: string - 1st part of the coinbase transaction (precedes extraNonce2)
    -   coinbase2: string - 2nd part of the coinbase transaction (follows extraNonce2)
    -   merkleBranch: string[] - list of merkle hashes
    -   version: string - little-endian hex-encoded version
    -   nBits: string - little-endian hex-encoded difficulty
    -   nTime: string - little-endian hex-encoded timestamp. can be rolled, but
        should not increase faster than actual time
    -   clear: boolean | null - if true, prior jobs are invalidated and solutions
        will be rejected

```json
{
    "id": 6,
    "method": "mining.notify",
    "params": [
        "DEADBEEF",
        "0000000000000000000112da220a0f10e12663eb1f2c5e3848a5e654e7a6ae7f",
        "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff20020862062f503253482f04b8864e5008",
        "072f736c7573682f000000000100f2052a010000001976a914d23fcdf86f7e756a64a7a9688ef9903327048ed988ac00000000",
        [],
        "00000002",
        "180eadd8",
        "68365200",
        true
    ]
}\n
```

# -

## Error Codes <a name=Error-Codes></a>

[JSON RPC 2.0](https://www.jsonrpc.org/specification#error_object)
error codes and

-   20: Other/Unknown
-   21: Job not found (=stale)
-   22: Duplicate share
-   23: Low difficulty share
-   24: Unauthorized worker
-   25: Not subscribed

## Extensions <a name=Extensions></a>

### Version Rolling

#### Configure Request Params

-   extensionCode: "version-rolling"
-   extensionParams:
    -   "version-rolling.mask": string | null - little-endian hex-encoded mask for
        bytes the miner can 'roll'. defaults to `FFFFFFFF`
    -   "version-rolling.min-bit-count": number | null - minimum number of bits
        the miner needs for efficient rolling. does not _need_ to be honored

```json
{
    "id": 3,
    "method": "mining.configure",
    "params": [
        ["version-rolling"],
        {
            "version-rolling.mask": "FFF0A000",
            "version-rolling.min-bit-count": 2
        }
    ]
}\n
```

#### Configure Response

-   version-rolling.mask: string - little-endian hex-encoded mask of bytes the
    miner is allowed to roll

```json
{
    "id": 4,
    "error": null,
    "result": {
        "version-rolling": true,
        "version-rolling.mask": "1FF0A000"
    }
}\n
```

#### Changes to mining.submit

mining.submit requests for clients with version-rolling include an additional (6th)
parameter, bitsSet

-   bitsSet: string - little-endian hex-encoded string of version bits the miner
    has set. (bitsSet & ~mask) must equal 0

#### mining.set_version_mask

server notifies the miner about a new mask, valid _immediately_

-   params: [mask]
    -   mask: string - little-endian hex-encoded new mask

```json
{
    "id": 7,
    "method": "mining.set_version_mask",
    "params": ["1FFFE000"]
}\n
```
