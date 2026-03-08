# stock-mcp — stdio transport

An agentic CLI that uses an MCP server (stdio transport) to answer stock questions via Claude. The client spawns the server as a subprocess and communicates over stdin/stdout using JSON-RPC.

**Supported tickers:** AAPL, AMZN, GOOGL, META, MSFT, NFLX, NVDA, TSLA

**Available tools:**
- `get_current_price` — real-time price, change, volume, market cap
- `get_stock_overview` — sector, P/E, 52-week range, beta, business summary
- `get_price_history` — daily OHLCV for 5d / 1mo / 3mo / 1y
- `get_financials` — annual revenue, net income, gross profit, EPS

---

## Prerequisites

- `ANTHROPIC_API_KEY` — required by the client to call Claude

---

## MCP Inspector

To inspect and test the server interactively:

```bash
# Run from the 1_stdio directory
npx @modelcontextprotocol/inspector npx tsx server/server.ts
```

Then open the URL printed in the terminal (e.g. `http://localhost:6274/?MCP_PROXY_AUTH_TOKEN=...`).

---

## Without Docker

### 1. Install dependencies

```bash
cd server && npm install && cd ..
cd client && npm install && cd ..
```

### 2. Set your API key

```bash
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_API_KEY=your_api_key_here
```

Optionally set a custom cache path (defaults to `/data/cache.json`):

```bash
export CACHE_FILE_PATH=./data/cache.json
```

### 3. Run the CLI

```bash
npx --prefix client tsx client/cli.ts
```

The client will spawn the MCP server automatically as a subprocess.

---

## With Docker

### 1. Set your API key

```bash
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY=sk-ant-...
```

### 2. Build and run

```bash
docker compose run --rm app
```

> Use `docker compose run` (not `up`) — it attaches an interactive TTY required for readline input.

Cache data is persisted in the `stock_cache` Docker volume across runs.

### Rebuild after code changes

```bash
docker compose build
docker compose run --rm app
```

---

## Example session

```
> What is NVDA's current price?
NVDA is currently trading at $875.40, up 2.3% today.

> Compare the 1-year performance of MSFT and AAPL
...

> exit
```

Type `exit` or press `Ctrl+C` to quit.
