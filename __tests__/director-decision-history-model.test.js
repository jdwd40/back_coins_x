// Director Coin Events Wave 4: director decision history — model replay
// contract and atomic writer integration, against the REAL disposable test
// database (guard enforced; jest.setup.js reseeds before each test).
//
// Covered:
//   * summaryCodeForReason maps the adaptive Director's reason vocabulary
//     onto the public allowlist (unknown reasons -> OTHER_SAFE);
//   * append-only identity: fresh insert, identical retry no-op, divergent
//     same-identity loud failure, nothing ever updated/deleted;
//   * writer integration: the persistent market writer records EXACTLY the
//     genuine new committed decisions (genesis, later decisions, genuine
//     same-window role rotation) in the same batch transaction; retained
//     ticks write no history;
//   * rollback atomicity: control-state upsert + history append roll back
//     together — neither survives;
//   * latest-10 newest-first determinism.

const db = require('../db/connection');
const marketSimulator = require('../models/market-simulator');
const controlModel = require('../models/directorControlState.model');
const historyModel = require('../models/directorDecisionHistory.model');
const persistentWorld = require('../game/persistentWorld');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(120000);

const WORLD_SEED = 'wave4-director-decision-history-test';

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, {
    seed: WORLD_SEED,
    epochStartedAt: new Date(Date.now() - 60000)
  });
}

async function historyRows(worldId) {
  const { rows } = await db.query(
    `SELECT decision_index, mode, direction, intensity, summary_code
       FROM director_decision_history WHERE world_id = $1 ORDER BY decision_index`,
    [worldId]
  );
  return rows;
}

async function committedControl(worldId) {
  return controlModel.loadDirectorControlState(db, worldId);
}

describe('Wave 4: director decision history (real PG, disposable coins_test)', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await provisionedWorld();
  });

  test('summaryCodeForReason maps the decision reason vocabulary onto the public allowlist', () => {
    const { summaryCodeForReason } = historyModel;
    expect(summaryCodeForReason('genesis: normal open')).toBe('GENESIS_NORMAL');
    expect(summaryCodeForReason('normal swing window')).toBe('NORMAL_SWING');
    expect(summaryCodeForReason('refractory: ordinary rescue held to NORMAL; BOOM ended 3m ago (refractory 30m)')).toBe('REFRACTORY_NORMAL');
    expect(summaryCodeForReason('stagnation swing: no meaningful movement for 61m')).toBe('STAGNATION_SWING');
    expect(summaryCodeForReason('rescue: broad drawdown 30% >= 25%')).toBe('RESCUE_DISTRESS');
    expect(summaryCodeForReason('overheat correction: broad rise 9% with 8/10 coins rising')).toBe('OVERHEAT_CORRECTION');
    expect(summaryCodeForReason('role rotation: a Golden/Demon assignment expired or left the eligible set')).toBe('ROLE_ROTATION');
    expect(summaryCodeForReason('something entirely new')).toBe('OTHER_SAFE');
    expect(summaryCodeForReason('')).toBe('OTHER_SAFE');
    expect(summaryCodeForReason(null)).toBe('OTHER_SAFE');
  });

  test('writer genesis decision records exactly one history row; retained ticks record none', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    const t0 = Date.now();

    await marketSimulator.updateAllPrices({ nowMs: t0 });
    let rows = await historyRows(world.worldId);
    const control = await committedControl(world.worldId);
    expect(control).not.toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0].decision_index).toBe(control.decisionIndex);
    expect(rows[0].mode).toBe(control.mode);
    expect(rows[0].summary_code).toBe('GENESIS_NORMAL');

    // Retained ticks (in-window re-evaluations) write NO history.
    await marketSimulator.updateAllPrices({ nowMs: t0 + 30000 });
    await marketSimulator.updateAllPrices({ nowMs: t0 + 60000 });
    rows = await historyRows(world.worldId);
    expect(rows).toHaveLength(1);
    const controlAfter = await committedControl(world.worldId);
    expect(controlAfter.decisionIndex).toBe(control.decisionIndex);
  });

  test('a genuine new decision records exactly one more history row', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    const t0 = Date.now();
    await marketSimulator.updateAllPrices({ nowMs: t0 });
    const control = await committedControl(world.worldId);

    // A batch strictly after the committed window must advance the cursor.
    const afterWindowMs = new Date(control.endsAt).getTime() + 1000;
    await marketSimulator.updateAllPrices({ nowMs: afterWindowMs });

    const rows = await historyRows(world.worldId);
    const next = await committedControl(world.worldId);
    expect(next.decisionIndex).toBe(control.decisionIndex + 1);
    expect(rows).toHaveLength(2);
    expect(rows[1].decision_index).toBe(next.decisionIndex);
    expect(rows[1].mode).toBe(next.mode);
  });

  test('a genuine same-window role rotation records exactly one history row', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    const t0 = Date.now();
    await marketSimulator.updateAllPrices({ nowMs: t0 });
    const genesis = await committedControl(world.worldId);

    // Roles are assigned once a roster-observing decision commits (the
    // genesis evaluation runs before the first batch opens coin states).
    const decisionTwoMs = new Date(genesis.endsAt).getTime() + 1000;
    await marketSimulator.updateAllPrices({ nowMs: decisionTwoMs });
    const control = await committedControl(world.worldId);
    expect(control.decisionIndex).toBe(genesis.decisionIndex + 1);
    expect(control.goldenCoinId).not.toBeNull();

    // Expire the Golden assignment while the committed window still
    // stands: the next evaluation commits a same-window rotation decision.
    await db.query(
      `UPDATE director_control_state
          SET golden_expires_at = now() - interval '1 minute'
        WHERE world_id = $1`,
      [world.worldId]
    );
    await marketSimulator.updateAllPrices({ nowMs: decisionTwoMs + 5000 });

    const rows = await historyRows(world.worldId);
    const next = await committedControl(world.worldId);
    expect(next.decisionIndex).toBe(control.decisionIndex + 1);
    expect(rows).toHaveLength(3);
    expect(rows[2].decision_index).toBe(next.decisionIndex);
    expect(rows[2].summary_code).toBe('ROLE_ROTATION');
    // Same-window rotation: the committed window is preserved.
    const { rows: windowRows } = await db.query(
      `SELECT started_at, ends_at FROM director_decision_history
        WHERE world_id = $1 AND decision_index = $2`,
      [world.worldId, next.decisionIndex]
    );
    expect(new Date(windowRows[0].started_at).getTime()).toBe(new Date(control.startedAt).getTime());
    expect(new Date(windowRows[0].ends_at).getTime()).toBe(new Date(control.endsAt).getTime());

    // The rotated decision then retains: a further in-window batch writes
    // no more history.
    await marketSimulator.updateAllPrices({ nowMs: decisionTwoMs + 10000 });
    expect(await historyRows(world.worldId)).toHaveLength(3);
  });

  test('identical retry is a no-op; divergent payload at a committed identity fails loudly', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    const t0 = Date.now();
    await marketSimulator.updateAllPrices({ nowMs: t0 });
    const control = await committedControl(world.worldId);

    const entry = {
      worldId: world.worldId,
      decisionIndex: control.decisionIndex,
      mode: control.mode,
      direction: control.direction,
      intensity: control.intensity,
      startedAt: control.startedAt,
      endsAt: control.endsAt,
      summaryCode: 'GENESIS_NORMAL'
    };
    const retry = await historyModel.appendDirectorDecision(db, entry);
    expect(retry.inserted).toBe(false);
    expect(await historyRows(world.worldId)).toHaveLength(1);

    await expect(historyModel.appendDirectorDecision(db, { ...entry, intensity: 0.5 }))
      .rejects.toThrow(/identity conflict/);
    await expect(historyModel.appendDirectorDecision(db, { ...entry, summaryCode: 'OTHER_SAFE' }))
      .rejects.toThrow(/identity conflict/);
    expect(await historyRows(world.worldId)).toHaveLength(1);
  });

  test('rollback leaves control state and history consistent (neither survives)', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    const t0 = Date.now();
    await marketSimulator.updateAllPrices({ nowMs: t0 });
    const control = await committedControl(world.worldId);
    const before = await historyRows(world.worldId);

    const client = await db.getClient();
    const nextIndex = control.decisionIndex + 1;
    const nextDecision = {
      worldId: world.worldId,
      mode: 'NORMAL',
      direction: control.direction,
      intensity: 0,
      startedAt: new Date(t0 + 900000).toISOString(),
      endsAt: new Date(t0 + 1800000).toISOString(),
      decisionIndex: nextIndex,
      reason: 'normal swing window',
      goldenCoinId: control.goldenCoinId,
      goldenExpiresAt: control.goldenExpiresAt,
      demonCoinId: control.demonCoinId,
      demonExpiresAt: control.demonExpiresAt,
      lastSwingDirection: control.lastSwingDirection ?? null,
      lastMeaningfulMovementAt: control.lastMeaningfulMovementAt ?? null,
      lastInterventionEndedAt: control.lastInterventionEndedAt ?? null,
      lastInterventionMode: control.lastInterventionMode ?? null
    };
    try {
      await client.query('BEGIN');
      await controlModel.upsertDirectorControlState(client, nextDecision);
      await historyModel.appendDirectorDecision(client, {
        worldId: world.worldId,
        decisionIndex: nextIndex,
        mode: 'NORMAL',
        direction: control.direction,
        intensity: 0,
        startedAt: nextDecision.startedAt,
        endsAt: nextDecision.endsAt,
        summaryCode: 'NORMAL_SWING'
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const after = await committedControl(world.worldId);
    expect(after.decisionIndex).toBe(control.decisionIndex);
    expect(await historyRows(world.worldId)).toEqual(before);
  });

  test('latest decisions read back newest-first, bounded at 10, deterministic', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    const base = Date.now();
    for (let i = 0; i < 12; i += 1) {
      const started = new Date(base + i * 600000).toISOString();
      const result = await historyModel.appendDirectorDecision(db, {
        worldId: world.worldId,
        decisionIndex: i,
        mode: i % 2 === 0 ? 'NORMAL' : 'BOOM',
        direction: 'POSITIVE',
        intensity: i % 2 === 0 ? 0 : 0.5,
        startedAt: started,
        endsAt: new Date(base + i * 600000 + 300000).toISOString(),
        summaryCode: i % 2 === 0 ? 'NORMAL_SWING' : 'STAGNATION_SWING'
      });
      expect(result.inserted).toBe(true);
    }

    const latest = await historyModel.listLatestDirectorDecisions(db, world.worldId, { limit: 10 });
    expect(latest).toHaveLength(10);
    expect(latest.map((d) => d.decisionIndex)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    const again = await historyModel.listLatestDirectorDecisions(db, world.worldId, { limit: 10 });
    expect(again.map((d) => d.decisionIndex)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  });

  test('model validation rejects off-allowlist summary codes and bad shapes before SQL', async () => {
    const world = await persistentWorld.resolveActiveWorld(db);
    const base = Date.now();
    const valid = {
      worldId: world.worldId,
      decisionIndex: 0,
      mode: 'NORMAL',
      direction: 'POSITIVE',
      intensity: 0,
      startedAt: new Date(base).toISOString(),
      endsAt: new Date(base + 600000).toISOString(),
      summaryCode: 'GENESIS_NORMAL'
    };
    await expect(historyModel.appendDirectorDecision(db, { ...valid, summaryCode: 'rescue: raw reason text' }))
      .rejects.toThrow(/summaryCode must be one of/);
    await expect(historyModel.appendDirectorDecision(db, { ...valid, mode: 'CHAOS' }))
      .rejects.toThrow(/mode must be one of/);
    await expect(historyModel.appendDirectorDecision(db, { ...valid, intensity: 1.5 }))
      .rejects.toThrow(/intensity/);
    await expect(historyModel.appendDirectorDecision(db, { ...valid, endsAt: valid.startedAt }))
      .rejects.toThrow(/window/);
    expect(await historyRows(world.worldId)).toHaveLength(0);
  });
});
