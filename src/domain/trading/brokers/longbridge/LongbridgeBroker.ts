/**
 * LongbridgeBroker — IBroker adapter for Longbridge OpenAPI.
 *
 * Covers HK / US / SH / SZ / SG securities through a single account,
 * matching how a real Longbridge account is structured (one trading
 * relationship, multiple regional markets, multi-currency cash).
 *
 * Auth: appKey + appSecret + accessToken (long-lived; user rotates
 * manually in the LB dashboard, ~90d).
 *
 * Multi-currency cash folding: LB returns one AccountBalance per
 * currency (HKD/USD/CNY). We pick HKD as `baseCurrency` and roll the
 * other buckets into it via the injected FxService. Without an
 * FxService we fall back to reporting only the HKD bucket — minor
 * non-HKD cash may not show up in totalCashValue.
 */

import { z } from 'zod'
import Decimal from 'decimal.js'
import { Contract, ContractDescription, ContractDetails, Order, UNSET_DECIMAL } from '@traderalice/ibkr'
import {
  Config,
  TradeContext,
  QuoteContext,
  OrderSide,
  OrderType as LbOrderType,
  TimeInForceType,
  type SubmitOrderOptions,
  type ReplaceOrderOptions,
} from 'longbridge'
import {
  BrokerError,
  type IBroker,
  type AccountCapabilities,
  type AccountInfo,
  type Position,
  type PlaceOrderResult,
  type OpenOrder,
  type Quote,
  type MarketClock,
  type TpSlParams,
} from '../types.js'
import '../../contract-ext.js'
import type { FxService } from '../../fx-service.js'
import {
  echoContractDescription,
  makeContract,
  makeOrderState,
  parseLbSymbol,
  resolveSymbol,
} from './longbridge-contracts.js'
import type {
  LongbridgeBrokerConfig,
  LongbridgeAccountBalanceLike,
  LongbridgeStockPositionsResponseLike,
  LongbridgeSecurityQuoteLike,
  LongbridgeSecurityDepthLike,
  LongbridgeOrderLike,
  LongbridgeMarketSessionLike,
} from './longbridge-types.js'

// ==================== Order-type translation ====================

/**
 * Translate an IBKR `Order.orderType` string + market suffix into the
 * Longbridge `OrderType` enum. Market-aware because HK does not accept
 * a true MO; ELO is the practical equivalent.
 *
 * Returns null when the IBKR order type has no usable LB analogue
 * (e.g. IOC/FOK on HK side) — caller should reject the order.
 */
export function ibkrOrderTypeToLb(
  ibkrType: string,
  marketSuffix: string,
): LbOrderType | null {
  switch (ibkrType) {
    case 'MKT':
      return marketSuffix === 'HK' ? LbOrderType.ELO : LbOrderType.MO
    case 'LMT':
      return LbOrderType.LO
    case 'STP':
      return LbOrderType.MIT
    case 'STP LMT':
      return LbOrderType.LIT
    case 'TRAIL':
      return LbOrderType.TSMPCT
    case 'TRAIL LIMIT':
      return LbOrderType.TSLPPCT
    default:
      return null
  }
}

/** Map IBKR TIF strings to Longbridge `TimeInForceType`. */
export function ibkrTifToLb(tif: string): TimeInForceType | null {
  switch (tif) {
    case 'DAY':
    case '':
      return TimeInForceType.Day
    case 'GTC':
      return TimeInForceType.GoodTilCanceled
    case 'GTD':
      return TimeInForceType.GoodTilDate
    // IOC/FOK are not supported by Longbridge — reject.
    case 'IOC':
    case 'FOK':
    case 'OPG':
      return null
    default:
      return TimeInForceType.Day
  }
}

// ==================== Broker class ====================

export class LongbridgeBroker implements IBroker {
  // ---- Self-registration ----

  static configSchema = z.object({
    appKey: z.string().min(1),
    appSecret: z.string().min(1),
    accessToken: z.string().min(1),
    paper: z.boolean().default(false),
    httpUrl: z.string().optional(),
    quoteWsUrl: z.string().optional(),
    tradeWsUrl: z.string().optional(),
  })

  static fromConfig(config: { id: string; label?: string; brokerConfig: Record<string, unknown> }): LongbridgeBroker {
    const bc = LongbridgeBroker.configSchema.parse(config.brokerConfig)
    return new LongbridgeBroker({
      id: config.id,
      label: config.label,
      appKey: bc.appKey,
      appSecret: bc.appSecret,
      accessToken: bc.accessToken,
      paper: bc.paper,
      httpUrl: bc.httpUrl,
      quoteWsUrl: bc.quoteWsUrl,
      tradeWsUrl: bc.tradeWsUrl,
    })
  }

  // ---- Instance ----

  readonly id: string
  readonly label: string
  private readonly cfg: LongbridgeBrokerConfig
  private tradeCtx!: TradeContext
  private quoteCtx!: QuoteContext
  private fxService?: FxService

  constructor(cfg: LongbridgeBrokerConfig) {
    this.cfg = cfg
    this.id = cfg.id ?? (cfg.paper ? 'longbridge-paper' : 'longbridge-live')
    this.label = cfg.label ?? (cfg.paper ? 'Longbridge Paper' : 'Longbridge')
  }

  /** Inject the FxService so multi-currency cash can be folded into HKD. */
  setFxService(fx: FxService): void {
    this.fxService = fx
  }

  // ---- Lifecycle ----

  private static readonly MAX_INIT_RETRIES = 5
  private static readonly MAX_AUTH_RETRIES = 2
  private static readonly INIT_RETRY_BASE_MS = 1000

  async init(): Promise<void> {
    if (!this.cfg.appKey || !this.cfg.appSecret || !this.cfg.accessToken) {
      throw new BrokerError(
        'CONFIG',
        `No API credentials configured. Set appKey, appSecret, and accessToken in accounts.json to enable this account.`,
      )
    }

    const extra: Record<string, unknown> = {}
    if (this.cfg.httpUrl) extra.httpUrl = this.cfg.httpUrl
    if (this.cfg.quoteWsUrl) extra.quoteWsUrl = this.cfg.quoteWsUrl
    if (this.cfg.tradeWsUrl) extra.tradeWsUrl = this.cfg.tradeWsUrl

    const config = Config.fromApikey(
      this.cfg.appKey,
      this.cfg.appSecret,
      this.cfg.accessToken,
      Object.keys(extra).length ? (extra as never) : undefined,
    )
    this.tradeCtx = TradeContext.new(config)
    this.quoteCtx = QuoteContext.new(config)

    let lastErr: unknown
    for (let attempt = 1; attempt <= LongbridgeBroker.MAX_INIT_RETRIES; attempt++) {
      try {
        // Cheap probe — accountBalance() is the lightest authenticated call
        // that exercises both credentials and trade endpoint reachability.
        await this.tradeCtx.accountBalance()
        console.log(`LongbridgeBroker[${this.id}]: connected (paper=${this.cfg.paper})`)
        return
      } catch (err) {
        lastErr = err
        const isAuthError = err instanceof Error &&
          /40[13]|forbidden|unauthorized|invalid.?token|invalid.?signature/i.test(err.message)
        if (isAuthError && attempt >= LongbridgeBroker.MAX_AUTH_RETRIES) {
          throw new BrokerError(
            'AUTH',
            `Authentication failed — verify appKey, appSecret, and accessToken (LB tokens expire ~90d, rotate in dashboard).`,
          )
        }
        if (attempt < LongbridgeBroker.MAX_INIT_RETRIES) {
          const delay = LongbridgeBroker.INIT_RETRY_BASE_MS * 2 ** (attempt - 1)
          console.warn(`LongbridgeBroker[${this.id}]: init attempt ${attempt}/${LongbridgeBroker.MAX_INIT_RETRIES} failed, retrying in ${delay}ms...`)
          await new Promise(r => setTimeout(r, delay))
        }
      }
    }
    throw lastErr
  }

  async close(): Promise<void> {
    // longbridge SDK contexts have no explicit close — the underlying
    // websocket pools are GC'd with the Rust handle.
  }

  // ---- Contract search (SearchingCatalog model — no full enumerate) ----

  async searchContracts(pattern: string): Promise<ContractDescription[]> {
    if (!pattern) return []
    // LB does not expose a fuzzy-name search endpoint with general
    // securities. staticInfo() requires exact symbols. So we echo the
    // pattern as a contract guess (suffixed if user supplied one,
    // defaulted to .US otherwise).
    return [echoContractDescription(pattern)]
  }

  async getContractDetails(query: Contract): Promise<ContractDetails | null> {
    const symbol = resolveSymbol(query)
    if (!symbol) return null
    try {
      const infos = await (this.quoteCtx as unknown as {
        staticInfo: (symbols: string[]) => Promise<Array<{ exchange: string; currency: string; lotSize: number }>>
      }).staticInfo([symbol])
      if (!infos.length) return null

      const details = new ContractDetails()
      details.contract = makeContract(symbol)
      details.contract.exchange = infos[0].exchange || details.contract.exchange
      details.contract.currency = infos[0].currency || details.contract.currency
      details.minSize = new Decimal(infos[0].lotSize || 1)
      details.orderTypes = 'MKT,LMT,STP,STP LMT,TRAIL'
      details.stockType = 'COMMON'
      return details
    } catch {
      // Symbol unknown to LB (e.g. wrong suffix) — return null per IBroker contract.
      return null
    }
  }

  // ---- Trading operations ----

  async placeOrder(contract: Contract, order: Order, _tpsl?: TpSlParams): Promise<PlaceOrderResult> {
    const symbol = resolveSymbol(contract)
    if (!symbol) {
      return { success: false, error: 'Cannot resolve contract to Longbridge symbol' }
    }
    const { suffix } = parseLbSymbol(symbol)

    const lbType = ibkrOrderTypeToLb(order.orderType, suffix)
    if (lbType == null) {
      return { success: false, error: `Order type "${order.orderType}" is not supported by Longbridge` }
    }
    const lbTif = ibkrTifToLb(order.tif)
    if (lbTif == null) {
      return { success: false, error: `Time-in-force "${order.tif}" is not supported by Longbridge (only DAY/GTC/GTD)` }
    }

    if (order.totalQuantity.equals(UNSET_DECIMAL) || order.totalQuantity.lte(0)) {
      return { success: false, error: 'totalQuantity must be > 0 for Longbridge orders' }
    }

    const side = order.action === 'BUY' ? OrderSide.Buy : OrderSide.Sell
    const opts: SubmitOrderOptions = {
      symbol,
      orderType: lbType,
      side,
      timeInForce: lbTif,
      submittedQuantity: order.totalQuantity as unknown as never,  // SDK accepts decimal.js or its own Decimal
    }
    if (!order.lmtPrice.equals(UNSET_DECIMAL)) opts.submittedPrice = order.lmtPrice as unknown as never
    if (!order.auxPrice.equals(UNSET_DECIMAL)) opts.triggerPrice = order.auxPrice as unknown as never
    if (!order.trailingPercent.equals(UNSET_DECIMAL)) opts.trailingPercent = order.trailingPercent as unknown as never

    try {
      const resp = await this.tradeCtx.submitOrder(opts)
      return {
        success: true,
        orderId: resp.orderId,
        orderState: makeOrderState(7 /* New */),
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async modifyOrder(orderId: string, changes: Partial<Order>): Promise<PlaceOrderResult> {
    if (changes.totalQuantity == null || changes.totalQuantity.equals(UNSET_DECIMAL)) {
      return { success: false, error: 'modifyOrder requires totalQuantity for Longbridge' }
    }
    const opts: ReplaceOrderOptions = {
      orderId,
      quantity: changes.totalQuantity as unknown as never,
    }
    if (changes.lmtPrice != null && !changes.lmtPrice.equals(UNSET_DECIMAL)) {
      opts.price = changes.lmtPrice as unknown as never
    }
    if (changes.auxPrice != null && !changes.auxPrice.equals(UNSET_DECIMAL)) {
      opts.triggerPrice = changes.auxPrice as unknown as never
    }
    try {
      await this.tradeCtx.replaceOrder(opts)
      return { success: true, orderId, orderState: makeOrderState(10 /* Replaced */) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async cancelOrder(orderId: string): Promise<PlaceOrderResult> {
    try {
      await this.tradeCtx.cancelOrder(orderId)
      return { success: true, orderId, orderState: makeOrderState(15 /* Canceled */) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async closePosition(contract: Contract, quantity?: Decimal): Promise<PlaceOrderResult> {
    const symbol = resolveSymbol(contract)
    if (!symbol) {
      return { success: false, error: 'Cannot resolve contract to Longbridge symbol' }
    }
    const positions = await this.getPositions()
    const pos = positions.find(p => resolveSymbol(p.contract) === symbol)
    if (!pos) return { success: false, error: `No position for ${symbol}` }

    const qty = quantity ?? pos.quantity
    const reverse = new Order()
    reverse.action = pos.side === 'long' ? 'SELL' : 'BUY'
    reverse.orderType = 'MKT'
    reverse.totalQuantity = qty
    reverse.tif = 'DAY'
    return this.placeOrder(contract, reverse)
  }

  // ---- Queries ----

  async getAccount(): Promise<AccountInfo> {
    try {
      const balances = (await this.tradeCtx.accountBalance()) as unknown as LongbridgeAccountBalanceLike[]
      return this.foldBalancesToBase(balances)
    } catch (err) {
      throw BrokerError.from(err)
    }
  }

  /**
   * Pick HKD as base. Sum every currency's totalCash + netAssets after
   * FX-converting to HKD. Without FxService we fall back to picking the
   * largest single bucket (loses the small-currency tail but doesn't
   * lie about the unit).
   */
  private async foldBalancesToBase(balances: LongbridgeAccountBalanceLike[]): Promise<AccountInfo> {
    if (balances.length === 0) {
      return {
        baseCurrency: 'HKD',
        netLiquidation: '0',
        totalCashValue: '0',
        unrealizedPnL: '0',
      }
    }

    const baseCurrency = 'HKD'

    if (!this.fxService) {
      // No FX → pick the bucket whose currency matches base, or the largest
      // by netAssets (best effort).
      const hkdBucket = balances.find(b => b.currency.toUpperCase() === baseCurrency)
      const pick = hkdBucket ?? balances.reduce((a, b) =>
        new Decimal(b.netAssets.toString()).gt(a.netAssets.toString()) ? b : a
      )
      return {
        baseCurrency: pick.currency.toUpperCase(),
        netLiquidation: new Decimal(pick.netAssets.toString()).toString(),
        totalCashValue: new Decimal(pick.totalCash.toString()).toString(),
        unrealizedPnL: '0',
        buyingPower: new Decimal(pick.buyPower.toString()).toString(),
        initMarginReq: new Decimal(pick.initMargin.toString()).toString(),
        maintMarginReq: new Decimal(pick.maintenanceMargin.toString()).toString(),
      }
    }

    // With FX: convert every bucket to base currency and sum.
    let netLiq = new Decimal(0)
    let cash = new Decimal(0)
    let buyPower = new Decimal(0)
    let initMargin = new Decimal(0)
    let maintMargin = new Decimal(0)
    for (const b of balances) {
      const bc = b.currency.toUpperCase()
      const factor = await this.fxRate(bc, baseCurrency)
      netLiq = netLiq.plus(new Decimal(b.netAssets.toString()).times(factor))
      cash = cash.plus(new Decimal(b.totalCash.toString()).times(factor))
      buyPower = buyPower.plus(new Decimal(b.buyPower.toString()).times(factor))
      initMargin = initMargin.plus(new Decimal(b.initMargin.toString()).times(factor))
      maintMargin = maintMargin.plus(new Decimal(b.maintenanceMargin.toString()).times(factor))
    }
    return {
      baseCurrency,
      netLiquidation: netLiq.toString(),
      totalCashValue: cash.toString(),
      unrealizedPnL: '0',
      buyingPower: buyPower.toString(),
      initMarginReq: initMargin.toString(),
      maintMarginReq: maintMargin.toString(),
    }
  }

  /**
   * Cross-rate from `from` to `to` via USD. FxService.convertToUsd is
   * the only conversion the service exposes, so we run it twice and
   * divide.
   */
  private async fxRate(from: string, to: string): Promise<Decimal> {
    if (from === to) return new Decimal(1)
    const fxFrom = await this.fxService!.convertToUsd('1', from)
    const fxTo = await this.fxService!.convertToUsd('1', to)
    return new Decimal(fxFrom.usd).div(new Decimal(fxTo.usd))
  }

  async getPositions(): Promise<Position[]> {
    try {
      const resp = (await this.tradeCtx.stockPositions()) as unknown as LongbridgeStockPositionsResponseLike
      const out: Position[] = []
      for (const channel of resp.channels) {
        for (const p of channel.positions) {
          const qty = new Decimal(p.quantity.toString())
          if (qty.isZero()) continue
          const contract = makeContract(p.symbol)
          if (p.symbolName) contract.description = p.symbolName
          const cost = new Decimal(p.costPrice.toString())
          out.push({
            contract,
            currency: p.currency.toUpperCase(),
            side: qty.gte(0) ? 'long' : 'short',
            quantity: qty.abs(),
            avgCost: cost.toString(),
            // LB does not return live mark price on stockPositions —
            // leave at cost so marketValue is conservative; UTA snapshot
            // can refresh via getQuote() if needed.
            marketPrice: cost.toString(),
            marketValue: cost.times(qty.abs()).toString(),
            unrealizedPnL: '0',
            realizedPnL: '0',
          })
        }
      }
      return out
    } catch (err) {
      throw BrokerError.from(err)
    }
  }

  async getOrders(orderIds: string[]): Promise<OpenOrder[]> {
    const out: OpenOrder[] = []
    for (const id of orderIds) {
      const o = await this.getOrder(id)
      if (o) out.push(o)
    }
    return out
  }

  async getOrder(orderId: string): Promise<OpenOrder | null> {
    try {
      const o = (await this.tradeCtx.orderDetail(orderId)) as unknown as LongbridgeOrderLike
      return this.mapOpenOrder(o)
    } catch {
      return null
    }
  }

  async getQuote(contract: Contract): Promise<Quote> {
    const symbol = resolveSymbol(contract)
    if (!symbol) throw new BrokerError('EXCHANGE', 'Cannot resolve contract to Longbridge symbol')
    try {
      const [quotes, depth] = await Promise.all([
        this.quoteCtx.quote([symbol]) as unknown as Promise<LongbridgeSecurityQuoteLike[]>,
        (this.quoteCtx as unknown as { depth: (s: string) => Promise<LongbridgeSecurityDepthLike> }).depth(symbol)
          .catch(() => ({ asks: [], bids: [] } as LongbridgeSecurityDepthLike)),
      ])
      if (!quotes.length) throw new BrokerError('EXCHANGE', `No quote for ${symbol}`)
      const q = quotes[0]
      const bestBid = depth.bids[0]?.price?.toString() ?? '0'
      const bestAsk = depth.asks[0]?.price?.toString() ?? '0'
      return {
        contract: makeContract(symbol),
        last: q.lastDone.toString(),
        bid: bestBid,
        ask: bestAsk,
        volume: q.volume.toString(),
        high: q.high.toString(),
        low: q.low.toString(),
        timestamp: q.timestamp,
      }
    } catch (err) {
      throw BrokerError.from(err)
    }
  }

  async getMarketClock(): Promise<MarketClock> {
    try {
      const sessions = (await (this.quoteCtx as unknown as {
        tradingSession: () => Promise<LongbridgeMarketSessionLike[]>
      }).tradingSession()) ?? []
      const now = new Date()
      const isOpen = sessions.some((m) =>
        m.tradeSessions.some((s) => isWithinSession(now, s.beginTime, s.endTime)),
      )
      return { isOpen, timestamp: now }
    } catch (err) {
      throw BrokerError.from(err)
    }
  }

  // ---- Capabilities ----

  getCapabilities(): AccountCapabilities {
    return {
      supportedSecTypes: ['STK'],
      supportedOrderTypes: ['MKT', 'LMT', 'STP', 'STP LMT', 'TRAIL'],
    }
  }

  // ---- Contract identity ----

  getNativeKey(contract: Contract): string {
    const symbol = resolveSymbol(contract)
    return symbol ?? contract.symbol ?? ''
  }

  resolveNativeKey(nativeKey: string): Contract {
    return makeContract(nativeKey)
  }

  // ---- Internal ----

  private mapOpenOrder(o: LongbridgeOrderLike): OpenOrder {
    const contract = makeContract(o.symbol)
    const order = new Order()
    order.action = o.side === OrderSide.Sell ? 'SELL' : 'BUY'
    order.totalQuantity = new Decimal(o.quantity.toString())
    order.orderType = lbOrderTypeToIbkr(o.orderType)
    if (o.price) order.lmtPrice = new Decimal(o.price.toString())
    order.tif = lbTifToIbkr(o.timeInForce)
    order.orderId = 0  // LB orderIds are strings; preserved through PlaceOrderResult.orderId

    const ret: OpenOrder = {
      contract,
      order,
      orderState: makeOrderState(o.status, o.msg),
    }
    if (o.executedPrice) ret.avgFillPrice = new Decimal(o.executedPrice.toString()).toString()
    return ret
  }
}

// ==================== Reverse mapping (LB → IBKR for echo) ====================

function lbOrderTypeToIbkr(t: number): string {
  switch (t) {
    case LbOrderType.LO:    return 'LMT'
    case LbOrderType.ELO:   return 'MKT'  // close enough for echo
    case LbOrderType.MO:    return 'MKT'
    case LbOrderType.MIT:   return 'STP'
    case LbOrderType.LIT:   return 'STP LMT'
    case LbOrderType.TSMPCT:
    case LbOrderType.TSMAMT:
      return 'TRAIL'
    case LbOrderType.TSLPPCT:
    case LbOrderType.TSLPAMT:
      return 'TRAIL LIMIT'
    default:
      return 'LMT'
  }
}

function lbTifToIbkr(t: number): string {
  switch (t) {
    case TimeInForceType.GoodTilCanceled: return 'GTC'
    case TimeInForceType.GoodTilDate:     return 'GTD'
    case TimeInForceType.Day:
    default:                              return 'DAY'
  }
}

// ==================== Helpers ====================

function isWithinSession(
  now: Date,
  begin: { hour: number; minute: number; second: number },
  end: { hour: number; minute: number; second: number },
): boolean {
  // Compare in the local TZ — LB returns sessions in the market's local
  // calendar so dev-machine TZ skew is acceptable for a coarse open/closed
  // signal. Tighter wallclock fidelity belongs in the snapshot layer.
  const beginMin = begin.hour * 60 + begin.minute
  const endMin = end.hour * 60 + end.minute
  const nowMin = now.getHours() * 60 + now.getMinutes()
  if (beginMin <= endMin) return nowMin >= beginMin && nowMin <= endMin
  // Cross-midnight session (e.g. US overnight when viewed from Asia TZ)
  return nowMin >= beginMin || nowMin <= endMin
}
