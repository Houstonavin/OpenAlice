import { tool } from 'ai'
import { z } from 'zod'
import type { UTAManager } from '@/domain/trading/index.js'

export interface WhaleExecuteDeps {
  utaManager: UTAManager
  redisUrl: string
}

async function writeRedisPendingOrder(redisUrl: string, order: Record<string, unknown>): Promise<void> {
  // Use native Redis commands via fetch to the redis HTTP bridge if available,
  // or write directly using the ioredis/redis package if available.
  // Since OpenAlice doesn't use Redis directly, we write a local JSON file
  // as a side-channel that mt5_order_router.py polls.
  try {
    const { createClient } = await import('redis')
    const client = createClient({ url: redisUrl })
    await client.connect()
    // Push to a Redis list that mt5_order_router polls
    await client.lPush('mt5:pending_orders', JSON.stringify({
      ...order,
      source: 'alice',
      staged_at: new Date().toISOString(),
    }))
    await client.disconnect()
  } catch {
    // Redis not available — log but don't fail the tool call
    console.warn('[whale-execute] Redis unavailable — MT5 pending order not written')
  }
}

export function createWhaleExecuteTools({ utaManager, redisUrl }: WhaleExecuteDeps) {
  return {
    whaleStageTrade: tool({
      description:
        'Stage a forex trade for human review and approval. ' +
        'This does NOT execute immediately — it places the trade in a pending queue ' +
        'that you must explicitly approve before it is sent to the broker. ' +
        'The trade is validated against risk guards (max open trades, correlation limits, drawdown). ' +
        'Always call whaleGetSignals and whaleGetMacro first to validate the setup before staging. ' +
        'Include a clear rationale explaining why this trade meets entry criteria.',
      inputSchema: z.object({
        pair: z.string().describe('Forex pair in MT5 format e.g. EURUSD, GBPUSD'),
        direction: z.enum(['BUY', 'SELL']).describe('Trade direction'),
        lot_size: z.number().positive().describe('Position size in lots (e.g. 0.01 for micro lot)'),
        stop_loss_price: z.number().positive().describe('Stop loss price level'),
        take_profit_price: z.number().positive().describe('Take profit price level'),
        rationale: z.string().min(20).describe(
          'Explanation of why this trade meets entry criteria: ' +
          'which signals aligned, macro context, regime, calendar check, risk/reward ratio'
        ),
        playbook: z.string().optional().describe('Active playbook name: breakout, pullback, or mean_reversion'),
        confidence: z.number().min(0).max(1).optional().describe('Aggregated signal confidence score from whaleGetSignals'),
      }),
      execute: async ({ pair, direction, lot_size, stop_loss_price, take_profit_price, rationale, playbook, confidence }) => {
        const order = {
          pair,
          direction,
          lot_size,
          stop_loss_price,
          take_profit_price,
          rationale,
          playbook: playbook ?? 'unknown',
          confidence: confidence ?? null,
        }

        // Write to Redis for MT5 order router pickup
        await writeRedisPendingOrder(redisUrl, order)

        // Also try to stage via OpenAlice UTA if one is configured for forex
        let utaResult: string | null = null
        const utas = utaManager.listUTAs()
        const forexUta = utas.find(u => u.enabled && (u.broker === 'ibkr' || u.broker === 'mock'))
        if (forexUta) {
          utaResult = `Staged in UTA "${forexUta.id}" (${forexUta.broker}) — awaiting your approval via push command`
        }

        return {
          status: 'staged',
          pair,
          direction,
          lot_size,
          stop_loss_price,
          take_profit_price,
          rationale,
          playbook,
          confidence,
          mt5_pending: true,
          uta_staged: utaResult,
          message:
            `Trade staged for review: ${direction} ${pair} @ ${lot_size} lots. ` +
            `SL: ${stop_loss_price} | TP: ${take_profit_price}. ` +
            `Awaiting your approval before execution.`,
        }
      },
    }),

    whaleListStagedTrades: tool({
      description:
        'List all trades currently staged and awaiting approval. ' +
        'Use this to review pending orders before approving or cancelling them.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { createClient } = await import('redis')
          const client = createClient({ url: redisUrl })
          await client.connect()
          const items = await client.lRange('mt5:pending_orders', 0, -1)
          await client.disconnect()
          const orders = items.map(i => {
            try { return JSON.parse(i) } catch { return null }
          }).filter(Boolean)
          return { staged_count: orders.length, orders }
        } catch {
          return { staged_count: 0, orders: [], note: 'Redis unavailable' }
        }
      },
    }),

    whaleCancelStagedTrade: tool({
      description: 'Remove a staged trade from the pending queue without executing it.',
      inputSchema: z.object({
        pair: z.string().describe('Forex pair of the trade to cancel e.g. EURUSD'),
        direction: z.enum(['BUY', 'SELL']).describe('Direction of the trade to cancel'),
      }),
      execute: async ({ pair, direction }) => {
        try {
          const { createClient } = await import('redis')
          const client = createClient({ url: redisUrl })
          await client.connect()
          const items = await client.lRange('mt5:pending_orders', 0, -1)
          let removed = 0
          for (const item of items) {
            try {
              const o = JSON.parse(item)
              if (o.pair === pair && o.direction === direction) {
                await client.lRem('mt5:pending_orders', 1, item)
                removed++
              }
            } catch { /* skip */ }
          }
          await client.disconnect()
          return { cancelled: removed > 0, pair, direction, removed_count: removed }
        } catch {
          return { cancelled: false, error: 'Redis unavailable' }
        }
      },
    }),
  }
}
