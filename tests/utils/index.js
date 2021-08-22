// Boilerplate utils to bootstrap an orderbook for testing on a localnet.
// not super relevant to the point of the example, though may be useful to
// include into your own workspace for testing.
//
// TODO: Modernize all these apis. This is all quite clunky.

const assert = require("assert");

const Token = require("@solana/spl-token").Token;
const anchor = require("@project-serum/anchor");
const TOKEN_PROGRAM_ID = require("@solana/spl-token").TOKEN_PROGRAM_ID;
const ASSOCIATED_TOKEN_PROGRAM_ID = require("@solana/spl-token").ASSOCIATED_TOKEN_PROGRAM_ID;
const TokenInstructions = require("@project-serum/serum").TokenInstructions;
const Market = require("@project-serum/serum").Market;
const DexInstructions = require("@project-serum/serum").DexInstructions;
const web3 = require("@project-serum/anchor").web3;
const Connection = web3.Connection;
const BN = require("@project-serum/anchor").BN;
const serumCmn = require("@project-serum/common");
const Account = web3.Account;
const Transaction = web3.Transaction;
const PublicKey = web3.PublicKey;
const SystemProgram = web3.SystemProgram;
const OpenOrders = require("@project-serum/serum").OpenOrders;
const DEX_PID = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");

async function setupSignalProvider(provider, payerAccount, stoplossProgramId) {
  let signalProvider = anchor.web3.Keypair.generate();
  let connection = provider.connection;

  // Transfer lamports to market maker.
  await provider.send(
    (() => {
      const tx = new Transaction();
      tx.add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: signalProvider.publicKey,
          lamports: 100000000000,
        })
      );
      return tx;
    })()
  );

  return signalProvider;
}

async function createSLTokenAccountTransaction(
  connection,
  wallet,
  mintPublicKey,
  stoplossProgram,
  stoplossPDA,
) {
  let ata = await PublicKey.findProgramAddress([stoplossPDA.toBuffer(), stoplossProgram.toBuffer(), mintPublicKey.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
  ata = ata[0];

  // const ata = await Token.getAssociatedTokenAddress(
  //   ASSOCIATED_TOKEN_PROGRAM_ID,
  //   TOKEN_PROGRAM_ID,
  //   mintPublicKey,
  //   stoplossProgram,
  // );
  let ix = Token.createAssociatedTokenAccountInstruction(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    mintPublicKey,
    ata,
    stoplossProgram,
    wallet,
  )
  return {
    ix,
    newAccountPubkey: ata,
  };
}

async function setupStoplossAccounts(provider, mintA, mintusdc, payerAccount, stoplossPDA, marketAddress, signalProvider, programId) {
  let connection = provider.connection;

  // let basetx = await createSLTokenAccountTransaction(provider, payerAccount.publicKey, mintA, programId, stoplossPDA);
  // let quotetx = await createSLTokenAccountTransaction(provider, payerAccount.publicKey, mintusdc, programId, stoplossPDA);
  // const tx0 = new Transaction();
  // tx0.add(basetx.ix);
  // tx0.add(quotetx.ix);
  // await provider.send(tx0, [payerAccount]);

  let stoplossBaseVault = anchor.web3.Keypair.generate();
  let stoplossQuoteVault = anchor.web3.Keypair.generate();
  let stoplossOpenOrders = anchor.web3.Keypair.generate();

  const tx1 = new Transaction();
  tx1.add(
    SystemProgram.createAccount({
      fromPubkey: payerAccount.publicKey,
      newAccountPubkey: stoplossBaseVault.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(165),
      space: 165,
      programId: TOKEN_PROGRAM_ID,
    }),
    SystemProgram.createAccount({
      fromPubkey: payerAccount.publicKey,
      newAccountPubkey: stoplossQuoteVault.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(165),
      space: 165,
      programId: TOKEN_PROGRAM_ID,
    }),
    TokenInstructions.initializeAccount({
      account: stoplossBaseVault.publicKey,
      mint: mintA,
      owner: stoplossPDA,
    }),
    TokenInstructions.initializeAccount({
      account: stoplossQuoteVault.publicKey,
      mint: mintusdc,
      owner: stoplossPDA,
    }),

  );

  // signal provider is the thing that actually executes the order,
  // so it is the thing that needs to have an openOrders account
  // just do at the point of sending the new order for the first time from the server?
  const tx2 = new Transaction();

  tx2.add(
    await OpenOrders.makeCreateAccountTransaction(
      provider.connection,
      marketAddress,
      signalProvider.publicKey,
      stoplossOpenOrders.publicKey,
      DEX_PID
    )
  );

  await provider.send(tx1, [payerAccount, stoplossBaseVault, stoplossQuoteVault]);

  await provider.send(tx2, [stoplossOpenOrders, signalProvider]);


  const stoplossQuoteOwner = (await serumCmn.getTokenAccount(provider, stoplossQuoteVault.publicKey));
  return { stoplossBaseVault, stoplossQuoteVault, stoplossOpenOrders };
}


async function setupTheMarket({ provider }) {
  // Setup mints with initial tokens owned by the provider.
  const decimals = 6;
  const [MINT_A, GOD_A] = await serumCmn.createMintAndVault(
    provider,
    new BN(1000000000000000),
    undefined,
    decimals
  );
  const [USDC, GOD_USDC] = await serumCmn.createMintAndVault(
    provider,
    new BN(1000000000000000),
    undefined,
    decimals
  );

  // Create a funded account to act as market maker.
  const amount = 100000 * 10 ** decimals;
  const marketMaker = await fundAccount({
    provider,
    mints: [
      { god: GOD_A, mint: MINT_A, amount, decimals },
      { god: GOD_USDC, mint: USDC, amount, decimals },
    ],
  });

  // Setup A/USDC and B/USDC markets with resting orders.
  const asks = [
    [6.041, 7.8],
    [6.051, 72.3],
    [6.055, 5.4],
    [6.067, 15.7],
    [6.077, 390.0],
    [6.09, 24.0],
    [6.11, 36.3],
    [6.133, 300.0],
    [6.167, 687.8],
  ];
  const bids = [
    [6.004, 8.5],
    [5.995, 12.9],
    [5.987, 6.2],
    [5.978, 15.3],
    [5.965, 82.8],
    [5.961, 25.4],
  ];

  MARKET_A_USDC = await setupMarket({
    baseMint: MINT_A,
    quoteMint: USDC,
    marketMaker: {
      account: marketMaker.account,
      baseToken: marketMaker.tokens[MINT_A.toString()],
      quoteToken: marketMaker.tokens[USDC.toString()],
    },
    bids,
    asks,
    provider,
  });

  // Create a funded account to act as a second user trading.
  const secondUser = await fundAccount({
    provider,
    mints: [
      { god: GOD_A, mint: MINT_A, amount, decimals },
      { god: GOD_USDC, mint: USDC, amount, decimals },
    ],
  });

  return {
    marketA: MARKET_A_USDC,
    marketMaker,
    mintA: MINT_A,
    mintusdc: USDC,
    godA: GOD_A,
    godUsdc: GOD_USDC,
    secondUser: secondUser,
  };
}

async function setupEmptyMarket({ provider }) {
  // Setup mints with initial tokens owned by the provider.
  const decimals = 6;
  const [MINT_A, GOD_A] = await serumCmn.createMintAndVault(
    provider,
    new BN(1000000000000000),
    undefined,
    decimals
  );
  const [USDC, GOD_USDC] = await serumCmn.createMintAndVault(
    provider,
    new BN(1000000000000000),
    undefined,
    decimals
  );

  // Create a funded account to act as market maker.
  const amount = 100000 * 10 ** decimals;
  const marketMaker = await fundAccount({
    provider,
    mints: [
      { god: GOD_A, mint: MINT_A, amount, decimals },
      { god: GOD_USDC, mint: USDC, amount, decimals },
    ],
  });

  // Setup A/USDC and B/USDC markets with resting orders.
  const asks = [
    [0, 0],
  ];
  const bids = [
    [0,0],
  ];

  MARKET_A_USDC = await setupMarket({
    baseMint: MINT_A,
    quoteMint: USDC,
    marketMaker: {
      account: marketMaker.account,
      baseToken: marketMaker.tokens[MINT_A.toString()],
      quoteToken: marketMaker.tokens[USDC.toString()],
    },
    bids,
    asks,
    provider,
  });

  // Create a funded account to act as a second user trading.
  const secondUser = await fundAccount({
    provider,
    mints: [
      { god: GOD_A, mint: MINT_A, amount, decimals },
      { god: GOD_USDC, mint: USDC, amount, decimals },
    ],
  });

  return {
    marketA: MARKET_A_USDC,
    marketMaker,
    mintA: MINT_A,
    mintusdc: USDC,
    godA: GOD_A,
    godUsdc: GOD_USDC,
    secondUser: secondUser,
  };
}


// Creates everything needed for an orderbook to be running
//
// * Mints for both the base and quote currencies.
// * Lists the market.
// * Provides resting orders on the market.
//
// Returns a client that can be used to interact with the market
// (and some other data, e.g., the mints and market maker account).
async function initOrderbook({ provider, bids, asks }) {
  if (!bids || !asks) {
    asks = [
      [6.041, 7.8],
      [6.051, 72.3],
      [6.055, 5.4],
      [6.067, 15.7],
      [6.077, 390.0],
      [6.09, 24.0],
      [6.11, 36.3],
      [6.133, 300.0],
      [6.167, 687.8],
    ];
    bids = [
      [6.004, 8.5],
      [5.995, 12.9],
      [5.987, 6.2],
      [5.978, 15.3],
      [5.965, 82.8],
      [5.961, 25.4],
    ];
  }
  // Create base and quote currency mints.
  const decimals = 6;
  const [MINT_A, GOD_A] = await serumCmn.createMintAndVault(
    provider,
    new BN(1000000000000000),
    undefined,
    decimals
  );
  const [USDC, GOD_USDC] = await serumCmn.createMintAndVault(
    provider,
    new BN(1000000000000000),
    undefined,
    decimals
  );

  // Create a funded account to act as market maker.
  const amount = 100000 * 10 ** decimals;
  const marketMaker = await fundAccount({
    provider,
    mints: [
      { god: GOD_A, mint: MINT_A, amount, decimals },
      { god: GOD_USDC, mint: USDC, amount, decimals },
    ],
  });

  marketClient = await setupMarket({
    baseMint: MINT_A,
    quoteMint: USDC,
    marketMaker: {
      account: marketMaker.account,
      baseToken: marketMaker.tokens[MINT_A.toString()],
      quoteToken: marketMaker.tokens[USDC.toString()],
    },
    bids,
    asks,
    provider,
  });

  return {
    marketClient,
    baseMint: MINT_A,
    quoteMint: USDC,
    marketMaker,
  };
}

async function airdrop(
  connection,
  lamports = 1000000,
  account,
) {

  if (await connection.getBalance(account.publicKey) > 0) {
    return account;
  }

  let lamportsAfter = 0;
  let retries = 10;
  await connection.requestAirdrop(account.publicKey, lamports);
  for (; ;) {
    await sleep(500);
    lamportsAfter = await connection.getBalance(account.publicKey);
    if (lamportsAfter >= lamports) {
      return account;
    }
    if (--retries <= 0) {
      break;
    }
    console.log(`Airdrop retry ${retries}`);
  }
  throw new Error(`Airdrop of ${lamports} failed`);
}

async function fundAccount({ provider, mints }) {
  const MARKET_MAKER = new Account();

  const marketMaker = {
    tokens: {},
    account: MARKET_MAKER,
  };

  // Transfer lamports to market maker.
  await provider.send(
    (() => {
      const tx = new Transaction();
      tx.add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: MARKET_MAKER.publicKey,
          lamports: 100000000000,
        })
      );
      return tx;
    })()
  );

  // Transfer SPL tokens to the market maker.
  for (let k = 0; k < mints.length; k += 1) {
    const { mint, god, amount, decimals } = mints[k];
    let MINT_A = mint;
    let GOD_A = god;
    // Setup token accounts owned by the market maker.
    const mintAClient = new Token(
      provider.connection,
      MINT_A,
      TOKEN_PROGRAM_ID,
      provider.wallet.payer // node only
    );
    const marketMakerTokenA = await mintAClient.createAccount(
      MARKET_MAKER.publicKey
    );

    await provider.send(
      (() => {
        const tx = new Transaction();
        tx.add(
          Token.createTransferCheckedInstruction(
            TOKEN_PROGRAM_ID,
            GOD_A,
            MINT_A,
            marketMakerTokenA,
            provider.wallet.publicKey,
            [],
            amount,
            decimals
          )
        );
        return tx;
      })()
    );

    marketMaker.tokens[mint.toString()] = marketMakerTokenA;
  }

  return marketMaker;
}

async function setupMarket({
  provider,
  marketMaker,
  baseMint,
  quoteMint,
  bids,
  asks,
}) {
  const marketAPublicKey = await listMarket({
    connection: provider.connection,
    wallet: provider.wallet,
    baseMint: baseMint,
    quoteMint: quoteMint,
    baseLotSize: 100000,
    quoteLotSize: 100,
    dexProgramId: DEX_PID,
    feeRateBps: 0,
  });
  const MARKET_A_USDC = await Market.load(
    provider.connection,
    marketAPublicKey,
    { commitment: "recent" },
    DEX_PID
  );
  for (let k = 0; k < asks.length; k += 1) {
    let ask = asks[k];
    if (ask[0] === 0) {
      continue;
    }
    const {
      transaction,
      signers,
    } = await MARKET_A_USDC.makePlaceOrderTransaction(provider.connection, {
      owner: marketMaker.account,
      payer: marketMaker.baseToken,
      side: "sell",
      price: ask[0],
      size: ask[1],
      orderType: "postOnly",
      clientId: undefined,
      openOrdersAddressKey: undefined,
      openOrdersAccount: undefined,
      feeDiscountPubkey: null,
      selfTradeBehavior: "abortTransaction",
    });
    await provider.send(transaction, signers.concat(marketMaker.account));
  }

  for (let k = 0; k < bids.length; k += 1) {
    let bid = bids[k];
    if (bid[0] === 0) {
      continue;
    }
    const {
      transaction,
      signers,
    } = await MARKET_A_USDC.makePlaceOrderTransaction(provider.connection, {
      owner: marketMaker.account,
      payer: marketMaker.quoteToken,
      side: "buy",
      price: bid[0],
      size: bid[1],
      orderType: "postOnly",
      clientId: undefined,
      openOrdersAddressKey: undefined,
      openOrdersAccount: undefined,
      feeDiscountPubkey: null,
      selfTradeBehavior: "abortTransaction",
    });
    await provider.send(transaction, signers.concat(marketMaker.account));
  }

  return MARKET_A_USDC;
}

async function listMarket({
  connection,
  wallet,
  baseMint,
  quoteMint,
  baseLotSize,
  quoteLotSize,
  dexProgramId,
  feeRateBps,
}) {
  const market = new Account();
  const requestQueue = new Account();
  const eventQueue = new Account();
  const bids = new Account();
  const asks = new Account();
  const baseVault = new Account();
  const quoteVault = new Account();
  const quoteDustThreshold = new BN(100);

  const [vaultOwner, vaultSignerNonce] = await getDexVaultOwnerAndNonce(
    market.publicKey,
    dexProgramId
  );

  const tx1 = new Transaction();
  tx1.add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: baseVault.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(165),
      space: 165,
      programId: TOKEN_PROGRAM_ID,
    }),
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: quoteVault.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(165),
      space: 165,
      programId: TOKEN_PROGRAM_ID,
    }),
    TokenInstructions.initializeAccount({
      account: baseVault.publicKey,
      mint: baseMint,
      owner: vaultOwner,
    }),
    TokenInstructions.initializeAccount({
      account: quoteVault.publicKey,
      mint: quoteMint,
      owner: vaultOwner,
    })
  );

  const tx2 = new Transaction();
  tx2.add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: market.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(
        Market.getLayout(dexProgramId).span
      ),
      space: Market.getLayout(dexProgramId).span,
      programId: dexProgramId,
    }),
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: requestQueue.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(5120 + 12),
      space: 5120 + 12,
      programId: dexProgramId,
    }),
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: eventQueue.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(262144 + 12),
      space: 262144 + 12,
      programId: dexProgramId,
    }),
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: bids.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(65536 + 12),
      space: 65536 + 12,
      programId: dexProgramId,
    }),
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: asks.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(65536 + 12),
      space: 65536 + 12,
      programId: dexProgramId,
    }),
    DexInstructions.initializeMarket({
      market: market.publicKey,
      requestQueue: requestQueue.publicKey,
      eventQueue: eventQueue.publicKey,
      bids: bids.publicKey,
      asks: asks.publicKey,
      baseVault: baseVault.publicKey,
      quoteVault: quoteVault.publicKey,
      baseMint,
      quoteMint,
      baseLotSize: new BN(baseLotSize),
      quoteLotSize: new BN(quoteLotSize),
      feeRateBps,
      vaultSignerNonce,
      quoteDustThreshold,
      programId: dexProgramId,
    })
  );

  const signedTransactions = await signTransactions({
    transactionsAndSigners: [
      { transaction: tx1, signers: [baseVault, quoteVault] },
      {
        transaction: tx2,
        signers: [market, requestQueue, eventQueue, bids, asks],
      },
    ],
    wallet,
    connection,
  });
  for (let signedTransaction of signedTransactions) {
    await sendAndConfirmRawTransaction(
      connection,
      signedTransaction.serialize()
    );
  }
  const acc = await connection.getAccountInfo(market.publicKey);

  return market.publicKey;
}

async function signTransactions({
  transactionsAndSigners,
  wallet,
  connection,
}) {
  const blockhash = (await connection.getRecentBlockhash("max")).blockhash;
  transactionsAndSigners.forEach(({ transaction, signers = [] }) => {
    transaction.recentBlockhash = blockhash;
    transaction.setSigners(
      wallet.publicKey,
      ...signers.map((s) => s.publicKey)
    );
    if (signers.length > 0) {
      transaction.partialSign(...signers);
    }
  });
  return await wallet.signAllTransactions(
    transactionsAndSigners.map(({ transaction }) => transaction)
  );
}

async function sendAndConfirmRawTransaction(
  connection,
  raw,
  commitment = "recent"
) {
  let tx = await connection.sendRawTransaction(raw, {
    skipPreflight: true,
  });
  return await connection.confirmTransaction(tx, commitment);
}

async function getDexVaultOwnerAndNonce(marketPublicKey, dexProgramId = DEX_PID) {
  const nonce = new BN(0);
  while (nonce.toNumber() < 255) {
    try {
      const vaultOwner = await PublicKey.createProgramAddress(
        [marketPublicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
        dexProgramId
      );
      return [vaultOwner, nonce];
    } catch (e) {
      nonce.iaddn(1);
    }
  }
  throw new Error("Unable to find nonce");
}

async function getStoplossVaultOwner(seed, stoplossProgramId) {
  let pda_arr = await PublicKey.findProgramAddress([seed], stoplossProgramId);
  return pda_arr[0];
}

async function createBuyOrder(program, NEW_ORDER_ACCOUNTS, ORDERBOOK_ENV, market, side, limitPrice, clientOrderId, triggerPrice, maxCoinQty, maxPcQty, signalProvider) {
  let stoplossStateAccount = anchor.web3.Keypair.generate();
  const tx = new anchor.web3.Transaction();
  tx.add(
    anchor.web3.SystemProgram.createAccount({
      fromPubkey: program.provider.wallet.publicKey,
      newAccountPubkey: stoplossStateAccount.publicKey,
      space: program.account.stoplossState._size,
      lamports: await program.provider.connection.getMinimumBalanceForRentExemption(
        program.account.stoplossState._size
      ),
      programId: program.programId,
    })
  );

  await program.provider.send(tx, [stoplossStateAccount]);

  maxPcQty = Math.floor(maxPcQty);

  NEW_ORDER_ACCOUNTS["stoplossState"] = stoplossStateAccount.publicKey;

  let [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await withBalanceChange(
    program.provider,
    [ORDERBOOK_ENV.godA, ORDERBOOK_ENV.godUsdc, NEW_ORDER_ACCOUNTS.stoplossBaseVault, NEW_ORDER_ACCOUNTS.stoplossQuoteVault],
    async () => {

      await program.rpc.newOrder(
        side,
        market.priceNumberToLots(limitPrice),
        clientOrderId,
        market.priceNumberToLots(triggerPrice),
        new BN(maxCoinQty),
        new BN(maxPcQty),
        signalProvider.publicKey,
        {
          accounts: NEW_ORDER_ACCOUNTS
        }
      );
    }
  );

  // moving funds into sl vault - just pc qty vault is changed. base is receiver of tokens
  assert.ok(tokenAChange === 0);
  assert.ok((-1 * usdcChange).toFixed(5) === (maxPcQty / 10 ** 6).toFixed(5));
  assert.ok(stoplossBaseChange === 0);
  assert.ok(stoplossQuoteChange.toFixed(5) === (maxPcQty / 10 ** 6).toFixed(5));

  // check the "state" account is set up correctly 
  let sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
  assert.ok(sls.maxCoinQty.toNumber() === maxCoinQty);
  assert.ok(sls.maxPcQty.toNumber() === maxPcQty);
  assert.ok(sls.limitPrice.toNumber() === market.priceNumberToLots(limitPrice).toNumber());
  assert.ok(sls.triggerPrice.toNumber() === market.priceNumberToLots(triggerPrice).toNumber());
  assert.ok(sls.clientOrderId.toNumber() === clientOrderId.toNumber());



  return stoplossStateAccount;
}


async function createSellOrder(program, NEW_ORDER_ACCOUNTS, ORDERBOOK_ENV, market, side, limitPrice, clientOrderId, triggerPrice, maxCoinQty, maxPcQty, signalProvider) {
  let stoplossStateAccount = anchor.web3.Keypair.generate();
  const tx = new anchor.web3.Transaction();
  tx.add(
    anchor.web3.SystemProgram.createAccount({
      fromPubkey: program.provider.wallet.publicKey,
      newAccountPubkey: stoplossStateAccount.publicKey,
      space: program.account.stoplossState._size,
      lamports: await program.provider.connection.getMinimumBalanceForRentExemption(
        program.account.stoplossState._size
      ),
      programId: program.programId,
    })
  );

  await program.provider.send(tx, [stoplossStateAccount]);


  NEW_ORDER_ACCOUNTS["stoplossState"] = stoplossStateAccount.publicKey;
  let [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await withBalanceChange(
    program.provider,
    [ORDERBOOK_ENV.godA, ORDERBOOK_ENV.godUsdc, NEW_ORDER_ACCOUNTS.stoplossBaseVault, NEW_ORDER_ACCOUNTS.stoplossQuoteVault],
    async () => {

      await program.rpc.newOrder(
        side,
        market.priceNumberToLots(limitPrice),
        clientOrderId,
        market.priceNumberToLots(triggerPrice),
        new BN(maxCoinQty * 10 ** 6),
        new BN(maxPcQty),
        signalProvider.publicKey,
        {
          accounts: NEW_ORDER_ACCOUNTS
        }
      );
    }
  );

  // moving funds into sl vault - just base vault is changed. 
  assert.ok(-tokenAChange === maxCoinQty);
  assert.ok(usdcChange === 0);
  assert.ok(stoplossBaseChange === maxCoinQty);
  assert.ok(stoplossQuoteChange === 0);

  // check the "state" account is set up correctly 
  let sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
  assert.ok(sls.maxCoinQty.toNumber() === maxCoinQty * 10 ** 6);
  assert.ok(sls.coinLeavesQty.toNumber() === maxCoinQty * 10 ** 6);
  //assert.ok(sls.pcLeavesQty.toNumber() === maxCoinQty * 10 ** 6);
  assert.ok(sls.limitPrice.toNumber() === market.priceNumberToLots(limitPrice).toNumber());
  assert.ok(sls.triggerPrice.toNumber() === market.priceNumberToLots(triggerPrice).toNumber());
  assert.ok(sls.clientOrderId.toNumber() === clientOrderId.toNumber());


  return stoplossStateAccount;
}

// Executes a closure. Returning the change in balances from before and after
// its execution.
async function withBalanceChange(provider, addrs, fn) {
  const beforeBalances = [];
  for (let k = 0; k < addrs.length; k += 1) {
    beforeBalances.push(
      (await serumCmn.getTokenAccount(provider, addrs[k])).amount
    );
  }

  await fn();

  const afterBalances = [];
  for (let k = 0; k < addrs.length; k += 1) {
    afterBalances.push(
      (await serumCmn.getTokenAccount(provider, addrs[k])).amount
    );
  }

  const deltas = [];
  for (let k = 0; k < addrs.length; k += 1) {
    deltas.push(
      (afterBalances[k].toNumber() - beforeBalances[k].toNumber()) / 10 ** 6
    );
  }
  return deltas;
}



module.exports = {
  airdrop,
  fundAccount,
  setupMarket,
  initOrderbook,
  setupTheMarket,
  DEX_PID,
  getDexVaultOwnerAndNonce,
  getStoplossVaultOwner,
  setupStoplossAccounts,
  setupSignalProvider,
  createSellOrder,
  createBuyOrder,
  withBalanceChange,
  setupEmptyMarket
};
