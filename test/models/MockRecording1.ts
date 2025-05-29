import { IComptoBlockTemplate } from '../../src/models/compto-rpc/ComptoBlockTemplate';

export class MockRecording1 {
    public static EXTRA_NONCE = `57a6f098`;
    public static MINING_SUBSCRIBE = `{"id": 1, "method": "mining.subscribe", "params": ["bitaxe v2.2"]}\n`;
    public static MINING_CONFIGURE = `{"id": 2, "method": "mining.configure", "params": [["version-rolling"], {"version-rolling.mask": "ffffffff"}]}\n`;
    public static MINING_AUTHORIZE = `{"id": 3, "method": "mining.authorize", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "x"]}\n`;
    public static MINING_SUGGEST_DIFFICULTY = `{"id": 4, "method": "mining.suggest_difficulty", "params": [512]}\n`;
    public static TIME = '64b3f3ec';
    public static BLOCK_TEMPLATE: IComptoBlockTemplate = {
        //capabilities: ['proposal'],
        version: 536870912,
        //rules: ['csv', '!segwit', 'taproot'],
        //vbavailable: {},
        //vbrequired: 0,
        //previousblockhash:
        coinbasePart1: '',
        coinbasePart2: '',
        currentblockhash:
            '00000000000000022246451e9af7ac4f8bff2527d223f6e623740e92171592f2',
        transactions: [],
        //coinbaseaux: {},
        //coinbasevalue: 2465717,
        //longpollid:
        //'00000000000000022246451e9af7ac4f8bff2527d223f6e623740e92171592f29370',
        //target: '000000000000002495f800000000000000000000000000000000000000000000',
        //mintime: 1689512405,
        //mutable: ['time', 'transactions', 'prevblock'],
        //noncerange: '00000000ffffffff',
        //sigoplimit: 80000,
        //sizelimit: 4000000,
        //weightlimit: 4000000,
        //curtime: 1689514989,
        timestamp: parseInt(this.TIME, 16),
        bits: '192495f8',
        //height: 2442185,
        //default_witness_commitment:
        //'6a24aa21a9edbd3d1d916aa0b57326a2d88ebe1b68a1d7c48585f26d8335fe6a94b62755f64c',
    };
    public static MINING_SUBMIT = `{"id": 5, "method": "mining.submit", "params": ["tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4.bitaxe3", "2", "c7080000", "64b3f3ec", "ed460d91", "00002000"]}\n`;
}
