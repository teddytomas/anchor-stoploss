const assert = require("assert");
const anchor = require("@project-serum/anchor");
const BN = anchor.BN;

const serumCmn = require("@project-serum/common");
const Market = require("@project-serum/serum").Market;
const TOKEN_PROGRAM_ID = require("@solana/spl-token").TOKEN_PROGRAM_ID;
const utils = require("./utils");

// Taker fee rate (bps).
const TAKER_FEE = 0.0022;

describe("multi-amends-partial-fills", () => {
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



  // it("Amend a buy order with fills", async () => {

  //   // target 1.2 of base, which is 1.2*6.041 quote, ie 7.2492
  //   const buyAmount = 20.2222;
  //   const limitPrice = 6.041; // TOB price
  //   const maxCoinQty = buyAmount * 10 ** 6 // 6 dp
  //   const maxPcQty = maxCoinQty * limitPrice;
  //   const clientOrderId = new BN(12345);
  //   const triggerPrice = 20;
  //   const usdcBefore = (await getUsdc()).amount;

  //   let stoplossStateAccount = await newBuy(limitPrice, clientOrderId, triggerPrice, maxCoinQty, maxPcQty);

  //   let sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
  //   EXECUTE_BUY_ORDER_ACCOUNTS["stoplossState"] = stoplossStateAccount.publicKey;

  //   let [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await executeBuy(1, limitPrice, market, true);
  //   sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
  //   let totalUsdcChange = ((await getUsdc()).amount.toNumber() - usdcBefore.toNumber()) / 10 ** 6;
  //   assert.ok(tokenAChange === 0.9);
  //   assert.ok(totalUsdcChange.toFixed(5) === (-buyAmount * limitPrice).toFixed(5))
  //   assert.ok(sls.coinCumQty.toNumber() === 900000);
  //   let expectedFillAmt = Math.ceil(0.9 * (1 + TAKER_FEE) * limitPrice * 10 ** 6);
  //   assert.ok(sls.pcCumQty.toNumber() === expectedFillAmt);
  //   let pcLeavesQty = Math.floor((maxCoinQty * limitPrice) - expectedFillAmt);
  //   assert.ok(sls.pcLeavesQty.toNumber() === pcLeavesQty);


  //   [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await executeBuy(1, limitPrice, market, true);
  //   sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
  //   assert.ok(tokenAChange === 0.9);
  //   assert.ok(sls.coinCumQty.toNumber() === 1800000);
  //   expectedFillAmt = Math.ceil(0.9 * (1 + TAKER_FEE) * limitPrice * 10 ** 6);
  //   assert.ok(sls.pcCumQty.toNumber() === 2 * expectedFillAmt);
  //   pcLeavesQty = Math.floor((maxCoinQty * limitPrice) - (2 * expectedFillAmt));
  //   assert.ok(sls.pcLeavesQty.toNumber() === pcLeavesQty);


  //   [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await executeBuy(1, limitPrice, market, true);
  //   sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
  //   assert.ok(tokenAChange === 0.9);
  //   assert.ok(sls.coinCumQty.toNumber() === 2700000);
  //   expectedFillAmt = Math.ceil(0.9 * (1 + TAKER_FEE) * limitPrice * 10 ** 6);
  //   assert.ok(sls.pcCumQty.toNumber() === 3 * expectedFillAmt);
  //   pcLeavesQty = Math.floor((maxCoinQty * limitPrice) - (3 * expectedFillAmt));
  //   assert.ok(sls.pcLeavesQty.toNumber() === pcLeavesQty);


  //   let AMEND_ACCOUNTS = {
  //     stoplossState: stoplossStateAccount.publicKey,
  //     coinWallet: ORDERBOOK_ENV.godA,
  //     pcWallet: ORDERBOOK_ENV.godUsdc,
  //     stoplossPayingVault: BUY_NEW_ORDER_ACCOUNTS["stoplossQuoteVault"],
  //     authority: program.provider.wallet.publicKey,
  //     tokenProgram: TOKEN_PROGRAM_ID,
  //     vaultOwner: stoplossPDA
  //   };

  //   // amend up
  //   await amendBuy(50.11234, 7.334, 21.22, market, clientOrderId, AMEND_ACCOUNTS, stoplossStateAccount, buyAmount, limitPrice);

  //   // amend down
  //   await amendBuy(30.12233, 5.221, 22.55, market, clientOrderId, AMEND_ACCOUNTS, stoplossStateAccount, 50.11234, 7.334);

  //   try {

  //     // smaller qty than already filled
  //     await amendBuy(2.12233, 5.221, 22.55, market, clientOrderId, AMEND_ACCOUNTS, stoplossStateAccount, 30.12233, 5.221);
  //     assert.ok(false);

  //   } catch (err) {
  //     const errMsg =
  //       "Order has already filled more than requested amend size. Rejecting Amend";
  //     assert.equal(err.toString(), errMsg);
  //   }

    
  //   try {

  //     // trying to execute outside parent limit - just a safety check while here
  //     await executeBuy(1, limitPrice, market, true);
  //     assert.ok(false);

  //   } catch (err) {
  //     const errMsg =
  //       "Attempting to execute outside parent limit price. Rejecting Execute instruction";
  //     assert.equal(err.toString(), errMsg);
  //   }

  //   await amendBuy(20.12233, 7, 22.55, market, clientOrderId, AMEND_ACCOUNTS, stoplossStateAccount, 30.12233, 5.221);

  //   [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await executeBuy(1, limitPrice, market, true);
  //   sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
  //   assert.ok(tokenAChange === 0.9);
  //   assert.ok(sls.coinCumQty.toNumber() === 3600000);
  //   expectedFillAmt = Math.ceil(0.9 * (1 + TAKER_FEE) * limitPrice * 10 ** 6);
  //   assert.ok(sls.pcCumQty.toNumber() === 4 * expectedFillAmt);
  //   pcLeavesQty = Math.floor(sls.maxPcQty - (4 * expectedFillAmt));
  //   assert.ok(sls.pcLeavesQty.toNumber() === pcLeavesQty);

  // });








  // it("Amend a SELL order with fills", async () => {

  //   const maxCoinQty = 20.2; // size we target, ie 13.2088
  //   const maxPcQty = new BN(Number.MAX_SAFE_INTEGER);
  //   const limitPrice = 6.004;
  //   const clientOrderId = new BN(1234567);
  //   const triggerPrice = 20;
  //   const tokenABefore = (await getA()).amount;
  //   const usdcBefore = (await getUsdc()).amount;


  //   let stoplossStateAccount = await newSell(limitPrice, clientOrderId, triggerPrice, maxCoinQty, maxPcQty);


  //   EXECUTE_SELL_ORDER_ACCOUNTS["stoplossState"] = stoplossStateAccount.publicKey;

  //   let [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await executeSell(0.5, limitPrice, market, true);
  //   let totalUsdcChange = ((await getUsdc()).amount.toNumber() - usdcBefore.toNumber()) / 10 ** 6;
  //   let totalTokenAChange = ((await getA()).amount.toNumber() - tokenABefore.toNumber()) / 10 ** 6;
  //   let expectedFillAmount = Math.floor(0.5 * limitPrice * (1 - TAKER_FEE) * 10 ** 6) / 10 ** 6;
  //   // NOTE - not sure this is correct - but go with it for now
  //   assert.ok(tokenAChange === 0);
  //   assert.ok(totalTokenAChange === -maxCoinQty);
  //   assert.ok((totalUsdcChange + stoplossQuoteChange ).toFixed(6)  === expectedFillAmount.toFixed(6));
  //   assert.ok(stoplossBaseChange === -0.5);
  //   //assert.ok(stoplossQuoteChange === 0);
  //   sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
  //   assert.ok(sls.maxCoinQty.toNumber() === maxCoinQty * 10 ** 6);
  //   assert.ok(sls.coinLeavesQty.toNumber() === (maxCoinQty * 10 ** 6) - (0.5 * 10 ** 6));
  //   assert.ok(sls.coinCumQty.toNumber() === 0.5 * 10 ** 6);
  //   // small hacks to make it 5 sf
  //   assert.ok((sls.pcCumQty.toNumber() / 10 ** 6).toFixed(6) === (expectedFillAmount).toFixed(6));
  //   assert.ok(sls.avgPrice.toNumber() === 5990);
  //   assert.ok(sls.lastPrice.toNumber() === 5990);


  //   [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await executeSell(0.5, limitPrice, market, true);
  //   totalUsdcChange = ((await getUsdc()).amount.toNumber() - usdcBefore.toNumber()) / 10 ** 6;
  //   totalTokenAChange = ((await getA()).amount.toNumber() - tokenABefore.toNumber()) / 10 ** 6;
  //   expectedFillAmount = Math.floor(0.5 * limitPrice * (1 - TAKER_FEE) * 10 ** 6) / 10 ** 6;
  //   assert.ok(tokenAChange === 0);
  //   assert.ok(totalTokenAChange === -maxCoinQty);
  //   assert.ok(totalUsdcChange.toFixed(6) === (2 * expectedFillAmount).toFixed(6));
  //   assert.ok(stoplossBaseChange === -0.5);
  //   assert.ok(stoplossQuoteChange === 0);
  //   sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
  //   assert.ok(sls.maxCoinQty.toNumber() === maxCoinQty * 10 ** 6);
  //   assert.ok(sls.coinLeavesQty.toNumber() === (maxCoinQty * 10 ** 6) - (1 * 10 ** 6));
  //   assert.ok(sls.coinCumQty.toNumber() === 1 * 10 ** 6);
  //   // small hacks to make it 5 sf
  //   assert.ok((sls.pcCumQty.toNumber() / 10 ** 6).toFixed(5) === (2 * expectedFillAmount).toFixed(5));
  //   assert.ok(sls.avgPrice.toNumber() === 5990);
  //   assert.ok(sls.lastPrice.toNumber() === 5990);


  //   let AMEND_ACCOUNTS = {
  //     stoplossState: stoplossStateAccount.publicKey,
  //     coinWallet: ORDERBOOK_ENV.godA,
  //     pcWallet: ORDERBOOK_ENV.godUsdc,
  //     stoplossPayingVault: SELL_NEW_ORDER_ACCOUNTS["stoplossBaseVault"],
  //     authority: program.provider.wallet.publicKey,
  //     tokenProgram: TOKEN_PROGRAM_ID,
  //     vaultOwner: stoplossPDA
  //   };

  //   // amend up
  //   await amendSell(50.11234, 7.334, 21.22, market, clientOrderId, AMEND_ACCOUNTS, stoplossStateAccount, maxCoinQty, limitPrice);

  //   // amend down
  //   await amendSell(30.12233, 10.221, 22.55, market, clientOrderId, AMEND_ACCOUNTS, stoplossStateAccount, 50.11234, 7.334);

  //   try {

  //     // smaller qty than already filled
  //     await amendSell(0.92233, 5.221, 22.55, market, clientOrderId, AMEND_ACCOUNTS, stoplossStateAccount, 50.11234, 5.221);
  //     assert.ok(false);

  //   } catch (err) {
  //     const errMsg =
  //       "Order has already filled more than requested amend size. Rejecting Amend";
  //     assert.equal(err.toString(), errMsg);
  //   }

  //   try {

  //     // trying to execute outside parent limit - just a safety check while here
  //     await executeSell(0.5, limitPrice, market, true);
  //     assert.ok(false);

  //   } catch (err) {
  //     const errMsg =
  //       "Attempting to execute outside parent limit price. Rejecting Execute instruction";
  //     assert.equal(err.toString(), errMsg);
  //   }

  //   await amendSell(19.92233, 5.221, 22.55, market, clientOrderId, AMEND_ACCOUNTS, stoplossStateAccount, 30.12233, 10.221);

  //   [tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange] = await executeSell(0.5, limitPrice, market, true);
  //   totalUsdcChange = ((await getUsdc()).amount.toNumber() - usdcBefore.toNumber()) / 10 ** 6;
  //   totalTokenAChange = ((await getA()).amount.toNumber() - tokenABefore.toNumber()) / 10 ** 6;
  //   expectedFillAmount = Math.floor(0.5 * limitPrice * (1 - TAKER_FEE) * 10 ** 6) / 10 ** 6;
  //   assert.ok(tokenAChange === 0);
  //   assert.ok(totalTokenAChange === -19.92233);
  //   assert.ok(totalUsdcChange.toFixed(6) === (3*expectedFillAmount).toFixed(6));
  //   assert.ok(stoplossBaseChange === -0.5);
  //   assert.ok(stoplossQuoteChange === 0);
  //   sls = await program.account.stoplossState.fetch(stoplossStateAccount.publicKey);
  //   assert.ok(sls.maxCoinQty.toNumber() === 19.92233 * 10 ** 6);
  //   assert.ok(sls.coinLeavesQty.toNumber() === (19.92233 * 10 ** 6) - (3 * 0.5 * 10 ** 6));
  //   assert.ok(sls.coinCumQty.toNumber() === 3 * 0.5 * 10 ** 6);
  //   assert.ok((sls.pcCumQty.toNumber()).toFixed(0) === (3 * expectedFillAmount * 10 **6 ).toFixed(0));
  //   assert.ok(sls.avgPrice.toNumber() === 5990);
  //   assert.ok(sls.lastPrice.toNumber() === 5990);

  // });






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
    assert.ok(sls.maxCoinQty.toNumber() - sls.coinCumQty.toNumber() === sls.coinLeavesQty.toNumber());
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
      [ORDERBOOK_ENV.godA, ORDERBOOK_ENV.godUsdc, BUY_NEW_ORDER_ACCOUNTS.stoplossBaseVault, BUY_NEW_ORDER_ACCOUNTS.stoplossQuoteVault],
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
    assert.ok(Math.floor(newSize * newLimitPrice * 10 ** 6) === sls.maxPcQty.toNumber());
    assert.ok(sls.maxPcQty.toNumber() - sls.pcCumQty.toNumber() === sls.pcLeavesQty.toNumber());
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








async function createOrder(program, NEW_ORDER_ACCOUNTS, ORDERBOOK_ENV, market, side, limitPrice, clientOrderId, triggerPrice, maxCoinQty, maxPcQty, signalProvider) {
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
  return [stoplossStateAccount, tokenAChange, usdcChange, stoplossBaseChange, stoplossQuoteChange];
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
