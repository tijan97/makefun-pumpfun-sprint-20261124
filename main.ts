// Pump.fun Paper Sprint: minimal-bleed sniper, v4 (paper trading only).
//
// Retune after v3 (-1.41 SOL; all 5 stress copies also lost money) and
// after grading the house pilots on the same dev window (sniper -0.42,
// reversion -4.37 with a 52.7% drawdown, momentum -9.45 with a 95.6%
// drawdown): this dev window makes every strategy bleed, so the game is
// to bleed least while keeping exposure to the rare runner. v4 shrinks
// stakes to 0.015 SOL, tightens the stop to -6%, and demands stronger
// early attention (>=0.5 SOL of opening buy volume) so fewer, better
// coins are bought. A loser then costs ~0.0015 SOL; a runner held under
// the trailing stop can still pay for dozens of losers.
//  - Fully deterministic: every decision comes from the replay state only.
//    No clock, no environment, no Math.random, so the two grading runs
//    produce byte-identical action logs (v1-v3 all reproduced: true).
//
// Protocol: agent-fun/replay/v2 via the kit's vendor shim (stdin hello /
// batch / done, one reply per batch). Orders are decided per batch; fills
// land 2 slots later (latency_slots).

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState } from './vendor/makefun-bot.ts';

// ---- tunables (all in lamports / basis points / slots) --------------------
const STAKE_LAMPORTS = 15_000_000n; // 0.015 SOL per coin
const MIN_BUY_LAMPORTS = 10_500_000n; // 0.0105 SOL; guardrail needs >=0.01 SOL round trips
const MAX_POSITIONS = 5;
const MAX_BUY_AGE_TRADES = 8; // only the opening trades of a launch
const MAX_BUY_AGE_SLOTS = 150; // ~1 minute after creation
const MOMENTUM_VS_CREATE_BPS = 300; // +3% vs create price (near-create entry)
const MIN_EARLY_BUY_VOL = 500_000_000n; // >=0.5 SOL of buy volume in the opening trades
const MIN_BUY_SELL_RATIO = 2; // recent buy SOL volume >= 2x sell SOL volume
const HISTORY_TRADES = 12; // trades of price/volume history kept per mint
const TP1_BPS = 4000; // +40%: sell half
const STOP_BPS = -600; // -6%: sell all
const TRAIL_TRIGGER_BPS = 8000; // peak +80% arms the trailing exit
const TRAIL_DROP_BPS = 1500; // 15% pullback from the peak sells all
const MAX_HOLD_SLOTS = 400; // stale exit if under +5% after this long
const STALE_GAIN_BPS = 500; // stale exit only below +5%
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 1000;

// ---- per-mint memory -------------------------------------------------------
interface MintMemory {
  mint: string;
  createdSlot: number;
  createPrice: number; // SOL per token at creation
  prices: number[]; // post-trade prices, oldest first, capped at HISTORY_TRADES
  buyVol: bigint[]; // SOL volume of buy trades, same window
  sellVol: bigint[]; // SOL volume of sell trades, same window
  trades: number;
  bought: boolean; // a buy filled for this mint once this run
  buyPending: boolean; // a buy order for this mint is still in flight
  sellPending: boolean; // a sell order for this mint is still in flight
  entryPrice: number; // SOL per token paid (from the buy fill)
  entrySlot: number;
  peakPrice: number; // highest price seen since entry
  soldHalf: boolean;
}

const memory = new Map<string, MintMemory>();

function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken === 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

function getMemory(mint: string, slot: number): MintMemory {
  let m = memory.get(mint);
  if (m === undefined) {
    m = {
      mint,
      createdSlot: slot,
      createPrice: 0,
      prices: [],
      buyVol: [],
      sellVol: [],
      trades: 0,
      bought: false,
      buyPending: false,
      sellPending: false,
      entryPrice: 0,
      entrySlot: 0,
      peakPrice: 0,
      soldHalf: false,
    };
    memory.set(mint, m);
  }
  return m;
}

function pushTrade(m: MintMemory, price: number, isBuy: boolean, solAmount: bigint): void {
  m.prices.push(price);
  m.buyVol.push(isBuy ? solAmount : 0n);
  m.sellVol.push(isBuy ? 0n : solAmount);
  if (m.prices.length > HISTORY_TRADES) {
    m.prices.shift();
    m.buyVol.shift();
    m.sellVol.shift();
  }
  m.trades += 1;
}

function sumBigints(xs: readonly bigint[]): bigint {
  let total = 0n;
  for (const x of xs) total += x;
  return total;
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    // Fold this batch's fills into memory: record entry prices, clear the
    // pending flags, and reset state when a position is fully closed.
    for (const fill of batch.fills) {
      const m = memory.get(fill.mint);
      if (m === undefined) continue;
      if (fill.side === 'buy') {
        m.buyPending = false;
        if (fill.status === 'filled') {
          const tokens = BigInt(fill.token_amount);
          const paid = BigInt(fill.quote_lamports);
          if (tokens > 0n) {
            m.entryPrice = Number(paid) / Number(tokens);
            m.entrySlot = fill.slot;
            m.peakPrice = m.entryPrice;
            m.soldHalf = false;
            m.bought = true;
          }
        }
      } else {
        m.sellPending = false;
        if (state.positions.get(fill.mint) === undefined) {
          m.entryPrice = 0;
          m.peakPrice = 0;
          m.soldHalf = false;
        }
      }
    }

    // Fold this batch's events into memory.
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        const m = getMemory(event.mint, event.slot);
        m.createdSlot = event.slot;
        m.createPrice = priceOf(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves));
      } else if (event.event === 'TradeEvent') {
        const m = getMemory(event.mint, event.slot);
        if (m.createPrice === 0) {
          m.createPrice = priceOf(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves));
        }
        pushTrade(
          m,
          priceOf(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves)),
          event.is_buy,
          BigInt(event.sol_amount),
        );
      } else {
        const m = memory.get(event.mint);
        if (m !== undefined) {
          m.createPrice = 0; // completed: never buy again
        }
      }
    }

    const sells: { side: 'sell'; mint: string; token_amount: bigint; max_slippage_bps: number }[] = [];
    const buys: { side: 'buy'; mint: string; quote_lamports: bigint; max_slippage_bps: number }[] = [];

    // ---- exits first: free position slots before deciding new buys --------
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      const m = memory.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (m === undefined || m.entryPrice <= 0 || m.sellPending) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      if (price > m.peakPrice) m.peakPrice = price;
      const gainBps = Math.floor(((price - m.entryPrice) / m.entryPrice) * 10000);
      const peakGainBps = Math.floor(((m.peakPrice - m.entryPrice) / m.entryPrice) * 10000);
      const dropFromPeakBps = Math.floor(((m.peakPrice - price) / m.peakPrice) * 10000);
      const heldSlots = state.slot - m.entrySlot;
      const tokens = holding.token_amount;

      if (!m.soldHalf && gainBps >= TP1_BPS) {
        // Take half at +40%; the rest rides under the trailing stop.
        sells.push({ side: 'sell', mint, token_amount: tokens / 2n, max_slippage_bps: SELL_SLIPPAGE_BPS });
        m.soldHalf = true;
        m.sellPending = true;
      } else if (gainBps <= STOP_BPS) {
        sells.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
        m.sellPending = true;
      } else if (peakGainBps >= TRAIL_TRIGGER_BPS && dropFromPeakBps >= TRAIL_DROP_BPS) {
        sells.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
        m.sellPending = true;
      } else if (heldSlots > MAX_HOLD_SLOTS && gainBps < STALE_GAIN_BPS) {
        sells.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
        m.sellPending = true;
      }
    }

    // ---- entries: the opening trades of a launch, one buy per mint ------
    // Sells decided above free their slots on the next batch; count only
    // slots free right now.
    let freeSlots = MAX_POSITIONS - state.committedPositionCount();
    if (freeSlots < 0) freeSlots = 0;

    if (freeSlots > 0) {
      const freeCash = state.freeCashLamports();
      for (const [mint, m] of memory) {
        if (freeSlots <= 0) break;
        if (m.bought || m.buyPending) continue;
        if (m.createPrice <= 0) continue;
        if (m.trades < 3 || m.trades > MAX_BUY_AGE_TRADES) continue;
        if (state.slot - m.createdSlot > MAX_BUY_AGE_SLOTS) continue;
        if (state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        // Momentum vs create price: near-create entry, not dumped already.
        const vsCreateBps = Math.floor(((price - m.createPrice) / m.createPrice) * 10000);
        if (vsCreateBps < MOMENTUM_VS_CREATE_BPS) continue;
        // Real early buy flow in the opening trades: at least 0.3 SOL of
        // buys, and buys dominating sells.
        const buyVol = sumBigints(m.buyVol);
        const sellVol = sumBigints(m.sellVol);
        if (buyVol < MIN_EARLY_BUY_VOL) continue;
        if (buyVol < sellVol * BigInt(MIN_BUY_SELL_RATIO)) continue;
        // Size: stake, capped by the harness's per-batch buy cap and by cash.
        const cap = state.maxBuyLamports(mint);
        let amount = STAKE_LAMPORTS;
        if (amount > cap) amount = cap;
        if (amount > freeCash - state.txFeeLamports()) amount = freeCash - state.txFeeLamports();
        if (amount < MIN_BUY_LAMPORTS) continue;
        buys.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
        m.buyPending = true;
        freeSlots -= 1;
      }
    }

    return [...sells, ...buys];
  },
});
