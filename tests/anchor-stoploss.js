const assert = require("assert");
const anchor = require("@project-serum/anchor");
const BN = anchor.BN;

const serumCmn = require("@project-serum/common");
const Market = require("@project-serum/serum").Market;
const TOKEN_PROGRAM_ID = require("@solana/spl-token").TOKEN_PROGRAM_ID;
const ASSOCIATED_TOKEN_PROGRAM_ID = require("@solana/spl-token").ASSOCIATED_TOKEN_PROGRAM_ID;
const utils = require("./utils");

// Taker fee rate (bps).
const TAKER_FEE = 0.0022;

describe("anchor-stoploss", () => {
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
      await utils.setupStoplossAccounts(program.provider, ORDERBOOK_ENV.mintA, ORDERBOOK_ENV.mintusdc, program.provider.wallet.payer, stoplossPDA, marketA._decoded.ownAddress, signalProvider, program._programId);



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



  it("Create and execute sell Stoploss order, settle unfilled portion immediately", async () => {


    const maxCoinQty = 2.2; // size we target, ie 13.2088
    const maxPcQty = new BN(Number.MAX_SAFE_INTEGER);
    const bestBidPrice = 6.004; // best bid
    const amountToFill = maxCoinQty * bestBidPrice;
    const expectedFillAmount = amountToFill * (1 - TAKER_FEE) * 10 ** 6;
    const limitPrice = 6.004;
    const clientId = new BN(1234567);
    const triggerPrice = 20;

    const tokenABefore = (await getA()).amount;
    const usdcBefore = (await getUsdc()).amount;

    let stoplossStateAccount = await newSell(limitPrice, clientId, triggerPrice, maxCoinQty, maxPcQty);

    // EXECUTE - this will fire against first level TOB ask: 7.8@6.041
    EXECUTE_SELL_ORDER_ACCOUNTS["stoplossState"] = stoplossStateAccount.publicKey;
    let [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await executeSell(maxCoinQty, limitPrice, market);


    // should have matched and settled....
    let totalUsdcChange = ((await getUsdc()).amount.toNumber() - usdcBefore.toNumber()) / 10 ** 6;
    let totalTokenAChange = ((await getA()).amount.toNumber() - tokenABefore.toNumber()) / 10 ** 6;


    assert.ok(tokenAChange === 0);
    assert.ok(totalTokenAChange === -maxCoinQty);
    assert.ok(totalUsdcChange === parseFloat(parseFloat(expectedFillAmount / 10 ** 6).toFixed(5)));
    assert.ok(stoplossBaseChange === -maxCoinQty); // all funds transferred in are now transferred out again
    assert.ok(stoplossQuoteChange === 0); // settled directly out to client wallet - no change


    // check the "state" account is modified correctly 
    sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
    assert.ok(sls.maxCoinQty.toNumber() === maxCoinQty * 10 ** 6);
    assert.ok(sls.coinLeavesQty.toNumber() === 0);
    assert.ok(sls.coinCumQty.toNumber() === maxCoinQty * 10 ** 6);
    // small hacks to make it 5 sf
    assert.ok((sls.pcCumQty.toNumber() / 10 ** 6).toFixed(5) === (expectedFillAmount / 10 ** 6).toFixed(5));
    // selling so pc that you receive can be arbitrarily huge really
    //assert.ok(sls.pcLeavesQty.toNumber() === 0);
    assert.ok(sls.limitPrice.toNumber() === market.priceNumberToLots(limitPrice).toNumber());
    assert.ok(sls.triggerPrice.toNumber() === market.priceNumberToLots(triggerPrice).toNumber());
    assert.ok(sls.clientOrderId.toNumber() === clientId.toNumber());

    assert.ok(sls.avgPrice.toNumber() === 599079);
    assert.ok(sls.lastPrice.toNumber() === 599079);
    // set to cancelled status because re-use is false. Ie its an IOC. This one fully filled
    if (sls.ordStatus.filled) {
      // ok
    } else {
      assert.ok(false);
    }



    // should be some fills too - it reports one per side so each order is notified (ie one for each buy/sell matching sides)
    for (let fill of await market.loadFills(program.provider.connection)) {
      assert.ok(fill.size === 2.2);
      assert.ok(fill.price === limitPrice);
    }
  });





  it("Create and execute BUY Stoploss order, settle unfilled portion immediately", async () => {


    // target 1.2 of base, which is 1.2*6.041 quote, ie 7.2492
    const buyAmount = 1.2000;
    const limitPrice = 6.041; // TOB price
    const maxCoinQty = buyAmount * 10 ** 6 // 6 dp
    const maxPcQty = maxCoinQty * limitPrice;
    const clientOrderId = new BN(12345);
    const triggerPrice = 20;
    const usdcBefore = (await getUsdc()).amount;


    let stoplossStateAccount = await newBuy(limitPrice, clientOrderId, triggerPrice, maxCoinQty, maxPcQty);


    // this will fire against first level TOB ask: 7.8@6.041
    EXECUTE_BUY_ORDER_ACCOUNTS["stoplossState"] = stoplossStateAccount.publicKey;

    let [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await executeBuy(buyAmount, limitPrice, market, false);

    // should have matched and settled....
    let totalUsdcChange = ((await getUsdc()).amount.toNumber() - usdcBefore.toNumber()) / 10 ** 6

    // only fills for 1.1 - Fees are deducted from payer account, and then lot sizes means it can only fill to 1 dp accuracy
    assert.ok(tokenAChange === 1.1);
    // we are spending usdc to get tokenA. Fees are on top of the amount traded - so it will cost *more* usdc 
    let expectedUsdChange = -1 * tokenAChange * (1 + TAKER_FEE) * limitPrice;
    assert.ok(totalUsdcChange === parseFloat(expectedUsdChange.toFixed(5)));
    assert.ok(usdcChange === 0.58948); // 7.2492 - 6.65972 = 0.58948 - this is the amount left over, ie unfilled
    assert.ok(stoplossBaseChange === 0); // settled directly out to client wallet - no change
    assert.ok(stoplossQuoteChange === -7.2492); // all funds transferred in are now tqransferred out


    // buying, so spending the pc coin
    // check the "state" account is modified correctly 
    sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
    assert.ok(sls.maxCoinQty.toNumber() === maxCoinQty);
    // this value should be the usdc number. 
    assert.ok(sls.coinCumQty.toNumber() === 1.1 * 10 ** 6);
    assert.ok(sls.pcCumQty.toNumber() === -parseFloat(expectedUsdChange.toFixed(5)) * 10 ** 6);
    assert.ok(sls.avgPrice.toNumber() / 10 ** 5 === parseFloat(((1 + TAKER_FEE) * limitPrice).toFixed(5)));
    assert.ok(sls.lastPrice.toNumber() === 605429);
    // didnt fully fill, some left over
    assert.ok(sls.pcLeavesQty.toNumber() === usdcChange * 10 ** 6);
    assert.ok(sls.limitPrice.toNumber() === market.priceNumberToLots(limitPrice).toNumber());
    assert.ok(sls.triggerPrice.toNumber() === market.priceNumberToLots(triggerPrice).toNumber());
    assert.ok(sls.clientOrderId.toNumber() === clientOrderId.toNumber());
    // set to cancelled status because re-use is false. Ie its an IOC
    if (sls.ordStatus.cancelled) {
      // ok
    } else {
      assert.ok(false);
    }
  });







  it("Create a BUY and then cancel and then try to execute the cancelled order", async () => {

    const usdcBefore = (await getUsdc()).amount;

    // target 1.2 of base, which is 1.2*6.041 quote, ie 7.2492
    const buyAmount = 1.2;
    const limitPrice = 6.041; // TOB price
    const maxCoinQty = buyAmount * 10 ** 6 // 6 dp
    const maxPcQty = maxCoinQty * limitPrice;
    const clientOrderId = new BN(12345);
    const triggerPrice = 20;


    let stoplossStateAccount = await newBuy(limitPrice, clientOrderId, triggerPrice, maxCoinQty, maxPcQty);

    let CANCEL_ACCOUNTS = {
      stoplossState: stoplossStateAccount.publicKey,
      coinWallet: ORDERBOOK_ENV.godA,
      pcWallet: ORDERBOOK_ENV.godUsdc,
      stoplossPayingVault: BUY_NEW_ORDER_ACCOUNTS["stoplossQuoteVault"],
      authority: program.provider.wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      vaultOwner: stoplossPDA
    };

    await program.rpc.cancelOrder(
      {
        accounts: CANCEL_ACCOUNTS,
      }
    );

    let sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
    assert.ok(sls.ordStatus.hasOwnProperty("cancelled"));

    try {

      EXECUTE_BUY_ORDER_ACCOUNTS["stoplossState"] = stoplossStateAccount.publicKey;
      [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await executeBuy(buyAmount, limitPrice, market);

      assert.ok(false);
    } catch (err) {
      const errMsg =
        "The order is in cancelled state. Cannot execute";
      assert.equal(err.toString(), errMsg);
    }

    // should have returned funds
    let totalUsdcChange = ((await getUsdc()).amount.toNumber() - usdcBefore.toNumber()) / 10 ** 6

    assert.ok(0 === totalUsdcChange);
  });





  it("Create a Sell and then cancel and then try to execute the cancelled order", async () => {


    const coinBefore = (await serumCmn.getTokenAccount(program.provider, ORDERBOOK_ENV.godA)).amount;

    const maxCoinQty = 2.2; // size we target, ie 13.2088
    const maxPcQty = new BN(Number.MAX_SAFE_INTEGER)
    const limitPrice = 6.004;
    const clientId = new BN(1234567);
    const triggerPrice = 20;

    let stoplossStateAccount = await newSell(limitPrice, clientId, triggerPrice, maxCoinQty, maxPcQty);

    EXECUTE_SELL_ORDER_ACCOUNTS["stoplossState"] = stoplossStateAccount.publicKey;


    let CANCEL_ACCOUNTS = {
      stoplossState: stoplossStateAccount.publicKey,
      coinWallet: ORDERBOOK_ENV.godA,
      pcWallet: ORDERBOOK_ENV.godUsdc,
      stoplossPayingVault: BUY_NEW_ORDER_ACCOUNTS["stoplossBaseVault"],
      authority: program.provider.wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      vaultOwner: stoplossPDA
    };

    await program.rpc.cancelOrder(
      {
        accounts: CANCEL_ACCOUNTS,
      }
    );


    let sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
    assert.ok(sls.ordStatus.hasOwnProperty("cancelled"));

    try {


      await executeSell(maxCoinQty, limitPrice, market);
      assert.ok(false);

    } catch (err) {
      const errMsg =
        "The order is in cancelled state. Cannot execute";
      assert.equal(err.toString(), errMsg);
    }

    const coinAfter = (await serumCmn.getTokenAccount(program.provider, ORDERBOOK_ENV.godA)).amount;

    // should have returned funds
    let totalCoinChange = (coinAfter.toNumber() - coinBefore.toNumber()) / 10 ** 6
    assert.ok(0 === totalCoinChange);
  });






  it("Amend a sell order", async () => {

    const maxCoinQty = 2.2; // size we target, ie 13.2088
    const maxPcQty = new BN(Number.MAX_SAFE_INTEGER);
    const limitPrice = 6.004;
    const clientOrderId = new BN(1234567);
    const triggerPrice = 20;

    let stoplossStateAccount = await newSell(limitPrice, clientOrderId, triggerPrice, maxCoinQty, maxPcQty);

    let AMEND_ACCOUNTS = {
      stoplossState: stoplossStateAccount.publicKey,
      coinWallet: ORDERBOOK_ENV.godA,
      pcWallet: ORDERBOOK_ENV.godUsdc,
      stoplossPayingVault: BUY_NEW_ORDER_ACCOUNTS["stoplossBaseVault"],
      authority: program.provider.wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      vaultOwner: stoplossPDA
    };

    // amend up
    await amendSell(5.12345, 7.302, 21, market, clientOrderId, AMEND_ACCOUNTS, stoplossStateAccount, maxCoinQty);

    // amend down
    await amendSell(3.12121, 5.342, 22, market, clientOrderId, AMEND_ACCOUNTS, stoplossStateAccount, 5.12345);
  });






  it("Amend a buy order", async () => {

    // target 1.2 of base, which is 1.2*6.041 quote, ie 7.2492
    const buyAmount = 1.2;
    const limitPrice = 6.041; // TOB price
    const maxCoinQty = buyAmount * 10 ** 6 // 6 dp
    const maxPcQty = maxCoinQty * limitPrice;
    const clientOrderId = new BN(12345);
    const triggerPrice = 20;

    let stoplossStateAccount = await newBuy(limitPrice, clientOrderId, triggerPrice, maxCoinQty, maxPcQty);

    let AMEND_ACCOUNTS = {
      stoplossState: stoplossStateAccount.publicKey,
      coinWallet: ORDERBOOK_ENV.godA,
      pcWallet: ORDERBOOK_ENV.godUsdc,
      stoplossPayingVault: BUY_NEW_ORDER_ACCOUNTS["stoplossQuoteVault"],
      authority: program.provider.wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      vaultOwner: stoplossPDA
    };

    // amend up
    await amendBuy(5.11234, 7.334, 21.22, market, clientOrderId, AMEND_ACCOUNTS, stoplossStateAccount, buyAmount, limitPrice);

    // amend down
    await amendBuy(3.12233, 5.221, 22.55, market, clientOrderId, AMEND_ACCOUNTS, stoplossStateAccount, 5.11234, 7.334);
  });





  async function amendSell(newSize, newLimitPrice, newTriggerPrice, market, clientOrderId, AMEND_ACCOUNTS, stoplossStateAccount, previousQty) {

    let [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await withBalanceChange(
      program.provider,
      [ORDERBOOK_ENV.godA, ORDERBOOK_ENV.godUsdc, SELL_NEW_ORDER_ACCOUNTS.stoplossBaseVault, SELL_NEW_ORDER_ACCOUNTS.stoplossQuoteVault],
      async () => {

        await program.rpc.amendOrder(
          market.priceNumberToLots(newLimitPrice),
          clientOrderId,
          new BN(newSize * 10 ** 6),
          market.priceNumberToLots(newTriggerPrice),
          {
            accounts: AMEND_ACCOUNTS,
          }
        );
      }
    );

    let sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
    assert.ok(newSize * 10 ** 6 === sls.coinLeavesQty.toNumber());
    assert.ok(newSize * 10 ** 6 === sls.maxCoinQty.toNumber());
    assert.ok(newLimitPrice === market.priceLotsToNumber(sls.limitPrice));
    assert.ok(newTriggerPrice === market.priceLotsToNumber(sls.triggerPrice));
    assert.ok(stoplossBaseChange === parseFloat((newSize - previousQty).toFixed(5)));
    assert.ok(-tokenAChange === stoplossBaseChange);
    assert.ok(usdcChange === stoplossQuoteChange);
    return { sls, newSize };
  }

  async function amendBuy(newSize, newLimitPrice, newTriggerPrice, market, clientOrderId, AMEND_ACCOUNTS, stoplossStateAccount, previousQty, previousLimit) {

    let [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await withBalanceChange(
      program.provider,
      [ORDERBOOK_ENV.godA, ORDERBOOK_ENV.godUsdc, SELL_NEW_ORDER_ACCOUNTS.stoplossBaseVault, SELL_NEW_ORDER_ACCOUNTS.stoplossQuoteVault],
      async () => {

        await program.rpc.amendOrder(
          market.priceNumberToLots(newLimitPrice),
          clientOrderId,
          new BN(newSize * newLimitPrice * 10 ** 6),
          market.priceNumberToLots(newTriggerPrice),
          {
            accounts: AMEND_ACCOUNTS,
          }
        );
      }
    );

    // use integers, like on chain program does
    let usdDelta = (Math.floor(previousQty * 10 ** 6 * previousLimit) - Math.floor(newSize * 10 ** 6 * newLimitPrice)) / 10 ** 6;

    let sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
    assert.ok(Math.floor(newSize * newLimitPrice * 10 ** 6) === sls.pcLeavesQty.toNumber());
    assert.ok(Math.floor(newSize * newLimitPrice * 10 ** 6) === sls.maxPcQty.toNumber());
    assert.ok(newLimitPrice === market.priceLotsToNumber(sls.limitPrice));
    assert.ok(newTriggerPrice === market.priceLotsToNumber(sls.triggerPrice));
    assert.ok(stoplossQuoteChange === -usdDelta);
    assert.ok(usdcChange === usdDelta)
    assert.ok(tokenAChange === stoplossBaseChange);
    return { sls, newSize };
  }

  async function executeBuy(baseQuantity, limitPrice, market, reuseUnfilled = false) {
    let [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await withBalanceChange(
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

  async function executeSell(baseQuantity, limitPrice, market, reuseUnfilled = false) {
    let [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await withBalanceChange(
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
