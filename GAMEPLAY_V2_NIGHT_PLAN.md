# CRYPTO CHAOS V2 — OVERNIGHT DEVELOPMENT PLAN

## PROJECT OBJECTIVE

Crypto Chaos Milestone 1 successfully produced the technical infrastructure for a persistent multiplayer-style apocalypse trading game, but human play-testing showed that the actual gameplay loop is unclear and does not give the player sufficient ability to make money through understandable skill.

V2 is NOT a rewrite.

Preserve useful existing infrastructure including:

- authentication
- server-owned 30-minute apocalypse rounds
- current £10,000 round starting cash unless simulation gives strong reason to change it
- automatic active-round participant initialization
- real buy/sell trading
- holdings
- transaction history
- bots framework
- collapses
- ACTIVE → SETTLING → COMPLETED lifecycle
- settlement
- immutable results
- leaderboards
- diagnostics
- central frontend API configuration
- existing useful charts/profile/history where appropriate

The primary gameplay redesign is:

DIP
→ RISE
→ BOOM
→ FALL
→ DIP

Players make money primarily by:

BUYING LOW
→ HOLDING THROUGH A RISE
→ SELLING HIGH

A player who understands the market must demonstrably outperform someone trading randomly.

The game should feel like a casual mobile trading game rather than a professional exchange simulator.

==================================================
REPOSITORY STATE
==================================================

Backend:

/home/jd/work/back_coins_x

Frontend:

/home/jd/work/fcoins_y

Development branch in BOTH repositories:

gameplay-v2-20260824

These branches are already prepared and checkpointed.

DO NOT redo V2-0 preparation unless repository inspection proves something is genuinely wrong.

Known preparation state:

Backend original main:
6efc8e2ec9c063a91daf1bad11b67cee9e94e5c0

Backend V2 preparation SHA:
6d649f3dd2e8b7a1990fea929695121922ff38d0

The backend V2 branch also preserves legitimate existing unfinished bot work.

Do not silently discard or overwrite that work.

Frontend original master/Core 7:
ec190d167a9ed03f5fd6bd642196ad6a9a982330

Frontend V2 preparation SHA:
3a2688b3111785f09321dd9f8cb8f32ff6d63357

Known baseline backend verification:

59 suites passed
1 suite failed
535 tests passed
1 test failed

Existing baseline failure:

game-public-state-no-seed.test.js

Expected:
201 Created

Received:
400 Bad Request

Treat this exact known failure as PRE-EXISTING unless V2 changes its behaviour.

Do not waste the overnight run fixing unrelated baseline defects unless they block V2 or V2 makes them worse.

Existing Jest force-exit/open-handle warning is also baselined.

Frontend baseline:

lint PASS with 6 existing warnings
test:ui PASS
test:unit PASS — 109 tests
build PASS

Existing Browserslist/caniuse-lite warning is baselined.
==================================================
ABSOLUTE SAFETY RULES
==================================================

Work ONLY on:

gameplay-v2-20260824

Never:

- merge into main
- merge into master
- push main
- push master
- deploy
- restart production services
- run production migrations
- modify production data
- use production as a test database
- remove historical migrations
- destructively reseed the game
- destroy existing coin/history/result data

Successful checkpoint commits MAY be pushed to:

gameplay-v2-20260824

This is encouraged as an overnight backup.

Use disposable/local test databases for database work.

==================================================
WORKFLOW
==================================================

Luna orchestrates.

Kimi K3 performs implementation work.

Use a FRESH K3 implementation task for each major V2 stage.

Do not carry one enormous K3 context through the whole project.

For each stage Luna should:

1. Read GAMEPLAY_V2_NIGHT_PLAN.md.
2. Read GAMEPLAY_V2_PROGRESS.md.
3. Inspect current repository state.
4. Give K3 the smallest complete implementation brief for that stage.
5. Let K3 implement.
6. Independently inspect the resulting diff.
7. Run the required tests/simulations.
8. Return genuine defects to K3 for correction.
9. Repeat within the same stage until its gate passes.
10. Commit the successful stage.
11. Push the V2 branch as backup.
12. Update GAMEPLAY_V2_PROGRESS.md in both repositories.
13. Continue to the next stage.

If K3 context becomes degraded or exhausted during a stage:

- checkpoint coherent work
- update progress
- start a fresh K3 implementation/review task
- continue from repository state

Do not rely on chat memory as the authoritative project state.

==================================================
K3 QUOTA / RATE LIMIT HANDLING
==================================================

Kimi K3 may hit its rolling usage limit.

THIS IS NOT A PROJECT BLOCKER.

Classify K3 quota exhaustion as:

WAITING

Never classify temporary quota exhaustion as:

BLOCKED
FAILED
DONE

When quota is exhausted:

1. Stop issuing repeated K3 requests.
2. Finish any safe local verification already possible.
3. Ensure worktrees are coherent.
4. Commit successfully completed work where appropriate.
5. Push the V2 checkpoint.
6. Update GAMEPLAY_V2_PROGRESS.md with:
   - current stage
   - completed work
   - current SHAs
   - failing/passing tests
   - exact next operation
   - provider quota state
7. If the provider supplies a cooldown/reset time, park until that time.
8. Otherwise use a conservative background wait rather than hammering the provider.
9. Resume from repository/progress state once K3 is available.
10. Continue the same stage.

Do NOT switch to another coding provider merely to bypass the K3 quota.

Luna may continue orchestration, inspection and testing while K3 is unavailable, but substantial implementation should resume with K3.

==================================================
DURABLE PROGRESS
==================================================

Maintain:

GAMEPLAY_V2_PROGRESS.md

After every significant checkpoint record:

- stage
- status
- backend SHA
- frontend SHA
- files changed
- migrations added
- tests run
- simulation configuration
- simulation statistics
- tuning changes
- known issues
- K3 quota state
- next action

Statuses should include:

NOT STARTED
IN PROGRESS
GATE FAILED — TUNING
WAITING — K3 QUOTA
COMPLETE
GENUINE BLOCKER

==================================================
V2-1 — CYCLICAL MARKET ENGINE
==================================================

PRIMARY OBJECTIVE:

Replace the gameplay-facing random-walk behaviour with a server-authoritative cyclical market that rewards timing skill.

The intended broad cycle is:

DIP
→ RISE
→ BOOM
→ FALL
→ DIP

Do not remove real buy/hold/sell trading.

Do not replace trading with instant RNG payouts.

--------------------------------------------------
COIN ARCHETYPES
--------------------------------------------------

Initial balancing targets:

ZIP

Cycle:
approximately 1–3 minutes
Typical swing:
approximately 4–8%

Purpose:
fast, low-return mobile trades


MOON

Cycle:
approximately 3–5 minutes

Typical swing:
approximately 8–15%

Purpose:
bread-and-butter trading


BULL

Cycle:
approximately 5–8 minutes

Typical swing:
approximately 12–20%

Purpose:
medium swing trading


HODL

Cycle:
approximately 10–15 minutes

Typical swing:
approximately 20–35%

Purpose:
longer commitment and larger potential gain


DEGEN

Cycle:
approximately 2–8 minutes

Typical swing:
approximately 15–40%

Purpose:
less predictable high-risk trading


RUG

Cycle:
irregular

Potential swing:
approximately 10–60%

Purpose:
extreme opportunity/risk

These numbers are INITIAL BALANCE PARAMETERS.

They may be tuned.

Implement archetypes/configuration cleanly.

Do NOT destructively replace existing historical coin records merely to obtain these names.

Map existing active gameplay coins to archetypes or introduce an explicit non-destructive gameplay roster.

Preserve history.

--------------------------------------------------
MARKET MODEL
--------------------------------------------------

Each generated cycle must vary.

Variation should include:

- phase duration
- dip depth
- rise strength
- boom height
- fall depth
- transition shape
- bounded short-term noise
- underlying price anchor/regime

CRITICAL:

The next boom must NOT automatically rescue every bad entry.

The underlying anchor/regime should be capable of drifting between cycles.

Example conceptually:

cycle 1:
£8 DIP → £10 BOOM

cycle 2:
£7 DIP → £9 BOOM

cycle 3:
£7.50 DIP → £11 BOOM

A player who misses a peak must face a genuine decision:

sell now at a smaller profit/loss
OR
risk waiting through another cycle.

The market must be:

LEARNABLE, NOT SOLVABLE.

--------------------------------------------------
SHARED DOMAIN LOGIC
--------------------------------------------------

This is mandatory.

Do NOT create one market implementation for production and a different fake implementation for simulation.

Refactor the market model into deterministic/reusable gameplay-domain logic driven by inputs such as:

- seed
- authoritative time
- apocalypse state
- coin archetype
- persisted cycle/regime state

The live game uses:

REAL authoritative time.

The simulator uses:

AN INJECTED/FAKE accelerated clock.

Both must execute the SAME market-domain logic.

Restart/process behaviour must remain deterministic from persisted state.

Preserve current multi-process/race safety.

Collapsed coins must remain exactly £0 and be excluded from normal positive-price market updates.

Non-collapsed coins must remain valid finite positive prices.

--------------------------------------------------
MARKET STAGGERING
--------------------------------------------------

The active market should usually contain multiple different opportunities.

Avoid having every coin simultaneously flat, booming or falling.

Do not enforce a crude rigid invariant every second.

Instead stagger cycles so normal gameplay generally contains combinations such as:

- one dipping
- one turning
- one rising
- one booming
- one falling

A player opening the game should usually have something worth evaluating.

--------------------------------------------------
PUBLIC SIGNALS
--------------------------------------------------

Players may receive:

- current price
- recent percentage movement
- coarse phase
- momentum direction
- coin archetype/personality
- approximate typical cycle range
- approximate typical swing range
- dead/collapsed state
- coarse risk/stability information when introduced

Players must NOT receive:

- future exact phase timestamps
- future exact peak
- future target price
- hidden PRNG seed
- future collapse order
- future collapse timestamp

Signals must contain useful uncertainty.

A legal public-signal strategy must not be able to print money with trivial exact rules.

==================================================
V2-1 SIMULATION HARNESS
==================================================

Build a headless accelerated simulator.
This is a first-class part of V2, not disposable test code.

It must:

- use the SAME market-domain code as live gameplay
- use seeded deterministic runs
- run complete 30-minute apocalypse rounds rapidly
- allow paired strategy comparison on identical market paths
- support thousands of rounds
- report reproducible statistics

During tuning smaller batches are acceptable.

For the final V2-1 gate run at least approximately:

2,000 paired seeded apocalypse rounds

if runtime remains practical.

Do not cherry-pick seeds.

--------------------------------------------------
SIMULATION STRATEGIES
--------------------------------------------------

Implement at least:

RANDOM

Trades without meaningful understanding of market phases.


DIP-BOOM

Uses only legal public information.

Attempts to enter DIP/early RISE and exit BOOM/late RISE.


LATE SELLER

Recognises dips reasonably well but habitually exits too late.


HOLD FOREVER

Buys and rarely/never exits.


SPAM / BUY EVERYTHING

Attempts to exploit every apparent opportunity.


PUBLIC-SIGNAL EXPLOITER

Simulation-only adversarial strategy.

Uses every piece of LEGAL public information as efficiently and mechanically as possible.

It must have NO hidden future knowledge.

Purpose:

determine whether public signals make the game trivially scriptable.


PERFECT INFORMATION

Simulation-only upper benchmark.

May know future market state.

This strategy MUST NEVER be used by real bots or gameplay.

--------------------------------------------------
REALISTIC SIMULATION CADENCE
--------------------------------------------------

Do not give ordinary simulated strategies impossible millisecond reaction times.

Use the same market update/observation cadence a real client could reasonably experience.

Paired strategies should receive equivalent timing opportunities.

Perfect-information exists separately as the impossible upper bound.

--------------------------------------------------
V2-1 METRICS
--------------------------------------------------

Report at minimum:

- mean final cash
- median final cash
- mean ROI
- median ROI
- profitable-round frequency
- paired win rate between strategies
- percentile spread
- representative best/worst outcomes
- trades per round
- time in market
- drawdown where practical

--------------------------------------------------
V2-1 PASS GATE
--------------------------------------------------

The intended DIP-BOOM strategy must demonstrate a CLEAR, REPEATABLE advantage over RANDOM.

Initial target:

DIP-BOOM beats RANDOM on approximately 70% or more of identical paired market paths.

Also require:

- positive median skill advantage
- materially higher median ROI than RANDOM
- late seller performs worse than good DIP-BOOM timing
- hold forever is meaningfully risky
- perfect information remains strongest
- public-signal exploiter does not reveal a trivial unlimited-money exploit

Do not distort the game solely to hit one arbitrary number.

If approximately 70% is not sensible after rigorous investigation, Luna/K3 may justify a nearby threshold, but the skill advantage must remain large and obvious.

If DIP-BOOM cannot reliably outperform RANDOM after serious tuning:

DO NOT ADVANCE TO V2-2.

Remain at:

GATE FAILED — TUNING

Continue tuning the MARKET, not later features.

If the mechanic fundamentally cannot create the intended skill advantage:

record a GENUINE BLOCKER and stop autonomous feature expansion.

Commit/push V2-1 only after the gate is credible.

==================================================
V2-2 — POWER + POSITION LIMIT
==================================================

Add persistent POWER.

Initial concept:

maximum:
100

regeneration:
approximately +1 per 2 real minutes

THIS REGENERATION RATE IS NOT SACRED.

It must be tuned through multi-round simulation.

Prefer timestamp/lazy reconciliation rather than continuously writing every player's Power to the database.

Power must work across:

- process restart
- browser close
- inactivity
- apocalypse rollover
--------------------------------------------------
POWER RULE
--------------------------------------------------

BUY COSTS POWER.

SELL COSTS ZERO POWER.

Selling must NEVER be blocked because the player lacks Power.

Power controls entry into opportunities.

It must not imprison a player inside a losing position.

If a BUY transaction fails:

Power must not be consumed.

Power deduction + buy must be atomic.

--------------------------------------------------
POWER COSTS
--------------------------------------------------

Initial conceptual targets might resemble:

£250 → ~2 Power
£500 → ~4 Power
£1,000 → ~8 Power
£2,500 → ~20 Power

Design a coherent server-side cost function.

Test specifically against:

- splitting large buys into many tiny buys
- repeated averaging down
- concurrent buys
- retries
- race conditions
- huge account balances
- very small buys

Do not allow players to bypass Power through transaction fragmentation.

--------------------------------------------------
POSITION LIMIT
--------------------------------------------------

Initial target:

maximum 3 different open coin positions.

Adding to an already-open coin:

allowed
but costs Power.

Opening a fourth distinct live position:

blocked.

Selling:

unrestricted.

Dead/zeroed positions must not permanently consume an active position slot incorrectly.

--------------------------------------------------
COST BASIS / P&L
--------------------------------------------------

The game needs clear player-facing position economics.

Provide reliable weighted-average entry price / cost basis.

For an open position the server/client must be able to represent:

- quantity
- weighted average entry price
- total cost basis
- current market value
- unrealised P&L £
- unrealised P&L %

Partial sells must preserve mathematically correct remaining cost basis.

Completed positions must not corrupt immutable transaction history.

==================================================
V2-2 MULTI-ROUND SIMULATION
==================================================

Extend the SAME simulator.

Do NOT evaluate Power only across one apocalypse.

Simulate repeated rounds and real elapsed regeneration.

Test at least representative runs covering approximately:

12–24 consecutive apocalypse rounds

or an equivalent duration.

Measure:

- average Power at round start
- average Power at round end
- actions per round
- percentage of time Power-starved
- active opportunities skipped due to Power
- late entrant performance
- returning player performance
- aggressive player depletion
- conservative player reserve
- bot sustainability once bots are introduced

A player must not burn Power in one round and then become effectively unable to participate for hours unless that is a deliberate and demonstrably fun trade-off.

Tune:

- max Power
- regeneration
- buy costs

as required.

--------------------------------------------------
V2-2 STRATEGY GATE
--------------------------------------------------

Re-run:

- DIP-BOOM
- RANDOM
- SPAM
- PUBLIC-SIGNAL EXPLOITER
- conservative Power spender
- aggressive Power spender
- trade-splitting attacker
- late entrant with stored Power

Require:

- DIP-BOOM retains clear advantage
- spam is constrained
- splitting does not bypass Power
- late entrants can still make meaningful leaderboard moves
- Power produces decisions rather than simply preventing play

Do not continue until credible.

Checkpoint, commit, push, progress update.

==================================================
V2-3 — APOCALYPSE ESCALATION + COLLAPSE RISK
==================================================

Preserve the existing 30-minute global apocalypse.

Use apocalypse progress to amplify the trading game.

Initial intended feel:

0–40%
normal cyclical trading

40–70%
increased activity

70–90%
larger/faster swings

90–100%
extreme opportunity + extreme danger

Late game should provide strong comeback opportunities.

Avoid making every coin react identically.
--------------------------------------------------
COLLAPSES
--------------------------------------------------

Preserve the existing permanent-collapse infrastructure where practical.

Collapsed coin:

- exactly £0
- remains £0
- cannot be bought
- existing position may become worthless
- remains historically visible

Do NOT expose future collapse schedule/order.

Introduce coarse imperfect risk information such as:

STABLE
SHAKY
DANGER
CRITICAL

Risk information must be useful but noisy/imperfect.

It must not simply encode:

"this is definitely the next coin to die."

Test for hidden-collapse leakage.

Desired decision:

"My position is +30%.
Apocalypse is 92%.
The coin is CRITICAL.
Do I cash out or risk another rise?"

--------------------------------------------------
PASSIVE ECONOMY
--------------------------------------------------

Current passive economy/deduction infrastructure is preserved.

Do NOT destructively remove migrations or historical functionality.

For V2 gameplay:

configuration-gate
disable
or dramatically weaken

passive deductions if required.

The dominant P&L source must be:

SELL VALUE - BUY VALUE.

A correctly timed trade should not routinely be erased by unrelated background deductions.

Keep configuration explicit and testable.

==================================================
V2-3 SIMULATION GATE
==================================================

Run large paired seeded simulations including:

- apocalypse scaling
- collapse exposure
- risk signals
- Power
- position limits

Verify:

- early round is understandable
- late round offers greater upside
- late round contains greater danger
- exit timing materially affects outcome
- overstaying dangerous positions can cause major losses
- late entrants retain comeback potential
- collapses do not remove all worthwhile choices too early
- risk signals do not reveal exact hidden future
- HOLD FOREVER does not become a reliable rescue strategy

Checkpoint only after passing.

==================================================
V2-4 — ADAPT BOTS
==================================================

Preserve and adapt the existing bot framework.

The backend V2 branch contains legitimate existing bot work.

Inspect and integrate it.

Do not simply discard it because V2 changes behaviour.

All real bots must use:

- same market as humans
- same public signals
- same Power rules
- same position limits
- same buy/sell domain service
- same trading lifecycle

Bots may NOT use:

- hidden market seeds
- future phase transitions
- future peak prices
- hidden collapse identity
- hidden collapse timestamp

--------------------------------------------------
BOT PERSONALITIES
--------------------------------------------------

CONSERVATIVE

- prefers DIP / early RISE
- smaller stakes
- exits earlier
- avoids very dangerous coins
- preserves Power


MOMENTUM

- prefers established RISE
- may enter later
- follows momentum
- exits when momentum weakens


DIP BUYER

- strongly favours DIP
- attempts to ride toward BOOM
- may occasionally stay too long


RECKLESS

- prefers volatile/high-upside opportunities
- larger stakes
- spends Power aggressively
- accepts CRITICAL risk more readily
- sometimes wins huge
- sometimes gets destroyed

==================================================
BOT GATE
==================================================

Run autonomous bot simulations over repeated apocalypse rounds.

Verify:

- personalities produce measurably different behaviour
- bots obey Power
- bot Power remains sustainable across rounds
- bots obey position limits
- bots can always sell
- bots have no hidden information
- bots can win rounds
- no single personality dominates almost every round
- intended skilled human-like DIP-BOOM behaviour remains competitive

Checkpoint, commit, push.

==================================================
V2-5 — MOBILE-FIRST GAME UI
==================================================

ONLY BEGIN V2-5 AFTER V2-1 THROUGH V2-4 GATES PASS.

The UI must feel like a casual mobile game.

Do not rebuild a desktop exchange and shrink it.
Preserve useful existing frontend architecture where sensible, including centralized API handling and server-authoritative countdown behaviour.

--------------------------------------------------
PRIMARY SCREEN
--------------------------------------------------

Prominently show:

- apocalypse ID
- countdown
- apocalypse %
- current round Cash
- Power / max
- regeneration information
- leaderboard rank
- open positions

Then show approximately six large active coin cards.

The player should be able to scan the entire market rapidly.

--------------------------------------------------
COIN CARD — NOT OWNED
--------------------------------------------------

Show approximately:

- coin name
- current price
- recent movement
- coarse phase
- momentum
- archetype/personality
- typical approximate cycle
- typical approximate swing
- risk/stability
- quick BUY amounts
- Power cost BEFORE committing

Example conceptual actions:

£250
£500
£1K
£2.5K

Server remains authoritative.

No optimistic fake success.

--------------------------------------------------
OWNED POSITION
--------------------------------------------------

Make the player's own economics visually dominant.

Show:

BOUGHT / AVG ENTRY
CURRENT PRICE
POSITION VALUE
P&L £
P&L %
PHASE
RISK

Example:

AVG £7.41
NOW £8.42

+13.6%
+£136

🔥 BOOM

[ SELL POSITION ]

Primary mobile interaction may default to selling the complete position for simplicity.

Existing backend support for partial selling may remain available and may be exposed secondarily if useful.

Do not make partial-trade controls clutter the primary game loop.

--------------------------------------------------
CHARTS
--------------------------------------------------

Charts/history may remain available through drill-down.

They are secondary.

A player should NOT need to interpret a professional financial chart just to understand whether a coin is currently dipping/rising/booming.

--------------------------------------------------
DEAD COINS
--------------------------------------------------

Clearly show:

£0.00
DEAD / COLLAPSED

No BUY.

Existing destroyed holdings show the loss clearly.

--------------------------------------------------
LEADERBOARD
--------------------------------------------------

Humans and bots remain together.

Show:

- rank
- player identity
- bot marker where applicable
- score/current wealth as appropriate

Highlight current human player.

Leaderboard pressure should remain visible without overwhelming trading.

--------------------------------------------------
MOBILE READABILITY GATE
--------------------------------------------------

Before declaring the UI done, verify that a new player can immediately answer:

1. How much Cash do I have?
2. How much Power do I have?
3. When does Power regenerate?
4. How long until apocalypse ends?
5. Which coins are dipping?
6. Which are rising/booming?
7. What do I currently own?
8. Am I making or losing money on each position?
9. How do I buy?
10. What will that buy cost in Power?
11. How do I sell?
12. Which positions are currently dangerous?
13. What is my leaderboard rank?

If these are unclear:

simplify before continuing.

==================================================
V2-6 — FINAL VERIFICATION
==================================================

Run the appropriate complete backend verification.

Run complete frontend verification.

Run:

- unit tests
- UI contract tests
- lint
- TypeScript
- builds
- schema verification where applicable
- migration tests
- race tests
- git diff --check

Run final large simulation batches against FINAL gameplay code.

The simulator must still use the same final domain logic as the actual game.

Re-run paired strategies.

Record final balance statistics.

--------------------------------------------------
FINAL REGRESSION CHECKS
--------------------------------------------------

Verify V2 has not broken:
- authentication
- £10,000 starting round cash unless intentionally retuned and documented
- automatic active-round participation
- ACTIVE → SETTLING → COMPLETED lifecycle
- real holdings
- transaction history
- settlement
- immutable results
- leaderboard
- round rollover
- dead coin £0 behaviour
- centralized frontend API
- stale/offline handling
- existing useful profile/history areas
- production isolation

Known original baseline failure may remain ONLY if it is demonstrably the exact same pre-existing failure and unrelated to V2.

Document it clearly.

==================================================
STOP CONDITIONS
==================================================

Ordinary bugs are NOT stop conditions.

Fix and continue.

K3 temporary quota exhaustion is NOT a stop condition.

WAIT and resume.

Simulation tuning failure is not initially a stop condition.

Tune and retry.

Stop autonomous feature expansion only for a GENUINE blocker such as:

1. The intended DIP-BOOM strategy cannot be made materially better than RANDOM without making the market trivially solvable.

2. Shared live/simulation market-domain architecture proves infeasible without a true destructive rewrite.

3. Continuing would require modifying production.

4. Repository state becomes unsafe and cannot be recovered from checkpoint/history.

5. Preserving existing important data/contracts becomes impossible without a major product decision.

If a genuine blocker occurs:

- stop feature expansion
- preserve current work
- commit coherent successful work
- push V2 branch
- update progress in detail
- explain exact blocker
- do not invent a new game design autonomously

==================================================
NO FEATURE CREEP
==================================================

Do NOT autonomously add:

- XP
- player levels
- quests
- loot boxes
- real money
- purchasable Power
- blockchain
- NFTs
- social systems
- clans
- crime mechanics
- court/tax systems
- LLM bots
- achievements
- new currencies
- unrelated economy systems

This overnight run is strictly about making the core trading game FUN, LEGIBLE and SKILL-BASED.

==================================================
DEFINITION OF OVERNIGHT DONE
==================================================

The overnight run is complete only when:

1. V2-1 cyclical market exists.
2. Live game and simulator use the same market-domain logic.
3. Paired simulation demonstrates meaningful trading skill.
4. V2-2 Power is persistent, exploit-resistant and balanced across multiple rounds.
5. Position limit works.
6. Cost basis/P&L is correct.
7. V2-3 apocalypse escalation is integrated.
8. Collapse risk creates meaningful late-game decisions.
9. Passive economy no longer overwhelms trading skill.
10. V2-4 bots use the new game legally.
11. Bot simulations are credible.
12. V2-5 mobile-first UI is implemented.
13. V2-6 final tests/builds/simulations are complete.
14. GAMEPLAY_V2_PROGRESS.md is fully updated.
15. All successful stages are committed.
16. gameplay-v2-20260824 is backed up remotely.
17. No merge occurred.
18. No production deployment occurred.

==================================================
MORNING REPORT
==================================================

When the run ends, leave a concise but evidence-rich morning report in GAMEPLAY_V2_PROGRESS.md containing:

- backend final SHA
- frontend final SHA
- stages completed
- stage stopped at if incomplete
- market archetype parameters
- final Power parameters
- final position limit
- apocalypse scaling parameters
- simulation sample size
- DIP-BOOM results
- RANDOM results
- late-seller results
- hold results
- spam results
- public-signal exploiter results
- perfect-information benchmark
- paired DIP-BOOM vs RANDOM win rate
- multi-round Power statistics
- bot performance/personality statistics
- backend test totals
- frontend test totals
- build/lint/type results
- remaining baseline failures
- unresolved V2 defects
- whether V2 reached the UI stage
- whether it is ready for HUMAN PLAY-TESTING

Do not merge.

Do not deploy.
Do not start another milestone.

End with the V2 branch ready for the user to inspect and play-test.
