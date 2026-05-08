/**
 * Economy AI Tools
 *
 * Currently exposes the FRED (Federal Reserve Economic Data) surface:
 *   economyFredSearch    — find a series by keyword
 *   economyFredSeries    — fetch observations for one or more series
 *   economyFredRegional  — fetch state-level cross-section for a regional series
 *
 * All three pin `provider: 'federal_reserve'` because that is the only
 * registered FRED data source on the SDK side. If/when other macro
 * providers (BLS series, OECD CLI) get tool-wrapped, they belong in
 * sibling tools in this same file rather than overloaded here.
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { EconomyClientLike } from '@/domain/market-data/client/types'

const PROVIDER = 'federal_reserve'

export function createEconomyTools(economyClient: EconomyClientLike) {
  return {
    economyFredSearch: tool({
      description: `Search the FRED database for economic time series by keyword.

Returns a list of matching series with id, title, frequency, units, and seasonal adjustment.
Use this to discover the FRED series_id for a metric (e.g. "unemployment" → UNRATE,
"GDP" → GDP, "CPI" → CPIAUCSL), then pass the id to economyFredSeries to get observations.

The query is keyword-based and matches series titles + tags; expect dozens of hits per
common term. Increase limit only if you need to scan beyond the most popular results.`,
      inputSchema: z.object({
        query: z.string().describe('Keyword(s) to search FRED, e.g. "unemployment", "GDP", "CPI"'),
        limit: z.number().int().positive().optional().describe('Max results to return (default: 100)'),
      }),
      execute: async ({ query, limit }) => {
        const params: Record<string, unknown> = { query, provider: PROVIDER }
        if (limit !== undefined) params.limit = limit
        return await economyClient.fredSearch(params)
      },
    }),

    economyFredSeries: tool({
      description: `Fetch observation values for one or more FRED series.

Pass a single series_id (e.g. "GDP") or comma-separated ids (e.g. "GDP,UNRATE,CPIAUCSL")
to retrieve and merge multiple series into one date-indexed result.

When limit is set without a date range, returns the LATEST N observations (e.g. limit=12
on a monthly series gives the most recent year). To pull a specific window, pass
start_date and/or end_date in YYYY-MM-DD form.

If you don't know the series_id, call economyFredSearch first.`,
      inputSchema: z.object({
        symbol: z.string().describe('FRED series id, or comma-separated ids for multi-series merge'),
        start_date: z.string().optional().describe('Start date YYYY-MM-DD (optional)'),
        end_date: z.string().optional().describe('End date YYYY-MM-DD (optional)'),
        limit: z.number().int().positive().optional().describe('Max observations per series (returns latest N when no date range given)'),
        frequency: z.string().optional().describe('Aggregation frequency override (e.g. "m", "q", "a")'),
      }),
      execute: async ({ symbol, start_date, end_date, limit, frequency }) => {
        const params: Record<string, unknown> = { symbol, provider: PROVIDER }
        if (start_date !== undefined) params.start_date = start_date
        if (end_date !== undefined) params.end_date = end_date
        if (limit !== undefined) params.limit = limit
        if (frequency !== undefined) params.frequency = frequency
        return await economyClient.fredSeries(params)
      },
    }),

    economyFredRegional: tool({
      description: `Fetch a US state-level cross-section for a FRED regional series.

The symbol is the regional series id (e.g. "WIPCPI" for per-capita personal income,
"UNRATE" for unemployment rate). Returns one row per region (~50 states + DC + territories)
with region name, code, and value for the given date.

Use this for state-by-state comparisons; for time-series of a single region,
use economyFredSeries with the region-specific id (e.g. "CAPCPI" for California
per-capita income).`,
      inputSchema: z.object({
        symbol: z.string().describe('FRED regional series id (e.g. "WIPCPI" for per-capita income)'),
        date: z.string().optional().describe('Observation date YYYY-MM-DD (defaults to latest available)'),
        region_type: z.string().optional().describe('Region granularity: "state" (default), "msa", "county"'),
        start_date: z.string().optional().describe('Start date for ranged queries (optional)'),
      }),
      execute: async ({ symbol, date, region_type, start_date }) => {
        const params: Record<string, unknown> = { symbol, provider: PROVIDER }
        if (date !== undefined) params.date = date
        if (region_type !== undefined) params.region_type = region_type
        if (start_date !== undefined) params.start_date = start_date
        return await economyClient.fredRegional(params)
      },
    }),
  }
}
