
export interface IComptoBlockTemplate {
    // (json object)
    version: number;                       // (numeric) The preferred block version
    currentblockhash: string,             // (string) The hash of current highest block
    transactions: string[],                // (string) zero bitcoin compatibility placeholder
    bits: string,                          // (string) compressed target of next block
    timestamp: number,                     // (numeric) current timestamp in UNIX epoch time
}

// needed            version: blockTemplate.version,
// needed            bits: parseInt(blockTemplate.bits, 16),
// needed            prevHash: this.convertToLittleEndian(blockTemplate.previousblockhash),
// needed            transactions: blockTemplate.transactions.map(t => bitcoinjs.Transaction.fromHex(t.data)),
// not needed            coinbasevalue: blockTemplate.coinbasevalue,
// calculated            timestamp: Math.floor(new Date().getTime() / 1000),
// calculated            networkDifficulty: this.calculateNetworkDifficulty(parseInt(blockTemplate.bits, 16)),
// sure            clearJobs,
// not needed            height: blockTemplate.height