const assert = require("assert");
const anchor = require("@project-serum/anchor");
const BN = anchor.BN;

const serumCmn = require("@project-serum/common");
const Market = require("@project-serum/serum").Market;
const TOKEN_PROGRAM_ID = require("@solana/spl-token").TOKEN_PROGRAM_ID;
const utils = require("./utils");

// Taker fee rate (bps).
const TAKER_FEE = 0.0022;

describe("anchor-stoploss-reuse-partials", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.Provider.env());

  // Stoploss program client.
  const program = anchor.workspace.AnchorStoploss;

  // Accounts used to setup the orderbook.
  let ORDERBOOK_ENV,
    // Accounts used for buy transactions
    BUY_NEW_ORDER_ACCOUNTS,
    // Accounts used for sell transactions
    SELL_NEW_ORDER_ACCOUNTS,
    // the accounts used by the algo server when executing child orders
    EXECUTE_BUY_ORDER_ACCOUNTS,
    // the accounts used by the algo server when executing child orders
    EXECUTE_SELL_ORDER_ACCOUNTS,
    // Serum DEX vault PDA for market A/USDC.
    marketAVaultSigner,
    // owner of the stoploss vaults
    stoplossPDA,
    // the account that can execute orders. This will be a server side component
    signalProvider,
    market;



  it("BOILERPLATE: Sets up a market with resting orders", async () => {
    ORDERBOOK_ENV = await utils.setupTheMarket({
      provider: program.provider,
    });
    signalProvider = await utils.setupSignalProvider(program.provider, program.provider.wallet.payer, program._programId);
    await utils.airdrop(program._provider.connection, 100000000, signalProvider);
    program.send
    stoplossPDA = await utils.getStoplossVaultOwner(Buffer.from("stoploss"), program._programId);
    const marketA = ORDERBOOK_ENV.marketA;
    market = await Market.load(program.provider.connection, marketA.publicKey, {}, utils.DEX_PID);

  });

  it("BOILERPLATE: Sets up reusable accounts", async () => {
    const marketA = ORDERBOOK_ENV.marketA;

    const [vaultSignerA] = await utils.getDexVaultOwnerAndNonce(
      marketA._decoded.ownAddress
    );
    marketAVaultSigner = vaultSignerA;

    const { stoplossBaseVault, stoplossQuoteVault, stoplossOpenOrders } =
      await utils.setupStoplossAccounts(program.provider, ORDERBOOK_ENV.mintA, ORDERBOOK_ENV.mintusdc, program.provider.wallet.payer, stoplossPDA, marketA._decoded.ownAddress, signalProvider
        );    

    

    // buys and sells need different accounts. 
    BUY_NEW_ORDER_ACCOUNTS = {
      market: {
        market: marketA._decoded.ownAddress,
        requestQueue: marketA._decoded.requestQueue,
        eventQueue: marketA._decoded.eventQueue,
        bids: marketA._decoded.bids,
        asks: marketA._decoded.asks,
        coinVault: marketA._decoded.baseVault,
        pcVault: marketA._decoded.quoteVault,
        vaultSigner: marketAVaultSigner,
        // User params.
        openOrders: stoplossOpenOrders.publicKey,
        orderPayerTokenAccount: ORDERBOOK_ENV.godUsdc,
        coinWallet: ORDERBOOK_ENV.godA,
        pcWallet: ORDERBOOK_ENV.godUsdc,
        coinMint: ORDERBOOK_ENV.mintA,
        pcMint: ORDERBOOK_ENV.mintusdc,

      },
      stoplossBaseVault: stoplossBaseVault.publicKey,
      stoplossQuoteVault: stoplossQuoteVault.publicKey,
      stoplossOpenOrders: stoplossOpenOrders.publicKey,
      stoplossProgram: program._programId,

      // signal provider is the off chain component that will call execute
      signalProvider: signalProvider.publicKey,

      authority: program.provider.wallet.publicKey,
      dexProgram: utils.DEX_PID,
      pda: stoplossPDA,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };
    SELL_NEW_ORDER_ACCOUNTS = {
      ...BUY_NEW_ORDER_ACCOUNTS,
      clientPayingAccount: ORDERBOOK_ENV.godA,
      clientReceivingAccount: ORDERBOOK_ENV.godUsdc,
      market: {
        ...BUY_NEW_ORDER_ACCOUNTS.market,
        orderPayerTokenAccount: ORDERBOOK_ENV.godA,
      },
    };
    EXECUTE_BUY_ORDER_ACCOUNTS = {
      ...BUY_NEW_ORDER_ACCOUNTS,
      authority: signalProvider.publicKey,
      market: {
        ...BUY_NEW_ORDER_ACCOUNTS.market,
      },
    };
    EXECUTE_SELL_ORDER_ACCOUNTS = {
      ...SELL_NEW_ORDER_ACCOUNTS,
      authority: signalProvider.publicKey,
      market: {
        ...SELL_NEW_ORDER_ACCOUNTS.market,
        orderPayerTokenAccount: ORDERBOOK_ENV.godA,
      },
    };

  });

 
  async function newSell(limitPrice, clientOrderId, triggerPrice, maxCoinQty, maxPcQty) {
    return await utils.createSellOrder(program, SELL_NEW_ORDER_ACCOUNTS, ORDERBOOK_ENV, market, Side.Ask,
      limitPrice, clientOrderId, triggerPrice, maxCoinQty, maxPcQty, signalProvider);
  }

  async function newBuy(limitPrice, clientOrderId, triggerPrice, maxCoinQty, maxPcQty) {
    return await utils.createBuyOrder(program, BUY_NEW_ORDER_ACCOUNTS, ORDERBOOK_ENV, market, Side.Bid,
      limitPrice, clientOrderId, triggerPrice, maxCoinQty, maxPcQty, signalProvider);
  }



  // it("Create and execute sell Stoploss order, reuse_unfilled is true", async () => {
    
  //   // larger qty than available at TOB
  //   const maxCoinQty = 22.2; 
  //   const maxPcQty = new BN(Number.MAX_SAFE_INTEGER);
  //   const bestBidPrice = 6.004; // best bid
  //   const amountToFill = 8.5 * bestBidPrice;
  //   const expectedFillAmount = amountToFill * (1 - TAKER_FEE) * 10 ** 6;
  //   const limitPrice = 6.004;
  //   const clientId = new BN(1234567);
  //   const triggerPrice = 20;
  //   const tokenABefore = (await getA()).amount;
  //   const usdcBefore = (await getUsdc()).amount;

  //   let stoplossStateAccount = await newSell(limitPrice, clientId, triggerPrice, maxCoinQty, maxPcQty);


  //   // EXECUTE - this will fire against first level TOB ask: 7.8@6.041
  //   EXECUTE_SELL_ORDER_ACCOUNTS["stoplossState"] = stoplossStateAccount.publicKey;
  //   [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await executeSell(maxCoinQty, limitPrice, market, true);


  //   // should have matched and settled....
  //   let totalUsdcChange = ((await getUsdc()).amount.toNumber() - usdcBefore.toNumber()) / 10 ** 6;
  //   let totalTokenAChange = ((await getA()).amount.toNumber() - tokenABefore.toNumber()) / 10 ** 6;


  //   assert.ok(tokenAChange === 0);
  //   assert.ok(totalTokenAChange === -maxCoinQty);
  //   assert.ok((totalUsdcChange + stoplossQuoteChange) === parseFloat((8.5*6.004*(1-0.0022)).toFixed(6))); // client is credited
  //   assert.ok(stoplossBaseChange === -8.5); // 8.5 is qty resting on the book

  //   // wrong after changing the program after manual testing
  //   //assert.ok(stoplossQuoteChange === 0); //sl vault transferred out to client immediately, so no change


  //   // check the "state" account is modified correctly 
  //   sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
  //   assert.ok(sls.maxCoinQty.toNumber() === maxCoinQty * 10 ** 6);
  //   assert.ok(sls.coinLeavesQty.toNumber() === (maxCoinQty-8.5) * 10 ** 6);
  //   assert.ok(sls.coinCumQty.toNumber() === 8.5 * 10 ** 6);
  //   assert.ok((sls.pcCumQty.toNumber() / 10 ** 6).toFixed(5) === (expectedFillAmount / 10 ** 6).toFixed(5));
  //   assert.ok(sls.avgPrice.toNumber() === 5990);
  //   assert.ok(sls.lastPrice.toNumber() === 5990);


  //   // should be some fills too - it reports one per side so each order is notified (ie one for each buy/sell matching sides)
  //   for (let fill of await market.loadFills(program.provider.connection)) {
  //     assert.ok(fill.size === 8.5);
  //     assert.ok(fill.price === limitPrice);
  //   }
  // });

  



  // it("Create and execute BUY Stoploss order, reuse_unfilled is true", async () => {

  //   // target 1.2 of base, which is 1.2*6.041 quote, ie 7.2492
  //   const buyAmount = 1.2000;
  //   const limitPrice = 6.041; // TOB price
  //   const maxCoinQty = buyAmount * 10 ** 6 // 6 dp
  //   const maxPcQty = maxCoinQty * limitPrice;
  //   const clientOrderId = new BN(12345);
  //   const triggerPrice = 20;
  //   const usdcBefore = (await getUsdc()).amount;


  //   let stoplossStateAccount = await newBuy(limitPrice, clientOrderId, triggerPrice, maxCoinQty, maxPcQty);


  //   // EXECUTE - this will fire against first level TOB ask: 7.8@6.041
  //   EXECUTE_BUY_ORDER_ACCOUNTS["stoplossState"] = stoplossStateAccount.publicKey;
  //   let [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await executeBuy(buyAmount, limitPrice, market,true);


  //   // should have matched and settled....
  //   let totalUsdcChange = ((await getUsdc()).amount.toNumber() - usdcBefore.toNumber()) / 10 ** 6

  //   // only fills for 1.1 - Fees are deducted from payer account, and then lot sizes means it can only fill to 1 dp accuracy
  //   assert.ok(tokenAChange === 1.1);
  //   // we are spending usdc to get tokenA. Total is transferred and remains until it is settled 
  //   let expectedUsdChange = -1 * 1.2 * limitPrice;
  //   assert.ok(totalUsdcChange === parseFloat(expectedUsdChange.toFixed(5)));
  //   assert.ok(usdcChange === 0); // unfilled amt is left in stoploss program
  //   assert.ok(stoplossBaseChange === 0); // settled to stoploss and then immediately transferred to client wallet - no change
  //   let expectedFillAmt = -1 * tokenAChange * (1 + TAKER_FEE) * limitPrice;
  //   assert.ok(stoplossQuoteChange.toFixed(5) === expectedFillAmt.toFixed(5)); // this is the amt actually filled


  //   // buying, so spending the pc coin
  //   // check the "state" account is modified correctly 
  //   sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
  //   assert.ok(sls.maxCoinQty.toNumber() === maxCoinQty);
  //   // coin leaves is irrelevant for buy orders - it can be max int really for all client cares
  //   assert.ok(sls.coinCumQty.toNumber() === 1.1 * 10 ** 6);
  //   assert.ok(sls.pcCumQty.toNumber() === -parseFloat(expectedFillAmt.toFixed(5)) * 10 ** 6);
  //   assert.ok(sls.avgPrice.toNumber() / 10 ** 3 === parseFloat(((1 + TAKER_FEE) * limitPrice).toFixed(3)));
  //   assert.ok(sls.lastPrice.toNumber() === 6054);
  //   // didnt fully fill, some left over
  //   assert.ok(sls.pcLeavesQty.toNumber() === 589480);
  // });

  async function executeBuy(baseQuantity, limitPrice, market, reuseUnfilled=false) {
    let [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await utils.withBalanceChange(
      program.provider,
      [ORDERBOOK_ENV.godA, ORDERBOOK_ENV.godUsdc, BUY_NEW_ORDER_ACCOUNTS.stoplossBaseVault, BUY_NEW_ORDER_ACCOUNTS.stoplossQuoteVault],
      async () => {
        await program.rpc.executeOrder(
          new BN(baseQuantity * limitPrice * 10 ** 6),
          market.priceNumberToLots(limitPrice),
          reuseUnfilled,
          {
            accounts: EXECUTE_BUY_ORDER_ACCOUNTS,
            signers: [signalProvider]
          }
        );
      }
    );
    return [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange];

  }

  async function executeSell(baseQuantity, limitPrice, market,  reuseUnfilled=false) {
    let [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await utils.withBalanceChange(
      program.provider,
      [ORDERBOOK_ENV.godA, ORDERBOOK_ENV.godUsdc, BUY_NEW_ORDER_ACCOUNTS.stoplossBaseVault, BUY_NEW_ORDER_ACCOUNTS.stoplossQuoteVault],
      async () => {
        await program.rpc.executeOrder(
          new BN(baseQuantity * 10 ** 6),
          market.priceNumberToLots(limitPrice),
          reuseUnfilled,
          {
            accounts: EXECUTE_SELL_ORDER_ACCOUNTS,
            signers: [signalProvider]
          }
        );
      }
    );
    return [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange];

  }  

  async function getUsdc() {
    return await serumCmn.getTokenAccount(program.provider, ORDERBOOK_ENV.godUsdc);
  }

  async function getA() {
    return await serumCmn.getTokenAccount(program.provider, ORDERBOOK_ENV.godA);
  }


});

// Side rust enum used for the program's RPC API.
const Side = {
  Bid: { bid: {} },
  Ask: { ask: {} },
};


