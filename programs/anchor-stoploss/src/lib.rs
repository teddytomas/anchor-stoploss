use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program;
use anchor_spl::dex::serum_dex::state::MarketState;
//use anchor_spl::dex::serum_dex::state::OpenOrders;
use anchor_spl::token::{self, TokenAccount, Transfer};
use borsh::{BorshDeserialize, BorshSerialize};
use serum_dex::instruction::{MarketInstruction, NewOrderInstructionV3};
use serum_dex::matching::{OrderType as SerumOrderType, Side as SerumSide};
use std::num::NonZeroU64;

use base64;
use bincode;
use serde::{Deserialize, Serialize};

#[program]
pub mod anchor_stoploss {

    use super::*;

    /// Called by the stoploss server when receiving an order for a market that it has not previously
    /// seen. The Stoploss server has to create the open orders account
    /// because it is the owner. ie it cannot be set from the UI because it needs to use the
    /// private key.
    ///
    /// Arguments:
    ///
    pub fn initialise_open_orders<'info>(ctx: Context<'_, '_, '_, 'info, InitialiseOpenOrders<'info>>) -> Result<()> {
        // TODO - not sure how best to check this.
        msg!("initialising open orders {:?}", &ctx.accounts.stoploss_open_orders.key);
        // currently another transaction could modify the open orders account
        // if ctx.accounts.stoploss_state.stoploss_open_orders == OrdStatus::Cancelled {
        //     msg!("order already has open orders account");
        //     return Err(ErrorCode::AttemptingToExecuteCancelledOrder.into());
        // }
        if ctx.accounts.authority.key != &ctx.accounts.stoploss_state.signal_provider {
            msg!("Incorrect Signal Provider account was provided. Should be algo server sending InitialiseOpenOrders instructions.");
            return Err(ErrorCode::IncorrectSignalProviderAccount.into());
        }

        let stoploss = &mut ctx.accounts.stoploss_state;
        stoploss.stoploss_open_orders = *ctx.accounts.stoploss_open_orders.key;
        stoploss.ord_status = OrdStatus::New;

        let update = StoplossOrderUpdate {
            own_address: *stoploss.to_account_info().key,
        };

        let encoded = bincode::serialize(&update).unwrap();
        msg!("STOPLOSS_PARENT_UPDATE: {:?}", base64::encode(&encoded));

        Ok(())
    }

    /// Creates a stoploss order with trigger price and limit price etc.
    /// Immediately transfers funds into the stoploss vaults so it can execute
    /// asynchronously.
    ///
    /// Stoploss is used when a user is long (short) and they want to sell (buy)
    /// to cover their exposure if the market moves against them.    ///
    ///
    /// Arguments:
    ///
    /// * `side`            - buy or sell.
    /// * `limit_price`     - The limit price the order cannot trade outside of.
    /// * `client_order_id` - Unique identifier for the parent order.
    /// * `trigger_price`   - The price at which the stoploss is activated. For
    /// example a trigger price of 10 when buying means the order will trigger when
    /// the market price goes *above* 10. Vice versa for sells.
    /// * `max_coin_qty`    - max_coin_qty tradeable.
    /// * `max_pc_qty`      - max_pc_qty tradeable.
    /// * `signal_provider` - The acount that can trigger child order executions.
    ///
    pub fn new_order<'info>(
        ctx: Context<'_, '_, '_, 'info, NewOrder<'info>>,
        side: Side,
        limit_price: u64,
        client_order_id: u64,
        trigger_price: u64,
        max_coin_qty: u64,
        max_pc_qty: u64,
        should_create_open_orders: bool,
    ) -> Result<()> {
        let (_pda, bump_seed) = Pubkey::find_program_address(&[b"stoploss"], ctx.program_id);
        let seeds = &[&b"stoploss"[..], &[bump_seed]];

        if side == Side::Bid {
            msg!("buying transferring {:?} from pc", max_pc_qty);
        } else {
            msg!("selling transferring {:?} from coin", max_coin_qty);
        }
        // these should be Associated Token Accounts
        match side {
            Side::Bid => token::transfer(ctx.accounts.into_transfer_to_buy_context().with_signer(&[&seeds[..]]), max_pc_qty)?,
            Side::Ask => token::transfer(ctx.accounts.into_transfer_to_sell_context().with_signer(&[&seeds[..]]), max_coin_qty)?,
        };

        let sl_coin = token::accessor::amount(&ctx.accounts.stoploss_base_vault).unwrap();
        let sl_pc = token::accessor::amount(&ctx.accounts.stoploss_quote_vault).unwrap();
        msg!("vaults now contain sl_coin {:?} sl_pc {:?}", sl_coin, sl_pc);

        let stoploss = &mut ctx.accounts.stoploss_state;
        stoploss.own_address = *stoploss.to_account_info().key;
        stoploss.market = *ctx.accounts.market.market.key;
        //stoploss.stoploss_open_orders = *ctx.accounts.stoploss_open_orders.key;
        stoploss.request_queue = *ctx.accounts.market.request_queue.key;
        stoploss.event_queue = *ctx.accounts.market.event_queue.key;
        stoploss.bids = *ctx.accounts.market.bids.key;
        stoploss.asks = *ctx.accounts.market.asks.key;
        stoploss.payer = *ctx.accounts.market.order_payer_token_account.key;

        stoploss.client_coin_wallet = *ctx.accounts.market.coin_wallet.to_account_info().key;
        stoploss.client_pc_wallet = *ctx.accounts.market.pc_wallet.to_account_info().key;

        stoploss.stoploss_base_vault = *ctx.accounts.stoploss_base_vault.key;
        stoploss.stoploss_quote_vault = *ctx.accounts.stoploss_quote_vault.key;

        stoploss.dex_program = *ctx.accounts.dex_program.key;
        stoploss.pda = *ctx.accounts.pda.key;
        stoploss.stoploss_program = *ctx.accounts.stoploss_program.key;
        stoploss.vault_signer = *ctx.accounts.market.vault_signer.key;
        stoploss.token_program = *ctx.accounts.token_program.key;

        stoploss.side = side;
        stoploss.ord_status = OrdStatus::New;
        stoploss.limit_price = limit_price;
        stoploss.client_order_id = client_order_id;
        stoploss.trigger_price = trigger_price;
        stoploss.max_coin_qty = max_coin_qty;
        stoploss.max_pc_qty = max_pc_qty;

        stoploss.coin_leaves_qty = max_coin_qty;
        stoploss.pc_leaves_qty = max_pc_qty;

        stoploss.signal_provider = *ctx.accounts.signal_provider.key;
        stoploss.amend_authority = *ctx.accounts.authority.key;
        stoploss.child_order_count = 0;

        stoploss.coin_mint = *ctx.accounts.market.coin_mint.key;
        stoploss.pc_mint = *ctx.accounts.market.pc_mint.key;
        stoploss.should_create_open_orders = should_create_open_orders;
        // always assume pending init for now - better versions in the future
        // will check the open orders key properly and see if its populated
        // TODO - only set pending init if required
        stoploss.ord_status = OrdStatus::PendingInit;
        msg!("checking status {:?}", ctx.accounts.market.open_orders.key.to_string());
        if ctx.accounts.market.open_orders.key.to_string().eq("11111111111111111111111111111111") {
            msg!("should set pending init");
            stoploss.ord_status = OrdStatus::PendingInit;
        }

        match side {
            Side::Bid => stoploss.client_paying_account = *ctx.accounts.market.pc_wallet.to_account_info().key,
            Side::Ask => stoploss.client_paying_account = *ctx.accounts.market.coin_wallet.to_account_info().key,
        }

        let update = StoplossOrderUpdate {
            own_address: *stoploss.to_account_info().key,
        };

        let encoded = bincode::serialize(&update).unwrap();
        msg!("STOPLOSS_PARENT_UPDATE: {:?}", base64::encode(&encoded));

        Ok(())
    }

    /// Execute a child order for a previously created parent order.
    ///
    /// The order can be for a smaller amount than the parent order as this allows
    /// strategies to split a large order into smaller chunks.
    ///
    /// Any portion that is filled is settled back to the original client account.
    ///
    /// Any portion that remains unfilled is settled according to reuse_unfilled flag.
    ///
    ///
    /// Arguments:
    ///
    /// * `execute_qty`        - The portion of the parent order to execute.
    ///     The execute_qty is specified in base (ie the coin token) and the quote
    ///     (ie the pc token) is automatically calculated using the execute_limit.
    /// * `execute_limit`      - The limit price to use when executing
    ///     against the DEX.
    /// * `reuse_unfilled`     - The DEX may not fully fill an order due to limit price
    ///     constraints, or orderbook liquidity availabilty (this is normal). However
    ///     when settling the unfilled qty can be transferred back to the client according to this flag.
    ///     eg) for longer running orders spanning multiple executions it is undesirable for an
    ///     order to run the whole qty as an IOC and the order will more likely cancel without fully filling.
    ///     The reuse_unfilled flag when set to true allows an order to stay open and
    ///     run multiple execution execution cycles (eg for an order that runs for a long period of time).
    ///     When set to false it operates like an IOC order and any funds are transferred
    ///     back to the client after one and only one execution attempt.
    ///     Put more simply - if you want an order like a TWAP to run for an hour say
    ///     you cant have the first child order you send to the market cancel the whole thing.
    pub fn execute_order<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteOrder<'info>>,
        execute_qty: u64,
        execute_limit: u64,
        reuse_unfilled: bool,
    ) -> Result<()> {
        if ctx.accounts.stoploss_state.ord_status == OrdStatus::Cancelled {
            msg!("order already cancelled");
            return Err(ErrorCode::AttemptingToExecuteCancelledOrder.into());
        }
        if ctx.accounts.stoploss_state.ord_status == OrdStatus::Filled {
            msg!("order already filled");
            return Err(ErrorCode::AttemptingToExecuteFilledOrder.into());
        }
        if !ctx.accounts.authority.is_signer {
            msg!("The signal provider's signature is required.");
            return Err(ErrorCode::MissingSignalProviderSignature.into());
        }
        if ctx.accounts.authority.key != &ctx.accounts.stoploss_state.signal_provider {
            msg!("Incorrect Signal Provider account was provided. Should be algo server sending execute instructions.");
            return Err(ErrorCode::IncorrectSignalProviderAccount.into());
        }
        if (ctx.accounts.stoploss_state.side == Side::Bid && execute_limit > ctx.accounts.stoploss_state.limit_price)
            || (ctx.accounts.stoploss_state.side == Side::Ask && execute_limit < ctx.accounts.stoploss_state.limit_price)
        {
            msg!("parent limit {:?} execute_limit {:?}", ctx.accounts.stoploss_state.limit_price, execute_limit);
            return Err(ErrorCode::AttemptingToExecuteOutsideParentLimit.into());
        }
        // TODO: also validate that the vault accounts and and all other market accounts match the onchain accounts
        // stored in the StoplossState account

        // NOTE - if using the market vaults of the dex it still allows a transaction, but it looks very wrong! (the signs are reversed)
        // dont think it should be able to trade using the market vault accounts... ATTACK VECTOR ? TODO: confirm

        // Token balances before the trade.
        let mut pos_changes: PositionChanges = Default::default();
        let sl_coin = token::accessor::amount(&ctx.accounts.stoploss_base_vault).unwrap();
        let sl_pc = token::accessor::amount(&ctx.accounts.stoploss_quote_vault).unwrap();
        pos_changes.record_before(
            ctx.accounts.stoploss_state.side,
            ctx.accounts.market.coin_wallet.amount,
            ctx.accounts.market.pc_wallet.amount,
            sl_coin,
            sl_pc,
        );

        let (s, sl_paying_account, max_coin_qty, max_pc_qty) = match ctx.accounts.stoploss_state.side {
            Side::Bid => (
                SerumSide::Bid,
                &ctx.accounts.stoploss_quote_vault,
                u64::MAX, // doesnt matter what you set the coin qty to for buys (as long as its large I guess)
                execute_qty,
            ),
            Side::Ask => (
                SerumSide::Ask,
                &ctx.accounts.stoploss_base_vault,
                coin_lots(&ctx.accounts.market.market, execute_qty, &ctx.accounts.dex_program.key),
                u64::MAX,
            ),
        };

        let parent_child_composite_id = concat(&[ctx.accounts.stoploss_state.client_order_id, ctx.accounts.stoploss_state.child_order_count]);

        msg!(
            "placing {:?} order with execute_coin size {:?}, execute_pc size {:?}",
            s,
            max_coin_qty,
            max_pc_qty
        );

        let new_order = NewOrderInstructionV3 {
            side: s,
            limit_price: NonZeroU64::new(ctx.accounts.stoploss_state.limit_price).unwrap(),
            max_coin_qty: NonZeroU64::new(max_coin_qty).unwrap(),
            max_native_pc_qty_including_fees: NonZeroU64::new(max_pc_qty).unwrap(),
            order_type: SerumOrderType::ImmediateOrCancel,
            client_order_id: parent_child_composite_id,
            self_trade_behavior: serum_dex::instruction::SelfTradeBehavior::DecrementTake,
            limit: 65535,
        };

        let data = MarketInstruction::NewOrderV3(new_order).pack();
        let instruction = Instruction {
            program_id: *ctx.accounts.dex_program.key,
            data,
            accounts: vec![
                AccountMeta::new(*ctx.accounts.market.market.key, false),
                AccountMeta::new(*ctx.accounts.market.open_orders.key, false),
                AccountMeta::new(*ctx.accounts.market.request_queue.key, false),
                AccountMeta::new(*ctx.accounts.market.event_queue.key, false),
                AccountMeta::new(*ctx.accounts.market.bids.key, false),
                AccountMeta::new(*ctx.accounts.market.asks.key, false),
                AccountMeta::new(*sl_paying_account.key, false),
                AccountMeta::new_readonly(*ctx.accounts.pda.key, true),
                AccountMeta::new(*ctx.accounts.market.coin_vault.key, false),
                AccountMeta::new(*ctx.accounts.market.pc_vault.key, false),
                AccountMeta::new_readonly(spl_token::ID, false),
                AccountMeta::new_readonly(*ctx.accounts.rent.to_account_info().key, false),
            ],
        };

        let (_pda, nonce) = Pubkey::find_program_address(&[b"stoploss"], &ctx.accounts.stoploss_program.key);

        program::invoke_signed(
            &instruction,
            &[
                ctx.accounts.market.market.clone(),
                ctx.accounts.market.open_orders.clone(),
                ctx.accounts.market.request_queue.clone(),
                ctx.accounts.market.event_queue.clone(),
                ctx.accounts.market.bids.clone(),
                ctx.accounts.market.asks.clone(),
                sl_paying_account.clone(),
                ctx.accounts.pda.clone(),
                ctx.accounts.market.coin_vault.clone(),
                ctx.accounts.market.pc_vault.clone(),
                ctx.accounts.rent.to_account_info().clone(),
            ],
            &[&[&b"stoploss"[..], &[nonce]]],
        )?;

        // settle
        let (settle_to_coin_wallet, settle_to_pc_wallet) = match reuse_unfilled {
            true => (ctx.accounts.stoploss_base_vault.clone(), ctx.accounts.stoploss_quote_vault.clone()),
            false => (
                ctx.accounts.market.coin_wallet.to_account_info().clone(),
                ctx.accounts.market.pc_wallet.to_account_info().clone(),
            ),
        };

        let data = MarketInstruction::SettleFunds.pack();
        let accounts: Vec<AccountMeta> = vec![
            AccountMeta::new(*ctx.accounts.market.market.key, false),
            AccountMeta::new(*ctx.accounts.stoploss_open_orders.key, false),
            AccountMeta::new_readonly(*ctx.accounts.pda.key, true),
            AccountMeta::new(*ctx.accounts.market.coin_vault.key, false),
            AccountMeta::new(*ctx.accounts.market.pc_vault.key, false),
            AccountMeta::new(*settle_to_coin_wallet.key, false),
            AccountMeta::new(*settle_to_pc_wallet.key, false),
            AccountMeta::new_readonly(*ctx.accounts.market.vault_signer.key, false),
            AccountMeta::new_readonly(*ctx.accounts.token_program.key, false),
        ];
        let instruction = Instruction {
            program_id: *ctx.accounts.dex_program.key,
            data,
            accounts,
        };

        program::invoke_signed(
            &instruction,
            &[
                ctx.accounts.market.market.clone(),
                ctx.accounts.stoploss_open_orders.clone(),
                ctx.accounts.pda.clone(),
                ctx.accounts.market.coin_vault.clone(),
                ctx.accounts.market.pc_vault.clone(),
                settle_to_coin_wallet.clone(),
                settle_to_pc_wallet.clone(),
                ctx.accounts.market.vault_signer.clone(),
                ctx.accounts.token_program.clone(),
            ],
            &[&[&b"stoploss"[..], &[nonce]]],
        )?;

        let sl_coin = token::accessor::amount(&ctx.accounts.stoploss_base_vault)?;
        let sl_pc = token::accessor::amount(&ctx.accounts.stoploss_quote_vault)?;
        pos_changes.record_after(
            ctx.accounts.market.coin_wallet.reload()?.amount,
            ctx.accounts.market.pc_wallet.reload()?.amount,
            sl_coin,
            sl_pc,
        );

        ctx.accounts.stoploss_state.child_order_count += 1;

        // for buys the unfilled portion is in client_pc_delta and is given back to the client
        // for sells the unfilled portion is in client_coin_delta and is given back to the client
        // account for that here because it is not filled
        let (mut pc_qty_filled, mut coin_qty_filled) = match s {
            SerumSide::Bid => (pos_changes.sl_pc_delta() - pos_changes.client_pc_delta(), pos_changes.client_coin_delta()),
            SerumSide::Ask => (pos_changes.client_pc_delta(), pos_changes.sl_coin_delta() - pos_changes.client_coin_delta()),
        };

        if !reuse_unfilled {
            if pc_qty_filled == 0 && coin_qty_filled == 0 {
                msg!(
                    "nothing filled apparently - setting to cancelled. cl_coin_del={:?} cl_pc_del={:?}",
                    coin_qty_filled,
                    pc_qty_filled
                );
                ctx.accounts.stoploss_state.pc_leaves_qty = 0;
                ctx.accounts.stoploss_state.coin_leaves_qty = 0;
                ctx.accounts.stoploss_state.pc_cum_qty = 0;
                ctx.accounts.stoploss_state.coin_cum_qty = 0;
                ctx.accounts.stoploss_state.ord_status = OrdStatus::Cancelled;
            } else {
                ctx.accounts.stoploss_state.pc_leaves_qty = ctx.accounts.stoploss_state.pc_leaves_qty.checked_sub(pc_qty_filled).unwrap();
                ctx.accounts.stoploss_state.coin_leaves_qty = ctx.accounts.stoploss_state.coin_leaves_qty.checked_sub(coin_qty_filled).unwrap();

                // if it doesnt fully fill then the client is returned some coins, depending on reuse_unfilled
                ctx.accounts.stoploss_state.pc_cum_qty = ctx.accounts.stoploss_state.pc_cum_qty.checked_add(pc_qty_filled).unwrap();
                ctx.accounts.stoploss_state.coin_cum_qty = ctx.accounts.stoploss_state.coin_cum_qty.checked_add(coin_qty_filled).unwrap();

                ctx.accounts.stoploss_state.last_price =
                    calculate_price_lots(pc_qty_filled, coin_qty_filled, &ctx.accounts.market.market, &ctx.accounts.dex_program.key);

                ctx.accounts.stoploss_state.avg_price = calculate_price_lots(
                    ctx.accounts.stoploss_state.pc_cum_qty,
                    ctx.accounts.stoploss_state.coin_cum_qty,
                    &ctx.accounts.market.market,
                    &ctx.accounts.dex_program.key,
                );

                msg!(
                    "coin leaves {:?} pc leaves {:?}",
                    ctx.accounts.stoploss_state.coin_leaves_qty,
                    ctx.accounts.stoploss_state.pc_leaves_qty
                );

                let sl_coin = token::accessor::amount(&ctx.accounts.stoploss_base_vault).unwrap();
                let sl_pc = token::accessor::amount(&ctx.accounts.stoploss_quote_vault).unwrap();
                msg!("vault remaining sl_coin {:?} sl_pc {:?}", sl_coin, sl_pc);

                if (ctx.accounts.stoploss_state.side == Side::Bid && ctx.accounts.stoploss_state.pc_leaves_qty == 0)
                    || (ctx.accounts.stoploss_state.side == Side::Ask && ctx.accounts.stoploss_state.coin_leaves_qty == 0)
                {
                    ctx.accounts.stoploss_state.ord_status = OrdStatus::Filled;
                } else {
                    ctx.accounts.stoploss_state.ord_status = OrdStatus::Cancelled;
                }
            }
        }

        // TODO - fix this - broken after integration testing found some bugs in the more simple 
        // path where reuse_unfilled = FALSE
        // not required for demo purpose anyway
        if reuse_unfilled {
            // if no change then do nothing
            if pc_qty_filled == 0 && coin_qty_filled == 0 {
                msg!(
                    "nothing filled, apparently. side {:?} limit {:?}",
                    ctx.accounts.stoploss_state.side,
                    execute_limit
                );
                return Ok(());
            };

            // in this path the coins are left in the stoploss vaults - and we want to transfer back to the client immediately
            coin_qty_filled = coin_qty_filled + pos_changes.sl_coin_delta();
            pc_qty_filled = pc_qty_filled + pos_changes.sl_coin_delta();

            ctx.accounts.stoploss_state.pc_leaves_qty = ctx.accounts.stoploss_state.pc_leaves_qty.checked_sub(pc_qty_filled).unwrap();
            ctx.accounts.stoploss_state.coin_leaves_qty = ctx.accounts.stoploss_state.coin_leaves_qty.checked_sub(coin_qty_filled).unwrap();

            // if it doesnt fully fill then the client is returned some coins, depending on reuse_unfilled
            ctx.accounts.stoploss_state.pc_cum_qty = ctx.accounts.stoploss_state.pc_cum_qty.checked_add(pc_qty_filled).unwrap();
            ctx.accounts.stoploss_state.coin_cum_qty = ctx.accounts.stoploss_state.coin_cum_qty.checked_add(coin_qty_filled).unwrap();

            msg!(
                "pc_cum_qty {:?} coin_cum_qty {:?}",
                ctx.accounts.stoploss_state.pc_cum_qty,
                ctx.accounts.stoploss_state.coin_cum_qty
            );

            ctx.accounts.stoploss_state.last_price =
                calculate_price_lots(pc_qty_filled, coin_qty_filled, &ctx.accounts.market.market, &ctx.accounts.dex_program.key);

            ctx.accounts.stoploss_state.avg_price = calculate_price_lots(
                ctx.accounts.stoploss_state.pc_cum_qty,
                ctx.accounts.stoploss_state.coin_cum_qty,
                &ctx.accounts.market.market,
                &ctx.accounts.dex_program.key,
            );

            match s {
                SerumSide::Bid => transfer_tokens_signed(
                    ctx.accounts.stoploss_base_vault.to_account_info(),
                    ctx.accounts.market.coin_wallet.to_account_info(),
                    ctx.accounts.pda.clone(),
                    coin_qty_filled,
                    ctx.accounts.token_program.clone(),
                    &[&b"stoploss"[..], &[nonce]],
                )?,
                SerumSide::Ask => transfer_tokens_signed(
                    ctx.accounts.stoploss_quote_vault.to_account_info(),
                    ctx.accounts.market.pc_wallet.to_account_info(),
                    ctx.accounts.pda.clone(),
                    pc_qty_filled,
                    ctx.accounts.token_program.clone(),
                    &[&b"stoploss"[..], &[nonce]],
                )?,
            }

            if (ctx.accounts.stoploss_state.side == Side::Bid && ctx.accounts.stoploss_state.pc_leaves_qty == 0)
                || (ctx.accounts.stoploss_state.side == Side::Ask && ctx.accounts.stoploss_state.coin_leaves_qty == 0)
            {
                ctx.accounts.stoploss_state.ord_status = OrdStatus::Filled;
            } else {
                // seems wrong ! should be in state partially filled here...
                if ctx.accounts.stoploss_state.coin_cum_qty > 0 || ctx.accounts.stoploss_state.pc_cum_qty > 0 {
                    ctx.accounts.stoploss_state.ord_status = OrdStatus::Cancelled;
                }
            }

            ctx.accounts.stoploss_state.ord_status = OrdStatus::PartiallyFilled;
            // TODO check that transferred matches
        }

        let update = StoplossOrderUpdate {
            own_address: *ctx.accounts.stoploss_state.to_account_info().key,
        };

        let encoded = bincode::serialize(&update).unwrap();
        msg!("STOPLOSS_PARENT_UPDATE: {:?}", base64::encode(&encoded));

        let clock = Clock::get()?;

        let mut ord_status = OrdStatus::PartiallyFilled;
        if pc_qty_filled == 0 && coin_qty_filled == 0 {
            ord_status = OrdStatus::Cancelled;
        }

        let size = match ctx.accounts.stoploss_state.side {
            Side::Ask => ctx.accounts.stoploss_state.max_coin_qty,
            Side::Bid => ctx.accounts.stoploss_state.max_pc_qty / ctx.accounts.stoploss_state.limit_price,
        };

        let update = StoplossCreatedChildOrder {
            parent_address: ctx.accounts.stoploss_state.own_address,
            parent_order_id: ctx.accounts.stoploss_state.client_order_id,
            child_order_id: ctx.accounts.stoploss_state.child_order_count,
            parent_child_composite_id: parent_child_composite_id,
            market: *ctx.accounts.market.market.key,
            side: ctx.accounts.stoploss_state.side,
            requested_qty: size,
            limit_price: ctx.accounts.stoploss_state.limit_price,
            base_filled_qty: coin_qty_filled,
            quote_filled_qty: pc_qty_filled,
            price: (coin_qty_filled as f64 / pc_qty_filled as f64).to_string(),
            filled_time: clock.unix_timestamp,
            ord_status: ord_status,
            order_type: OrderType::ImmediateOrCancel,
        };

        let encoded = bincode::serialize(&update).unwrap();
        msg!("STOPLOSS_CHILD_UPDATE: {:?}", base64::encode(&encoded));

        Ok(())
    }

    /// Cancels the parent order and transfers any unfilled portion back to the client.
    ///
    ///
    /// Arguments:
    ///
    pub fn cancel_order(ctx: Context<CancelOrder>) -> ProgramResult {
        if ctx.accounts.authority.key != &ctx.accounts.stoploss_state.amend_authority {
            msg!(
                "Cancel message not sent by owner. Owner {:?} sender {:?}",
                ctx.accounts.stoploss_state.amend_authority,
                ctx.accounts.authority
            );
            return Err(ErrorCode::IncorrectAmendAccount.into());
        }
        if ctx.accounts.stoploss_state.ord_status == OrdStatus::Filled {
            msg!("Order already filled. Cannot cancel.");
            return Err(ErrorCode::OrderAlreadyFilled.into());
        }
        if ctx.accounts.stoploss_state.ord_status == OrdStatus::Cancelled {
            msg!("Order already cancelled. Cannot cancel.");
            return Err(ErrorCode::OrderAlreadyCancelled.into());
        }

        let (_pda, bump_seed) = Pubkey::find_program_address(&[b"stoploss"], ctx.program_id);
        let seeds = &[&b"stoploss"[..], &[bump_seed]];

        let (amount, receiving_wallet) = match ctx.accounts.stoploss_state.side {
            Side::Ask => (ctx.accounts.stoploss_state.coin_leaves_qty, &ctx.accounts.coin_wallet),
            Side::Bid => (ctx.accounts.stoploss_state.pc_leaves_qty, &ctx.accounts.pc_wallet),
        };

        transfer_tokens_signed(
            ctx.accounts.stoploss_paying_vault.to_account_info(),
            receiving_wallet.to_account_info(),
            ctx.accounts.vault_owner.clone(),
            amount,
            ctx.accounts.token_program.clone(),
            seeds,
        )?;

        let stoploss = &mut ctx.accounts.stoploss_state;

        // consistent with FIX - leaves is zero in terminal state
        stoploss.coin_leaves_qty = 0;
        stoploss.pc_leaves_qty = 0;

        stoploss.ord_status = OrdStatus::Cancelled;
        Ok(())
    }

    /// Amends a prevously created parent order.
    ///
    /// Any changes to the qty results in appropriate amounts being deposited/refunded
    /// to/from the stoploss vaults and client wallets respectively.
    ///
    ///
    /// Arguments:
    ///
    /// * `limit_price`        - The limit price to use when executing.
    ///     against the DEX.
    /// * `new_quantity`       - The new quantity to use on the order. Cannot amend to
    ///     a quantity that is less than already filled. Will reject the amend in this
    ///     case.
    /// * `trigger_price`      - The new trigger price to use.
    pub fn amend_order(ctx: Context<AmendOrder>, limit_price: u64, _client_order_id: u64, new_quantity: u64, trigger_price: u64) -> ProgramResult {
        if ctx.accounts.authority.key != &ctx.accounts.stoploss_state.amend_authority {
            msg!(
                "Amend message not sent by owner. Owner {:?} sender {:?}",
                ctx.accounts.stoploss_state.amend_authority,
                ctx.accounts.authority
            );
            return Err(ErrorCode::IncorrectAmendAccount.into());
        }
        if ctx.accounts.stoploss_state.ord_status == OrdStatus::Filled {
            msg!("Order already filled. Cannot amend.");
            return Err(ErrorCode::OrderAlreadyFilled.into());
        }
        if ctx.accounts.stoploss_state.ord_status == OrdStatus::Cancelled {
            msg!("Order already cancelled. Cannot amend.");
            return Err(ErrorCode::OrderAlreadyCancelled.into());
        }

        let (_pda, bump_seed) = Pubkey::find_program_address(&[b"stoploss"], ctx.program_id);
        let seeds = &[&b"stoploss"[..], &[bump_seed]];

        // calc delta and apply to the appropriate coin, then transfer in, or out

        let stoploss = &mut ctx.accounts.stoploss_state;

        match stoploss.side {
            Side::Bid => {
                if new_quantity < stoploss.pc_cum_qty {
                    msg!(
                        "trying to reduce to less than already filled. qty {:?}, pc_filled {:}?",
                        new_quantity,
                        stoploss.pc_cum_qty
                    );
                    return Err(ErrorCode::AlreadyFilledMoreThanRequestedAmendSize.into());
                } else if stoploss.max_pc_qty > new_quantity {
                    // reducing size, transfer back to client
                    // why cant I use max_pc_qty.checked_sub with on chain variables?
                    let delta = stoploss.max_pc_qty - new_quantity;
                    stoploss.pc_leaves_qty -= delta;
                    stoploss.max_pc_qty = new_quantity;
                    transfer_tokens_signed(
                        ctx.accounts.stoploss_paying_vault.to_account_info(),
                        ctx.accounts.pc_wallet.to_account_info(),
                        ctx.accounts.vault_owner.clone(),
                        delta,
                        ctx.accounts.token_program.clone(),
                        seeds,
                    )?;
                } else if stoploss.max_pc_qty < new_quantity {
                    let delta = new_quantity - stoploss.max_pc_qty;
                    stoploss.pc_leaves_qty += delta;
                    stoploss.max_pc_qty = new_quantity;
                    transfer_tokens_signed(
                        ctx.accounts.pc_wallet.to_account_info(),
                        ctx.accounts.stoploss_paying_vault.to_account_info(),
                        ctx.accounts.authority.clone(),
                        delta,
                        ctx.accounts.token_program.clone(),
                        seeds,
                    )?;
                }
            }
            Side::Ask => {
                if new_quantity < stoploss.coin_cum_qty {
                    msg!(
                        "trying to reduce to less than already filled. qty {:?}, coin_filled {:}?",
                        new_quantity,
                        stoploss.coin_cum_qty
                    );
                    return Err(ErrorCode::AlreadyFilledMoreThanRequestedAmendSize.into());
                } else if stoploss.max_coin_qty > new_quantity {
                    // reducing size, transfer back to client
                    let delta = stoploss.max_coin_qty - new_quantity;
                    stoploss.coin_leaves_qty -= delta;
                    stoploss.max_coin_qty = new_quantity;
                    transfer_tokens_signed(
                        ctx.accounts.stoploss_paying_vault.to_account_info(),
                        ctx.accounts.coin_wallet.to_account_info(),
                        ctx.accounts.vault_owner.clone(),
                        delta,
                        ctx.accounts.token_program.clone(),
                        seeds,
                    )?;
                } else if stoploss.max_coin_qty < new_quantity {
                    let delta = new_quantity - stoploss.max_coin_qty;
                    stoploss.coin_leaves_qty += delta;
                    stoploss.max_coin_qty = new_quantity;
                    transfer_tokens_signed(
                        ctx.accounts.coin_wallet.to_account_info(),
                        ctx.accounts.stoploss_paying_vault.to_account_info(),
                        ctx.accounts.authority.clone(),
                        delta,
                        ctx.accounts.token_program.clone(),
                        seeds,
                    )?;
                }
            }
        };

        stoploss.limit_price = limit_price;
        stoploss.trigger_price = trigger_price;

        // TODO, think there is an edge case here where order wont have leaves==0
        // but there is nothing more it can get due to some rounding wierdnesses
        if stoploss.coin_leaves_qty == 0 && stoploss.pc_leaves_qty == 0 {
            stoploss.ord_status = OrdStatus::Filled;
        }

        Ok(())
    }
}

pub fn transfer_tokens_signed<'info>(
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    token_program: AccountInfo<'info>,
    seeds: &[&[u8]],
) -> ProgramResult {
    let deposit_instruction = spl_token::instruction::transfer(&spl_token::ID, from.key, to.key, authority.key, &[], amount)?;
    let accounts: &[AccountInfo] = &[from.clone(), to.clone(), authority.clone(), token_program.clone()];
    anchor_lang::solana_program::program::invoke_signed(&deposit_instruction, &accounts[..], &[&seeds[..]])?;

    Ok(())
}

pub fn transfer_tokens<'info>(
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    token_program: AccountInfo<'info>,
) -> ProgramResult {
    msg!("transferring from {:?} to {:?} qty {:?}", from.key, to.key, amount);
    msg!("auth {:?}", authority.key);
    let deposit_instruction = spl_token::instruction::transfer(&spl_token::ID, from.key, to.key, authority.key, &[], amount)?;
    let accounts: &[AccountInfo] = &[from.clone(), to.clone(), authority.clone(), token_program.clone()];
    anchor_lang::solana_program::program::invoke(&deposit_instruction, &accounts[..])?;

    Ok(())
}

fn concat(vec: &[u64]) -> u64 {
    let mut acc = 0;
    for elem in vec {
        acc *= 10;
        acc += elem;
    }
    acc
}

// just does the scaling really
fn calculate_price_lots(pc_qty: u64, coin_qty: u64, market: &AccountInfo, dex_pid: &Pubkey) -> u64 {
    msg!("calculate_price_lots pc_qty {:?} coin_qty {:?}", pc_qty, coin_qty);
    if coin_qty == 0 {
        return 0;
    }
    // The loaded market must be dropped before CPI.
    let market = MarketState::load(market, dex_pid).expect("error loading market");
    msg!("market.pc_lot_size {:?} market.coin_lot_size {:?} ", market.pc_lot_size, market.coin_lot_size);
    let scaled_pc_qty = pc_qty.checked_mul(market.coin_lot_size).unwrap();
    let scaled_coin_qty = coin_qty; //.checked_mul(market.pc_lot_size).unwrap();
    msg!("scaled_coin_qty {:?} scaled_pc_qty {:?} ", scaled_coin_qty, scaled_pc_qty);
    scaled_pc_qty.checked_div(scaled_coin_qty).unwrap()
}

fn coin_lots(market: &AccountInfo, size: u64, dex_pid: &Pubkey) -> u64 {
    // The loaded market must be dropped before CPI.
    let market = MarketState::load(market, dex_pid).unwrap();
    size.checked_div(market.coin_lot_size).unwrap()
}

// Market accounts are the accounts used to place orders against the dex minus
// common accounts, i.e., program ids, sysvars, and the `pc_wallet`.
#[derive(Accounts, Clone)]
pub struct MarketAccounts<'info> {
    #[account(mut)]
    market: AccountInfo<'info>,
    #[account(mut)]
    open_orders: AccountInfo<'info>,
    #[account(mut)]
    request_queue: AccountInfo<'info>,
    #[account(mut)]
    event_queue: AccountInfo<'info>,
    #[account(mut)]
    bids: AccountInfo<'info>,
    #[account(mut)]
    asks: AccountInfo<'info>,
    // The `spl_token::Account` that funds will be taken from, i.e., transferred
    // from the stoploss into the markets vault.
    //
    // For bids, this is the base currency. For asks, the quote.
    #[account(mut)]
    order_payer_token_account: AccountInfo<'info>,
    // Also known as the "base" currency. For a given A/B market,
    // this is the vault for the A mint.
    #[account(mut)]
    coin_vault: AccountInfo<'info>,
    // Also known as the "quote" currency. For a given A/B market,
    // this is the vault for the B mint.
    #[account(mut)]
    pc_vault: AccountInfo<'info>,
    // PDA owner of the DEX's token accounts for base + quote currencies.
    vault_signer: AccountInfo<'info>,
    // User wallets.Used for settle
    #[account(mut)]
    coin_wallet: CpiAccount<'info, TokenAccount>,
    #[account(mut)]
    pc_wallet: CpiAccount<'info, TokenAccount>,

    #[account(mut)]
    coin_mint: AccountInfo<'info>,
    #[account(mut)]
    pc_mint: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct InitialiseOpenOrders<'info> {
    #[account(signer)]
    authority: AccountInfo<'info>,
    #[account(mut)]
    stoploss_state: ProgramAccount<'info, StoplossState>,
    stoploss_open_orders: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct NewOrder<'info> {
    market: MarketAccounts<'info>,
    // stoploss program holds tokens
    #[account(mut)]
    stoploss_base_vault: AccountInfo<'info>,
    #[account(mut)]
    stoploss_quote_vault: AccountInfo<'info>,
    #[account(mut)]
    stoploss_open_orders: AccountInfo<'info>,
    #[account(mut)]
    signal_provider: AccountInfo<'info>,
    #[account(signer)]
    authority: AccountInfo<'info>,
    #[account(init)]
    stoploss_state: ProgramAccount<'info, StoplossState>,
    stoploss_program: AccountInfo<'info>,
    dex_program: AccountInfo<'info>,
    pda: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ExecuteOrder<'info> {
    market: MarketAccounts<'info>,
    // stoploss program holds tokens
    #[account(mut)]
    stoploss_base_vault: AccountInfo<'info>,
    #[account(mut)]
    stoploss_quote_vault: AccountInfo<'info>,
    #[account(signer)]
    authority: AccountInfo<'info>,
    #[account(mut)]
    stoploss_state: ProgramAccount<'info, StoplossState>,
    #[account(mut)]
    stoploss_open_orders: AccountInfo<'info>,

    stoploss_program: AccountInfo<'info>,
    dex_program: AccountInfo<'info>,
    pda: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    stoploss_state: ProgramAccount<'info, StoplossState>,
    #[account(signer)]
    authority: AccountInfo<'info>,
    #[account(mut)]
    coin_wallet: CpiAccount<'info, TokenAccount>,
    #[account(mut)]
    pc_wallet: CpiAccount<'info, TokenAccount>,
    // the vault to refund the client from
    #[account(mut)]
    stoploss_paying_vault: CpiAccount<'info, TokenAccount>,
    vault_owner: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct AmendOrder<'info> {
    #[account(mut)]
    stoploss_state: ProgramAccount<'info, StoplossState>,
    #[account(signer)]
    authority: AccountInfo<'info>,
    #[account(mut)]
    coin_wallet: CpiAccount<'info, TokenAccount>,
    #[account(mut)]
    pc_wallet: CpiAccount<'info, TokenAccount>,
    // the vault to refund the client from
    #[account(mut)]
    stoploss_paying_vault: CpiAccount<'info, TokenAccount>,
    vault_owner: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
}

// cant have enum in events last I checked, so have to pass a pointer to the order id and look it up
// off chain
#[account]
#[derive(Debug, Serialize, Deserialize)]
pub struct StoplossState {
    pub own_address: Pubkey,
    pub market: Pubkey,
    // this is the open orders of the stoploss program in the market.
    // each user looks to get their own open orders in a market.
    pub stoploss_open_orders: Pubkey,
    pub request_queue: Pubkey,
    pub event_queue: Pubkey,
    pub bids: Pubkey,
    pub asks: Pubkey,
    pub payer: Pubkey,
    // the clients base/quote wallets
    pub client_coin_wallet: Pubkey,
    pub client_pc_wallet: Pubkey,

    pub stoploss_base_vault: Pubkey,
    pub stoploss_quote_vault: Pubkey,

    pub dex_program: Pubkey,
    pub pda: Pubkey,
    pub stoploss_program: Pubkey,
    pub vault_signer: Pubkey,
    pub token_program: Pubkey,

    // the user that can cancel/amend the order
    pub amend_authority: Pubkey,

    // these are the size of the order
    // pass both params in instead of a single qty because of lot size and decimal complexities
    // TODO - check if a price is really not possible to retreive from the serum "api"
    pub max_coin_qty: u64,
    pub max_pc_qty: u64,

    pub trigger_price: u64,

    // fix like fields
    pub side: Side,
    pub limit_price: u64,
    pub client_order_id: u64,
    // remaining on the order
    pub coin_leaves_qty: u64,
    pub pc_leaves_qty: u64,
    // filled on the order
    pub coin_cum_qty: u64,
    pub pc_cum_qty: u64,
    // price of the last fill, including fees
    pub last_price: u64,
    // avg price of all fills, including fees
    pub avg_price: u64,
    pub ord_status: OrdStatus,

    // signal provider is the authority used to execute child orders, eg an algo server
    pub signal_provider: Pubkey,
    pub child_order_count: u64,
    pub client_paying_account: Pubkey,

    pub coin_mint: Pubkey,
    pub pc_mint: Pubkey,

    pub should_create_open_orders: bool,
}

// dont seem to be able to emit events that have structs as elements, otherwise I would re-use stoplossstates

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoplossOrderUpdate {
    pub own_address: Pubkey,
}

impl From<StoplossState> for StoplossOrderUpdate {
    fn from(s: StoplossState) -> Self {
        StoplossOrderUpdate { own_address: s.own_address }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct StoplossCreatedChildOrder {
    pub parent_address: Pubkey,
    pub parent_order_id: u64,
    pub child_order_id: u64,
    pub parent_child_composite_id: u64,
    pub market: Pubkey,
    pub side: Side,
    pub requested_qty: u64,
    pub limit_price: u64,
    pub base_filled_qty: u64,
    pub quote_filled_qty: u64,
    pub price: String,
    pub filled_time: i64,
    pub ord_status: OrdStatus,
    pub order_type: OrderType,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum OrdStatus {
    New = 0,
    PartiallyFilled = 1,
    Filled = 2,
    Cancelled = 4,
    Rejected = 7,
    Suspended = 9,
    PendingInit = 10,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug, AnchorSerialize, AnchorDeserialize)]
pub enum Side {
    Bid,
    Ask,
}

impl From<Side> for SerumSide {
    fn from(side: Side) -> SerumSide {
        match side {
            Side::Bid => SerumSide::Bid,
            Side::Ask => SerumSide::Ask,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, AnchorSerialize, AnchorDeserialize, Debug)]
pub enum OrderType {
    Limit = 0,
    ImmediateOrCancel = 1,
    PostOnly = 2,
}

impl From<OrderType> for SerumOrderType {
    fn from(t: OrderType) -> SerumOrderType {
        match t {
            OrderType::Limit => SerumOrderType::Limit,
            OrderType::ImmediateOrCancel => SerumOrderType::ImmediateOrCancel,
            OrderType::PostOnly => SerumOrderType::PostOnly,
        }
    }
}

// used to work out the price on a fill
// should be easier than this tbh
// ONLY use from context of execute method.
pub struct PositionChanges {
    pub side: Side,
    pub client_coin_bal_before: u64,
    pub client_pc_bal_before: u64,
    pub sl_coin_bal_before: u64,
    pub sl_pc_bal_before: u64,

    pub client_coin_bal_after: u64,
    pub client_pc_bal_after: u64,
    pub sl_coin_bal_after: u64,
    pub sl_pc_bal_after: u64,
}

impl Default for PositionChanges {
    fn default() -> PositionChanges {
        PositionChanges {
            side: Side::Bid,
            client_coin_bal_before: 0,
            client_pc_bal_before: 0,
            sl_coin_bal_before: 0,
            sl_pc_bal_before: 0,
            client_coin_bal_after: 0,
            client_pc_bal_after: 0,
            sl_coin_bal_after: 0,
            sl_pc_bal_after: 0,
        }
    }
}

impl PositionChanges {
    fn record_before(&mut self, side: Side, client_coin: u64, client_pc: u64, sl_coin: u64, sl_pc: u64) {
        self.side = side;
        self.client_coin_bal_before = client_coin;
        self.client_pc_bal_before = client_pc;
        self.sl_coin_bal_before = sl_coin;
        self.sl_pc_bal_before = sl_pc;

        msg!(
            "sl_coin_bal_before {:?} sl_coin_bal_after {:?}",
            self.sl_coin_bal_before,
            self.sl_coin_bal_after
        );
        msg!("sl_pc_bal_before {:?} sl_pc_bal_after {:?}", self.sl_pc_bal_before, self.sl_pc_bal_after);
        msg!(
            "client_coin_bal_before {:?} client_coin_bal_after {:?}",
            self.client_coin_bal_before,
            self.client_coin_bal_after
        );
        msg!(
            "client_pc_bal_before {:?} client_pc_bal_after {:?}",
            self.client_pc_bal_before,
            self.client_pc_bal_after
        );
    }
    fn record_after(&mut self, client_coin: u64, client_pc: u64, sl_coin: u64, sl_pc: u64) {
        self.client_coin_bal_after = client_coin;
        self.client_pc_bal_after = client_pc;
        self.sl_coin_bal_after = sl_coin;
        self.sl_pc_bal_after = sl_pc;

        msg!(
            "sl_coin_bal_before {:?} sl_coin_bal_after {:?}",
            self.sl_coin_bal_before,
            self.sl_coin_bal_after
        );

        msg!("sl_pc_bal_before {:?} sl_pc_bal_after {:?}", self.sl_pc_bal_before, self.sl_pc_bal_after);
        msg!(
            "client_coin_bal_before {:?} client_coin_bal_after {:?}",
            self.client_coin_bal_before,
            self.client_coin_bal_after
        );
        msg!(
            "client_pc_bal_before {:?} client_pc_bal_after {:?}",
            self.client_pc_bal_before,
            self.client_pc_bal_after
        );
    }

    fn calc_fill_price(&self) -> u64 {
        let sl_coin_delta = self.sl_coin_delta();
        let sl_pc_delta = self.sl_pc_delta();
        let client_coin_delta = self.client_coin_delta();
        let client_pc_delta = self.client_pc_delta();

        let e = u64::pow(10, 6);

        let coin_delta = client_coin_delta + sl_coin_delta;

        if coin_delta == 0 {
            return 0;
        }

        msg!("calc_fill_price sl_pc_delta {:?} client_pc_delta {:?}", sl_pc_delta, client_pc_delta);
        let px = ((sl_pc_delta) - (client_pc_delta)) / coin_delta;

        return px;
    }

    fn client_coin_delta(&self) -> u64 {
        return self.delta(self.client_coin_bal_before, self.client_coin_bal_after);
    }

    fn client_pc_delta(&self) -> u64 {
        return self.delta(self.client_pc_bal_before, self.client_pc_bal_after);
    }

    fn sl_coin_delta(&self) -> u64 {
        return self.delta(self.sl_coin_bal_before, self.sl_coin_bal_after);
    }

    fn sl_pc_delta(&self) -> u64 {
        return self.delta(self.sl_pc_bal_before, self.sl_pc_bal_after);
    }

    fn delta(&self, before: u64, after: u64) -> u64 {
        // narsty assumption that nothing has gone wrong and the sizes after are the wrong way...
        if before >= after {
            return before.checked_sub(after).unwrap();
        } else {
            return after.checked_sub(before).unwrap();
        }
    }
}

impl<'info> NewOrder<'info> {
    fn into_transfer_to_buy_context(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        // buy base with the quote currency so transfers to quote vault
        let cpi_accounts = Transfer {
            from: self.market.pc_wallet.to_account_info().clone(),
            to: self.stoploss_quote_vault.to_account_info().clone(),
            authority: self.authority.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
}

impl<'info> NewOrder<'info> {
    fn into_transfer_to_sell_context(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        // sell the base currency so transfers to base vault
        let cpi_accounts = Transfer {
            from: self.market.coin_wallet.to_account_info().clone(),
            to: self.stoploss_base_vault.to_account_info().clone(),
            authority: self.authority.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
}

#[error]
pub enum ErrorCode {
    #[msg("The order is in cancelled state. Cannot execute")]
    AttemptingToExecuteCancelledOrder,
    #[msg("The order is in fully filled state. Cannot execute")]
    AttemptingToExecuteFilledOrder,
    #[msg("The order is in filled state. Cannot cancel")]
    OrderAlreadyFilled,
    #[msg("The order is in cancelled state. Cannot cancel")]
    OrderAlreadyCancelled,
    #[msg("The signal provider's signature is required.")]
    MissingSignalProviderSignature,
    #[msg("Incorrect Signal Provider account was provided. Should be algo server sending execute instructions.")]
    IncorrectSignalProviderAccount,
    #[msg("Incorrect Amend account was provided. Should be the owner who created the order amending")]
    IncorrectAmendAccount,
    #[msg("Order has already filled more than requested amend size. Rejecting Amend")]
    AlreadyFilledMoreThanRequestedAmendSize,
    #[msg("Attempting to execute outside parent limit price. Rejecting Execute instruction")]
    AttemptingToExecuteOutsideParentLimit,
    #[msg("Unable to refund tokens back to sender account")]
    TransferFailed,
    AlreadyInitialised,
}
