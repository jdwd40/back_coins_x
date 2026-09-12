# New features

Requested and planned work that is not part of the current production feature set. Last reviewed 12 September 2026.

## Requested

### Player-visible bot activity

**Goal:** let players inspect which bots are buying and selling behind the scenes, making leaderboard movement more understandable.

**Constraints:** expose only completed trades or safe summaries. Do not expose strategy internals, RNG state, the world seed, future actions, or information unavailable to human players. Keep payloads bounded.

**Priority:** Medium
**Status:** Requested; needs product/API design after balance playtesting.

## Planned engineering work

### Evidence-led balance pass

Measure multi-hour and multi-day production behaviour before tuning volatility, event frequency, intervention frequency, bot performance, deaths, loans, and replacement pacing.

**Priority:** High
**Status:** Active playtesting; parameter changes not yet specified.

### Architecture references

Create a visual human architecture report and a denser LLM orientation report from the actual current code. Keep them descriptive rather than redesigning the application.

**Priority:** High
**Status:** Planned/in progress separately.

### Legacy compatibility retirement

After caller and monitor audits, remove proven-unreachable Apocalypse player surfaces, old workers/services, and unmounted frontend modules in small tested changes.

**Priority:** Medium
**Status:** Planned; blocked on evidence. Do not perform as opportunistic cleanup.

### Maintainability refactors

Use the dedicated complexity review to rank behaviour-preserving reductions in duplication, overloaded modules, and competing legacy logic.

**Priority:** Medium
**Status:** Review first; no implementation approved yet.

## Future ideas

### Wider multiplayer play

Grow beyond the current small friends/family audience only after authentication, economy correctness, market balance, and operating reliability are proven.

**Status:** Future only.

### Alternative fantasy presentation

The earlier **Dwarf Mines and Markets** gem/miner theme remains an optional art direction, not a separate product or committed rebuild.

**Status:** Idea only.

## Excluded ideas

Do not add real cryptocurrency, blockchain, real-money payments, deposits, withdrawals, investment advice, wallet custody, gambling, or real exchange integration.
