import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import YahooFinance from "yahoo-finance2";
import { cacheGet, cacheSet, cacheKey, TTL } from "./cache.js";

const yf = new YahooFinance({
  suppressNotices: ["ripHistorical"],
  validation: { logErrors: false },
});

const TICKERS = ["AAPL", "AMZN", "GOOGL", "META", "MSFT", "NFLX", "NVDA", "TSLA"] as const;

const server = new McpServer({
  name: "stock-mcp-server",
  version: "1.0.0",
});

// get_current_price
server.tool(
  "get_current_price",
  "Get real-time price, change, volume, and market cap for a stock ticker",
  { ticker: z.enum(TICKERS).describe("Stock ticker symbol") },
  async ({ ticker }) => {
    const key = cacheKey("price", ticker);
    const cached = cacheGet<object>(key, TTL.PRICE);
    if (cached) return { content: [{ type: "text" as const, text: JSON.stringify(cached) }] };

    try {
      const quote = await yf.quote(ticker);
      const result = {
        ticker,
        price: quote.regularMarketPrice ?? null,
        change: quote.regularMarketChange ?? null,
        changePercent: quote.regularMarketChangePercent ?? null,
        volume: quote.regularMarketVolume ?? null,
        marketCap: quote.marketCap ?? null,
      };
      cacheSet(key, result);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

// get_stock_overview
server.tool(
  "get_stock_overview",
  "Get company overview including sector, P/E ratio, 52-week range, beta, and business summary",
  { ticker: z.enum(TICKERS).describe("Stock ticker symbol") },
  async ({ ticker }) => {
    const key = cacheKey("overview", ticker);
    const cached = cacheGet<object>(key, TTL.OVERVIEW);
    if (cached) return { content: [{ type: "text" as const, text: JSON.stringify(cached) }] };

    try {
      const summary = await yf.quoteSummary(ticker, {
        modules: ["price", "summaryDetail", "defaultKeyStatistics", "assetProfile"],
      });
      const result = {
        ticker,
        shortName: summary.price?.shortName ?? null,
        sector: (summary.assetProfile as { sector?: string } | null | undefined)?.sector ?? null,
        trailingPE: summary.summaryDetail?.trailingPE ?? null,
        fiftyTwoWeekHigh: summary.summaryDetail?.fiftyTwoWeekHigh ?? null,
        fiftyTwoWeekLow: summary.summaryDetail?.fiftyTwoWeekLow ?? null,
        beta: summary.summaryDetail?.beta ?? null,
        longBusinessSummary: (summary.assetProfile as { longBusinessSummary?: string } | null | undefined)?.longBusinessSummary ?? null,
      };
      cacheSet(key, result);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

// get_price_history
const PERIOD_DAYS: Record<string, number> = { "5d": 5, "1mo": 30, "3mo": 90, "1y": 365 };

server.tool(
  "get_price_history",
  "Get daily OHLCV price history for a stock ticker over a specified period",
  {
    ticker: z.enum(TICKERS).describe("Stock ticker symbol"),
    period: z.enum(["5d", "1mo", "3mo", "1y"]).describe("Time period: 5d, 1mo, 3mo, or 1y"),
  },
  async ({ ticker, period }) => {
    const key = cacheKey("history", ticker, period);
    const cached = cacheGet<object>(key, TTL.HISTORY);
    if (cached) return { content: [{ type: "text" as const, text: JSON.stringify(cached) }] };

    try {
      const period1 = new Date();
      period1.setDate(period1.getDate() - PERIOD_DAYS[period]);

      const chart = await yf.chart(ticker, { period1, interval: "1d" });
      const rows = chart.quotes ?? [];
      const result = {
        ticker,
        period,
        history: rows.map((row) => ({
          date: new Date(row.date).toISOString().split("T")[0],
          open: row.open ?? null,
          high: row.high ?? null,
          low: row.low ?? null,
          close: row.close ?? null,
          volume: row.volume ?? null,
        })),
      };
      cacheSet(key, result);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

// get_financials
server.tool(
  "get_financials",
  "Get annual revenue, net income, gross profit, and EPS for a stock ticker",
  { ticker: z.enum(TICKERS).describe("Stock ticker symbol") },
  async ({ ticker }) => {
    const key = cacheKey("financials", ticker);
    const cached = cacheGet<object>(key, TTL.FINANCIALS);
    if (cached) return { content: [{ type: "text" as const, text: JSON.stringify(cached) }] };

    try {
      const [fundamentals, summary] = await Promise.all([
        yf.fundamentalsTimeSeries(ticker, { period1: "2019-01-01", module: "financials", type: "annual" }),
        yf.quoteSummary(ticker, { modules: ["defaultKeyStatistics"] }),
      ]);

      const result = {
        ticker,
        trailingEps: summary.defaultKeyStatistics?.trailingEps ?? null,
        annualFinancials: fundamentals.map((row) => ({
          date: row.date.toISOString().split("T")[0],
          totalRevenue: (row as Record<string, unknown>).annualTotalRevenue ?? null,
          netIncome: (row as Record<string, unknown>).annualNetIncome ?? null,
          grossProfit: (row as Record<string, unknown>).annualGrossProfit ?? null,
        })),
      };
      cacheSet(key, result);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
