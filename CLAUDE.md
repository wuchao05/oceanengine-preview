# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

```bash
# Install dependencies (requires pnpm, Node.js >= 18)
pnpm install

# Development: run TypeScript directly with tsx
pnpm dev -- --config ./config/settings.json

# Build: compile TypeScript to dist/
pnpm build

# Production: run compiled JavaScript
pnpm start -- --config ./config/settings.json

# Run proxy server (for CORS debugging)
pnpm proxy
```

## Project Architecture

This is a Node.js backend service that manages advertising materials on OceanEngine (ByteDance's advertising platform). The main workflow:

1. **Fetch Feishu token** → Authenticate with Feishu/Lark API
2. **Query drama status table** → Get "已完成" (completed) drama records with accounts
3. **Filter by time window** → Only process records within `buildTimeFilterWindowStartMinutes` to `buildTimeFilterWindowEndMinutes`
4. **Match ads by drama name** → Pull promotions matching each drama
5. **Filter by aweme whitelist** → Only keep ads matching whitelist抖音号
6. **Pull materials** → Fetch materials for filtered promotions (with concurrency control via `p-limit`)
7. **Classify materials** → Separate into "need preview" vs "need delete" based on status
8. **Execute actions** → Preview materials, delete materials, or delete entire promotions

### Key Modules

- **[src/index.ts](src/index.ts)**: Main entry point with the full pipeline
- **[src/proxy.ts](src/proxy.ts)**: HTTP proxy server forwarding to OceanEngine (bypasses CORS, useful for debugging)

### Configuration Structure

**settings.json** contains:
- `accounts`: Array of `{ aadvid, drama_name, cookie? }` - if empty, pulls from Feishu
- `cookie`: Global cookie (can be overridden per-account)
- `appId/appSecret/appToken/tableId/baseUrl`: Feishu API credentials
- `aweme_white_list`: Global whitelist of 抖音号 for filtering
- `buildTimeFilterWindowStartMinutes/EndMinutes`: Time window filter (default 50-30 minutes ago)
- `fetchConcurrency`: Concurrency limit for API calls (default 3)
- `previewDelayMs`: Delay between preview calls (default 400ms)
- `scheduleIntervalMinutes`: If set, runs in scheduler mode recursively
- `dryRun`: If true, only logs what would be done

### Important Constants

Default Feishu credentials (can be overridden in settings.json):
- `DEFAULT_FEISHU_APP_ID = "cli_a870f7611b7b1013"`
- `DEFAULT_FEISHU_APP_SECRET = "NTwHbZG8rpOQyMEnXGPV6cNQ84KEqE8z"`
- `DEFAULT_FEISHU_APP_TOKEN = "WdWvbGUXXaokk8sAS94c00IZnsf"`
- `DEFAULT_FEISHU_TABLE_ID = "tblDOyi2Lzs80sv0"`

## Coding Conventions

- **Language**: TypeScript with ESM, 2-space indentation
- **Style**: camelCase for variables/functions, UPPER_CASE for constants
- **Async**: Prefer async/await over callbacks
- **Logging**: Use `[INFO]/[WARN]/[ERROR]` prefixes; comments in Chinese
- **Types**: Avoid `any`, define proper interfaces for API responses

## Security Notes

- **NEVER commit** `config/settings.json` containing cookies, tokens, or mappings
- The proxy allows CORS from any origin - restrict if deploying externally
- Be mindful of Feishu/OceanEngine rate limits - adjust `fetchConcurrency` if needed
