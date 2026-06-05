# Review Request: WeChat Clawbot Default Cat

Review-Target-ID: wechat-clawbot-default-cat
Branch: main
Code commit: 43b8a7e0 fix(api): route connectors to registered default cat
Author: [砚砚/gpt-5.5🐾]

## Original Requirements

Source: thread `thread_mq0vb0x0hf4r8wgy`, 2026-06-05.

- 11:55 UTC co-creator: "@砚砚 @宪宪 我刚才连接了微信clawbot并发送了信息，但是没有回复，请帮我修复"
- 12:01 UTC service notice: "服务刚重启，2 只猫 的进行中请求已中断，请重新发送。"
- 12:01 UTC co-creator repeated the same WeChat clawbot no-reply request.
- 12:16 UTC co-creator asked 宪宪 to analyze and hand implementation to Codex.
- 12:16 UTC 宪宪 diagnosed `Unknown cat ID: opus` in connector invocation and handed regression coverage plus commit/push to 砚砚.

Reviewer ask: verify that inbound WeChat messages no longer route to a stale `opus` default when the registered cat catalog contains a valid cat.

## Root Cause

`ConnectorRouter` was initialized with a baked-in `defaultCatId` of `opus`. During startup, `getCachedConfig()` can be unavailable before the cat catalog is loaded, so connector mention parsing used `opus` even when `opus` is not a registered runtime cat. The invoke trigger then rejected the message with `Unknown cat ID: opus`.

## Change Summary

- `packages/api/src/config/cat-config-loader.ts`: `getDefaultCatId()` now tries `catRegistry.getAllIds()[0]` before the zero-member bootstrap fallback.
- `packages/api/src/index.ts`: connector gateway initialization now passes `getDefaultCatId()` instead of hardcoded `opus`.
- `packages/api/src/infrastructure/connectors/ConnectorRouter.ts`: mention parsing uses `getValidDefaultCatId()`, which validates configured default against `catRegistry` and falls back to the first registered cat with a warning.
- `packages/api/test/connector-router.test.js`: regression covers stale `defaultCatId=opus` with only `codex` registered, asserting the invocation target and stored mention become `codex`.

## Architecture Ownership

Architecture cell: connector routing / invocation dispatch
Map delta: none
Why: this changes default cat selection inside the existing connector routing path. It does not add or change Store, Queue, Router, Adapter, Dispatcher, or Binding ownership boundaries.

## Review Focus

- P1: Is falling back to the first registered cat the correct behavior when the configured connector default is stale?
- P2: Does using the same validated default in `/thread` forwarding and normal routing preserve existing explicit mention and last-active participant priority?
- P2: Is the warning log sufficient observability for stale runtime config/catalog races?

## Quality Gate Evidence

- `pnpm biome check packages/api/src/config/cat-config-loader.ts packages/api/src/index.ts packages/api/src/infrastructure/connectors/ConnectorRouter.ts packages/api/test/connector-router.test.js --diagnostic-level=error` -> pass.
- `pnpm --dir packages/api run lint` -> pass.
- `pnpm --dir packages/api run build` -> pass.
- PowerShell-isolated `node --import setup-cat-registry.js --test --test-timeout=60000 test/connector-router.test.js` -> 43/43 pass.
- `git diff --check -- <touched files>` -> no whitespace errors; Git emitted CRLF conversion warnings only.
- Root media/design artifact hygiene checks -> no matches.

## Known Limits

- The package `test` script was not used directly because this Windows shell maps `bash` to WSL, and WSL lacks `/bin/bash`. I ran the same Node test entrypoint with the environment isolation from `scripts/with-test-home.sh` reproduced in PowerShell.
- I did not commit runtime `.env` changes; AGENTS.md marks runtime config as human-managed, and `.env` is not a tracked source artifact.
