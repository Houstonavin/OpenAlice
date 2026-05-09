import { tool } from 'ai'
import { z } from 'zod'

export interface WhaleSignalsDeps {
  signalApiUrl: string
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Whale signal API ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

export function createWhaleSignalsTools({ signalApiUrl }: WhaleSignalsDeps) {
  return {
    whaleGetSignals: tool({
      description:
        'Get the current forex trading signals from the Whale decision engine. ' +
        'Returns per-pair direction (BUY/SELL/NEUTRAL), confidence score (0–1), ' +
        'regime (TRENDING/RANGING/VOLATILE), and signal breakdown by category ' +
        '(ta, news, twitter, cot, polymarket, whale). Use this as the primary ' +
        'signal input before making any forex trade decision.',
      inputSchema: z.object({}),
      execute: async () => {
        const data = await fetchJson(`${signalApiUrl}/decisions`)
        return data
      },
    }),

    whaleGetMacro: tool({
      description:
        'Get live macro market data: VIX (fear index), DXY (US Dollar Index), ' +
        'XAU (Gold spot price), OIL (WTI crude), US10Y (10-year Treasury yield), ' +
        'and BTC (Bitcoin). Each includes current price and % change from prior close. ' +
        'Use this to assess the macro risk environment before trading forex.',
      inputSchema: z.object({}),
      execute: async () => {
        const data = await fetchJson(`${signalApiUrl}/macro`)
        return data
      },
    }),

    whaleGetXFeed: tool({
      description:
        'Get the latest posts from monitored X (Twitter) accounts that are ' +
        'relevant to forex markets. Each post includes account name, text, ' +
        'sentiment score (-1 to +1), affected currency pairs, and timestamp. ' +
        'Use this to gauge real-time market sentiment from influential traders and analysts.',
      inputSchema: z.object({}),
      execute: async () => {
        const data = await fetchJson(`${signalApiUrl}/xfeed`)
        return data
      },
    }),

    whaleGetCalendar: tool({
      description:
        'Get upcoming high-impact economic events (central bank decisions, NFP, CPI, GDP). ' +
        'Each event includes title, country, scheduled time, forecast, previous value, ' +
        'and affected currency pairs. Use this to avoid trading during volatile ' +
        'calendar windows (30 min before / 60 min after high-impact events).',
      inputSchema: z.object({}),
      execute: async () => {
        const data = await fetchJson(`${signalApiUrl}/calendar`)
        return data
      },
    }),

    whaleGetRegime: tool({
      description:
        'Get the current market regime classification for a specific forex pair. ' +
        'Returns TRENDING, RANGING, or VOLATILE based on ADX and ATR analysis. ' +
        'Use this to select the appropriate trading playbook: ' +
        'TRENDING → breakout or pullback entry, RANGING → mean reversion fade.',
      inputSchema: z.object({
        pair: z.string().describe('Forex pair in MT5 format e.g. EURUSD, GBPUSD, USDJPY'),
        timeframe: z.string().optional().describe('Timeframe e.g. 15m, 1h (default: 15m)'),
      }),
      execute: async ({ pair, timeframe = '15m' }) => {
        const data = await fetchJson(
          `${signalApiUrl}/regime?pair=${pair}&timeframe=${timeframe}`,
        )
        return data
      },
    }),

    whaleGetSessionBrief: tool({
      description:
        'Get the current trading session brief: which session is active (London/New York/Tokyo/Overlap), ' +
        'the active playbook per pair, upcoming high-impact events in the next 4 hours, ' +
        'and current signal weights. Use this for pre-trade context at the start of each session.',
      inputSchema: z.object({}),
      execute: async () => {
        const data = await fetchJson(`${signalApiUrl}/session/brief`)
        return data
      },
    }),
  }
}
