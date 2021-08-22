// file to load well known addresses into local environment

const commander = require('commander');

const Token = require("@solana/spl-token").Token;
const TOKEN_PROGRAM_ID = require("@solana/spl-token").TOKEN_PROGRAM_ID;
const TokenInstructions = require("@project-serum/serum").TokenInstructions;
const DexInstructions = require("@project-serum/serum").DexInstructions;
const Market = require("@project-serum/serum").Market;
const web3 = require("@project-serum/anchor").web3;
const Connection = web3.Connection;
const Account = web3.Account;
const anchor = require("@project-serum/anchor");
const Keypair = web3.Keypair;
const BN = require("@project-serum/anchor").BN;
const serumCmn = require("@project-serum/common");
const Transaction = web3.Transaction;
const PublicKey = web3.PublicKey;
const SystemProgram = web3.SystemProgram;
const OpenOrders = require("@project-serum/serum").OpenOrders;
const fs = require('fs');
const homedir = require('os').homedir();
const DEX_PID = getPID(homedir + '/.stoploss-config/dex-program-address');
const SL_PID = getPID(homedir + '/.stoploss-config/stoploss-program-address');
const url = 'http://localhost:8899';


const program = getArgs();

function getPID(file) {
    let f = fs.readFileSync(file, 'utf8');
    if (f) {
        console.log("found PID " + f + " in file " + file);
    } else {
        console.log("Unable to find file, check that deploy script has run and that PID is in " + file + " also check that a local validator is running...");
    }
    return new PublicKey(f);
}

function getArgs() {
    const program = new commander.Command();
    program
        .usage('[options]')
        .option('--listmarket <token-names...>', 'creates new market using token names provided, ie <base> and <quote>, eg --list-market BTC USD')
        .option('--readpid <file>', 'reads a pid')
        .parse(process.argv);
    //console.log(program);
    return program;
}

async function run() {

    if (program.opts().listmarket) {

        await listMarket(program.opts().listmarket);

    } else if (program.opts().readpid) {

        await getPID(program.opts().readpid);

    }
};

async function getPayer(file) {
    payer = await new Account(
        Buffer.from(
            JSON.parse(
                require("fs").readFileSync(
                    require("os").homedir() + file,
                    {
                        encoding: "utf-8",
                    }
                )
            )
        )
    );
    return payer;
}


function readAccount(name, file) {
    let filename = file + name + '.json';
    let data = fs.readFileSync(filename, 'utf8');
    let json = JSON.parse(data);
    return getAccount(json.secretKey);
}

async function getAccount(secretKey) {
    let account = await new Account(
        Buffer.from(
            JSON.parse("[" + secretKey + "]")
        )
    );
    return account;
}



async function createMintAndWallet(provider, amount, owner, decimals, connection) {
    const mint = new Account();
    const vault = new Account();
    const tx = new Transaction();

    tx.add(SystemProgram.createAccount({
        fromPubkey: provider.publicKey,
        newAccountPubkey: mint.publicKey,
        space: 82,
        lamports: await connection.getMinimumBalanceForRentExemption(82),
        programId: TokenInstructions.TOKEN_PROGRAM_ID,
    }), TokenInstructions.initializeMint({
        mint: mint.publicKey,
        decimals: decimals !== null && decimals !== void 0 ? decimals : 0,
        mintAuthority: provider.publicKey,
    }), SystemProgram.createAccount({
        fromPubkey: provider.publicKey,
        newAccountPubkey: vault.publicKey,
        space: 165,
        lamports: await connection.getMinimumBalanceForRentExemption(165),
        programId: TokenInstructions.TOKEN_PROGRAM_ID,
    }), TokenInstructions.initializeAccount({
        account: vault.publicKey,
        mint: mint.publicKey,
        owner: provider.publicKey,
    }), TokenInstructions.mintTo({
        mint: mint.publicKey,
        destination: vault.publicKey,
        amount,
        mintAuthority: provider.publicKey,
    }));

    let blockhash = (await connection.getRecentBlockhash('max')).blockhash;
    tx.recentBlockhash = blockhash;
    tx.setSigners(provider.publicKey, mint.publicKey, vault.publicKey);
    tx.feePayer = provider.publicKey;
    tx.sign(provider, mint, vault);

    const txid1 = await connection.sendRawTransaction(
        tx.serialize(),
        {
            skipPreflight: true,
        }
    );
    await connection.confirmTransaction(txid1, 'processed');

    //console.log("ADDED TOKEN", vault);
    return mint;
}


async function listMarket(markets) {
    const connection = new Connection(url, 'processed');
    const payer = await getPayer('/.config/solana/id.json');

    const baseMint = await createMintAndWallet(payer, new BN(1000000000), payer, 2, connection);
    const quoteMint = await createMintAndWallet(payer, new BN(1000000000), payer, 2, connection);

    const quoteLotSize = 10000;
    const baseLotSize = 10000;

    // create accounts for market
    const market = new Account();
    const requestQueue = new Account();
    const eventQueue = new Account();
    const bids = new Account();
    const asks = new Account();
    const baseVault = new Account();
    const quoteVault = new Account();
    const feeRateBps = 0;
    const quoteDustThreshold = new BN(100);

    async function getVaultOwnerAndNonce() {
        const nonce = new BN(0);
        while (true) {
            try {
                const vaultOwner = await PublicKey.createProgramAddress(
                    [market.publicKey.toBuffer(), nonce.toArrayLike(Buffer, 'le', 8)],
                    DEX_PID,
                );
                return [vaultOwner, nonce];
            } catch (e) {
                nonce.iaddn(1);
            }
        }
    }
    const [vaultOwner, vaultSignerNonce] = await getVaultOwnerAndNonce();

    // create market
    const tx1 = new Transaction();
    tx1.add(
        SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: baseVault.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(165),
            space: 165,
            programId: TOKEN_PROGRAM_ID,
        }),
        SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: quoteVault.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(165),
            space: 165,
            programId: TOKEN_PROGRAM_ID,
        }),
        TokenInstructions.initializeAccount({
            account: baseVault.publicKey,
            mint: baseMint.publicKey,
            owner: vaultOwner,
        }),
        TokenInstructions.initializeAccount({
            account: quoteVault.publicKey,
            mint: quoteMint.publicKey,
            owner: vaultOwner,
        }),
    );

    const blockhash = (await connection.getRecentBlockhash('max')).blockhash;
    tx1.recentBlockhash = blockhash;
    tx1.setSigners(payer.publicKey, baseVault.publicKey, quoteVault.publicKey);
    tx1.feePayer = payer.publicKey;
    // console.log("baseVault", baseVault.publicKey.toString());
    // console.log("quoteVault", quoteVault.publicKey.toString());
    tx1.sign(payer, baseVault, quoteVault);

    // console.log("vaultOwner", vaultOwner);

    const txid1 = await connection.sendRawTransaction(
        tx1.serialize(),
        {
            skipPreflight: true,
        },
    );
    // console.log("sent tx 1", txid1);
    let txres = await connection.confirmTransaction(txid1, 'processed');
    console.log("confirmed 1", txres);

    const tx2 = new Transaction();
    tx2.add(
        SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: market.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(
                Market.getLayout(DEX_PID).span,
            ),
            space: Market.getLayout(DEX_PID).span,
            programId: DEX_PID,
        }),
        SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: requestQueue.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(5120 + 12),
            space: 5120 + 12,
            programId: DEX_PID,
        }),
        SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: eventQueue.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(262144 + 12),
            space: 262144 + 12,
            programId: DEX_PID,
        }),
        SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: bids.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(65536 + 12),
            space: 65536 + 12,
            programId: DEX_PID,
        }),
        SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: asks.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(65536 + 12),
            space: 65536 + 12,
            programId: DEX_PID,
        }),
        DexInstructions.initializeMarket({
            market: market.publicKey,
            requestQueue: requestQueue.publicKey,
            eventQueue: eventQueue.publicKey,
            bids: bids.publicKey,
            asks: asks.publicKey,
            baseVault: baseVault.publicKey,
            quoteVault: quoteVault.publicKey,
            baseMint: baseMint.publicKey,
            quoteMint: quoteMint.publicKey,
            baseLotSize: new BN(baseLotSize),
            quoteLotSize: new BN(quoteLotSize),
            feeRateBps,
            vaultSignerNonce,
            quoteDustThreshold,
            programId: DEX_PID,
        }),
    );


    tx2.recentBlockhash = blockhash;
    tx2.setSigners(payer.publicKey, market.publicKey, requestQueue.publicKey, eventQueue.publicKey, bids.publicKey, asks.publicKey);
    tx2.feePayer = payer.publicKey;
    tx2.sign(payer, market, requestQueue, eventQueue, bids, asks);

    const txid2 = await connection.sendRawTransaction(
        tx2.serialize(),
        {
            skipPreflight: true,
        },
    );
    await connection.confirmTransaction(txid2, 'processed');

    console.log("market public key ", market.publicKey.toString());

    if (!process.env.DEX_UI_HOME) {
        console.log("DEX_UI_HOME env var not set. This should point to the root dir of the dex_ui you are using");
        console.log("FAIL");
        return;
    }
    if (!process.env.VIAL_HOME) {
        console.log("VIAL_HOME env var not set. This should point to the root dir of the serum-vial you are using");
        console.log("FAIL");
        return;
    }
    if (!process.env.STOPLOSS_SERVER_HOME) {
        console.log("STOPLOSS_SERVER_HOMEOME env var not set. This should point to the root dir of the stoploss-server you are using");
        console.log("FAIL");
        return;
    }
    if (!process.env.STOPLOSS_GUI_SERVER_HOME) {
        console.log("STOPLOSS_GUI_SERVER_HOMEOME env var not set. This should point to the root dir of the gui-server you are using");
        console.log("FAIL");
        return;
    }

    const DEX_UI_HOME = process.env.DEX_UI_HOME;
    const VIAL_HOME = process.env.VIAL_HOME;
    const STOPLOSS_SERVER_HOME = process.env.STOPLOSS_SERVER_HOME;
    const STOPLOSS_GUI_SERVER_HOME = process.env.STOPLOSS_GUI_SERVER_HOME;

    // token-mints.json looks like:
    // [
    //     {
    //         "address": "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E",
    //         "name": "BTC"
    //     },
    //     {
    //         "address": "2FPyTwcZLUg1MDrwsyoP4D6s1tM7hAkHYRjkNb5w6Pxk",
    //         "name": "ETH"
    //     },
    // ]

    let tokenMints = [
        {
            address: baseMint.publicKey.toString(),
            name: markets[0].toString(),
        },
        {
            address: quoteMint.publicKey.toString(),
            name: markets[1].toString(),
        }
    ];

    await replaceJsonFile(tokenMints, DEX_UI_HOME + '/node_modules/@project-serum/serum/lib/token-mints.json');
    await replaceJsonFile(tokenMints, VIAL_HOME + '/node_modules/@project-serum/serum/lib/token-mints.json');

    let dex = {
        dex_pid: DEX_PID.toString(),
    }

    let sl = {
        sl_pid: SL_PID.toString(),
    }

    await replaceJsonFile(dex, DEX_UI_HOME + '/src/utils/dex.json');
    await replaceJsonFile(sl, DEX_UI_HOME + '/src/utils/sl.json');


    // markets.json looks like:
    // [
    //     {
    //         "address": "B37pZmwrwXHjpgvd9hHDAx1yeDsNevTnbbrN9W12BoGK",
    //         "deprecated": true,
    //         "name": "ALEPH/WUSDC",
    //         "programId": "4ckmDgGdxQoPDLUkDT3vHgSAkzA3QRdNq5ywwY4sUSJn"
    //     },
    //     {
    //         "address": "CAgAeMD7quTdnr6RPa7JySQpjf3irAmefYNdTb6anemq",
    //         "deprecated": true,
    //         "name": "BTC/WUSDC",
    //         "programId": "4ckmDgGdxQoPDLUkDT3vHgSAkzA3QRdNq5ywwY4sUSJn"
    //     },
    // ]    

    let marketDeploy = [
        {
            address: market.publicKey.toString(),
            deprecated: false,
            name: markets[0] + "/" + markets[1],
            programId: DEX_PID.toString(),
        }
    ];

    await replaceJsonFile(marketDeploy, DEX_UI_HOME + '/node_modules/@project-serum/serum/lib/markets.json');
    await replaceJsonFile(marketDeploy, VIAL_HOME + '/node_modules/@project-serum/serum/lib/markets.json');

    // load market to make sure...
    let mkt = await Market.load(connection, market.publicKey, {}, DEX_PID);
    console.log("loaded mkt", mkt.address.toString());
    console.log("loaded mkt baseMint", mkt.baseMintAddress.toString());
    console.log("loaded mkt quoteMint", mkt.quoteMintAddress.toString());

    let tokenList = {
        "name": "Solana Token List",
        "logoURI": "https://cdn.jsdelivr.net/gh/trustwallet/assets@master/blockchains/solana/info/logo.png",
        "keywords": [
            "solana",
            "spl"
        ],
        "tags": {
            "stablecoin": {
                "name": "stablecoin",
                "description": "Tokens that are fixed to an external asset, e.g. the US dollar"
            },
        },
        "timestamp": "2021-03-03T19:57:21+0000",
        "tokens": [
            {
                "chainId": 103,
                "address": mkt.baseMintAddress.toString(),
                "symbol": "AAA",
                "name": "Devnet/local AAA",
                "decimals": 6,
                "logoURI": "",
                "tags": []
            },
            {
                "chainId": 103,
                "address": mkt.quoteMintAddress.toString(),
                "symbol": "BBB",
                "name": "Devnet/local BBB",
                "decimals": 6,
                "logoURI": "",
                "tags": []
            },
        ],
        "version": {
            "major": 0,
            "minor": 2,
            "patch": 2
        }

    }

    await replaceJsonFile(tokenList, STOPLOSS_SERVER_HOME + '/src/solana.tokenlist.json');
    await replaceJsonFile(tokenList, STOPLOSS_GUI_SERVER_HOME + '/src/solana.tokenlist.json');



    // now set up the base/quote vaults and the open orders

    let stoplossPDA = await getStoplossVaultOwner(Buffer.from("stoploss"), SL_PID);

    let stoplossBaseVault = anchor.web3.Keypair.generate();
    let stoplossQuoteVault = anchor.web3.Keypair.generate();
    let stoplossOpenOrders = anchor.web3.Keypair.generate();

    const vaultstxn = new Transaction();
    vaultstxn.add(
        SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: stoplossBaseVault.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(165),
            space: 165,
            programId: TOKEN_PROGRAM_ID,
        }),
        SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: stoplossQuoteVault.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(165),
            space: 165,
            programId: TOKEN_PROGRAM_ID,
        }),
        TokenInstructions.initializeAccount({
            account: stoplossBaseVault.publicKey,
            mint: mkt.baseMintAddress,
            owner: stoplossPDA,
        }),
        TokenInstructions.initializeAccount({
            account: stoplossQuoteVault.publicKey,
            mint: mkt.quoteMintAddress,
            owner: stoplossPDA,
        }),

    );

    // signal provider is the thing that actually executes the order,
    // so it is the thing that needs to have an openOrders account
    const signalProvider = await getPayer('/.config/solana/signal_provider.json');


    vaultstxn.add(
        await OpenOrders.makeCreateAccountTransaction(
            connection,
            market.publicKey.toString(),
            signalProvider.publicKey,
            stoplossOpenOrders.publicKey,
            DEX_PID
        )
    );

    vaultstxn.recentBlockhash = blockhash;
    vaultstxn.setSigners(payer.publicKey, stoplossBaseVault.publicKey, stoplossQuoteVault.publicKey, stoplossOpenOrders.publicKey, signalProvider.publicKey);
    vaultstxn.feePayer = payer.publicKey;
    vaultstxn.sign(payer, stoplossBaseVault, stoplossQuoteVault, stoplossOpenOrders, signalProvider);

    const vaultstxnid = await connection.sendRawTransaction(
        vaultstxn.serialize(),
        {
            skipPreflight: true,
        },
    );
    await connection.confirmTransaction(vaultstxnid, 'processed');


    let vaults = {
        "stoploss_markets": [
            {
                "market": market.publicKey.toString(),
                "stoplossBaseVault": stoplossBaseVault.publicKey.toString(),
                "stoplossQuoteVault": stoplossQuoteVault.publicKey.toString(),
                "stoplossOpenOrders": stoplossOpenOrders.publicKey.toString(),
                "signalProvider": signalProvider.publicKey.toString(),
            }
        ]
    }

    await replaceJsonFile(vaults, DEX_UI_HOME + '/src/utils/stoploss.vaults.json');

}

async function getStoplossVaultOwner(seed, stoplossProgramId) {
    let pda_arr = await PublicKey.findProgramAddress([seed], stoplossProgramId);
    return pda_arr[0];
  }
  

async function replaceJsonFile(data, path) {
    if (fs.existsSync(path) && !fs.existsSync(path + '.bak')) {
        console.log("renaming " + path + " to " + path + '.bak');
        await fs.rename(path, path + '.bak', function (err) {
            if (err)
                console.log('ERROR: ' + err);
        });
    }

    await fs.writeFile(path, JSON.stringify(data), (err) => {
        if (err) {
            throw err;
        }
    });
    console.log("replaced " + path + " with " + JSON.stringify(data));
}

run();



