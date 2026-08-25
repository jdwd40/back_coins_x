// Core 2: apocalypse-driven market volatility.
//
// Pure translation from authoritative Core 1 cycle progress (0..100) to a
// bounded volatility multiplier for the Coins market simulator. The market
// simulator resolves Core 1 state once per update batch and applies this
// factor to the volatility-sensitive movement amplitude; this module owns no
// timer, clock, database handle, or lifecycle.

// Default curve parameters. Early cycle keeps the pre-Core-2 market behavior
// exactly (factor 1.0); late cycle is materially more violent but stays modest
// enough that the existing per-update 0.5% change limit and 20%..500% price
// bounds remain the operative protections.
const DEFAULT_APOCALYPSE_MIN_FACTOR = 1.0;
const DEFAULT_APOCALYPSE_MAX_FACTOR = 3.0;
const DEFAULT_APOCALYPSE_CURVE_EXPONENT = 2;

// Hard safety cap: no configuration, however aggressive, may exceed this.
// With the simulator's per-update limit this cannot destabilise prices, but
// the cap keeps the amplitude itself in a sane, reviewable range.
const ABSOLUTE_MAX_APOCALYPSE_FACTOR = 10;

// Curve: factor(p) = min + (max - min) * (p / 100) ^ exponent.
// Smooth and monotonic across 0..100 with no threshold jumps. With the
// defaults the intuitive bands land as:
//   0-25   normal     ~1.00-1.13
//   25-50  increased  ~1.13-1.50
//   50-75  high       ~1.50-2.13
//   75-100 extreme    ~2.13-3.00

function failConfig(message) {
  throw new Error(`Invalid apocalypse volatility configuration: ${message}`);
}

function validateFactor(name, value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    failConfig(`${name} must be a number; received ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
  }
  if (!Number.isFinite(value)) {
    failConfig(`${name} must be finite; received ${String(value)}`);
  }
  return value;
}

// Strictly validate an optional config override. Absent fields take the
// defaults; present-but-invalid fields fail clearly rather than being coerced.
function resolveConfig(config) {
  if (config === undefined || config === null) {
    return {
      minFactor: DEFAULT_APOCALYPSE_MIN_FACTOR,
      maxFactor: DEFAULT_APOCALYPSE_MAX_FACTOR,
      exponent: DEFAULT_APOCALYPSE_CURVE_EXPONENT
    };
  }
  if (typeof config !== 'object' || Array.isArray(config)) {
    failConfig(`config must be an object; received ${Array.isArray(config) ? 'array' : typeof config}`);
  }

  const minFactor = config.minFactor === undefined
    ? DEFAULT_APOCALYPSE_MIN_FACTOR
    : validateFactor('minFactor', config.minFactor);
  const maxFactor = config.maxFactor === undefined
    ? DEFAULT_APOCALYPSE_MAX_FACTOR
    : validateFactor('maxFactor', config.maxFactor);
  const exponent = config.exponent === undefined
    ? DEFAULT_APOCALYPSE_CURVE_EXPONENT
    : validateFactor('exponent', config.exponent);

  if (minFactor <= 0) {
    failConfig(`minFactor must be positive; received ${minFactor}`);
  }
  if (maxFactor < minFactor) {
    failConfig(`maxFactor ${maxFactor} is below minFactor ${minFactor}`);
  }
  if (maxFactor > ABSOLUTE_MAX_APOCALYPSE_FACTOR) {
    failConfig(`maxFactor ${maxFactor} exceeds the absolute safety cap of ${ABSOLUTE_MAX_APOCALYPSE_FACTOR}`);
  }
  if (exponent <= 0) {
    failConfig(`exponent must be positive; received ${exponent}`);
  }

  return { minFactor, maxFactor, exponent };
}

// ---------------------------------------------------------------------------
// V2-3 escalation bands. The curve above is the SINGLE amplitude shared by
// the live market writer and the simulator (V2-1/V2-2 gates passed on it);
// the V2-3 simulation study measures band behaviour on this exact curve, so
// the curve itself is preserved unchanged. These bands are the centralized
// vocabulary the V2-3 report and tests use to talk about escalation phases
// — reporting only, no pricing effect.
//   0-40   NORMAL    relatively normal cyclical trading
//   40-70  ELEVATED  increased activity
//   70-90  HIGH      larger/faster opportunities (collapse window open)
//   90-100 EXTREME   extreme opportunity and danger
// ---------------------------------------------------------------------------
const ESCALATION_BANDS = Object.freeze([
  { id: 'NORMAL', minPercent: 0, maxPercent: 40 },
  { id: 'ELEVATED', minPercent: 40, maxPercent: 70 },
  { id: 'HIGH', minPercent: 70, maxPercent: 90 },
  { id: 'EXTREME', minPercent: 90, maxPercent: 100 }
]);
const ESCALATION_BAND_IDS = Object.freeze(ESCALATION_BANDS.map((b) => b.id));

// Translate cycle progress to a volatility multiplier.
//
// Progress policy:
//   * a finite number is clamped into 0..100 (never unsafe);
//   * malformed progress (NaN, Infinity, non-numeric, missing) is a SAFE
//     DEFAULT, resolving to the minimum factor — normal early-cycle market
//     behavior — so a corrupt reading can never produce NaN/Infinity prices
//     or amplified moves. Configuration errors, by contrast, throw.
function getApocalypseVolatility(progress, config) {
  const { minFactor, maxFactor, exponent } = resolveConfig(config);

  let p = 0; // malformed-progress safe default
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    p = Math.min(100, Math.max(0, progress));
  }

  const t = p / 100;
  return minFactor + (maxFactor - minFactor) * Math.pow(t, exponent);
}

// Map a progress percentage to its escalation band id. Malformed progress
// resolves to NORMAL, exactly like the amplitude curve's safe default.
function getEscalationBand(progress) {
  let p = 0;
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    p = Math.min(100, Math.max(0, progress));
  }
  for (const band of ESCALATION_BANDS) {
    if (p >= band.minPercent && (p < band.maxPercent || (band.maxPercent === 100 && p <= 100))) {
      return band.id;
    }
  }
  return 'EXTREME';
}

module.exports = {
  getApocalypseVolatility,
  getEscalationBand,
  ESCALATION_BANDS,
  ESCALATION_BAND_IDS,
  DEFAULT_APOCALYPSE_MIN_FACTOR,
  DEFAULT_APOCALYPSE_MAX_FACTOR,
  DEFAULT_APOCALYPSE_CURVE_EXPONENT,
  ABSOLUTE_MAX_APOCALYPSE_FACTOR
};
