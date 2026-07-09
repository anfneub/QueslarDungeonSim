import { FighterClasses } from "../characters/Fighter.js";
import { getMobStatValue } from "../characters/Mob.js";
import { calculateDefense, costOfLvl } from "../utils/utils.js";

// Closed-form sizing of fighter_damage / fighter_hit / fighter_crit.
//
// Mob stats are deterministic given a level, and each attack resolves to one
// of three outcomes (miss / hit / crit) with known probabilities, so the
// damage a fighter deals over R rounds is a sum of independent small random
// variables — well suited to a mean/variance (CLT) treatment instead of
// Monte Carlo. What does NOT reduce this way is survival: mobs attack the
// first living fighter in a fixed position order until it dies, then move to
// the next, with Sentinel redirects and Priest resurrects layered on top —
// a sequential, state-dependent process. So this module only sizes the
// offense (damage/hit/crit); health/defense/dodge stay with the simulation-
// based search in Optimizer.js.
//
// Known simplifications (all conservative — they underestimate a fighter's
// true damage output, so the search may spend a bit more gold than strictly
// necessary, but the final result is verified against a full simulation
// afterward):
//   - Crusader's per-dead-teammate attack bonus is not modeled (treated as if
//     no teammates have died yet).
//   - Berserker's health-ratio damage multiplier is not modeled (treated as
//     always at the 1.0x tier).
//   - Shadow Dancer's evade-then-double-damage proc is not modeled.
//   - Mage/Hunter's cleave is modeled as if enough mobs are always alive to
//     hit the full row/column; late in a fight, with few mobs left, some of
//     that is wasted overkill.

// Peter Acklam's rational approximation of the inverse standard normal CDF.
// Accurate to ~1e-4, which is far tighter than we need for gold-allocation.
function invNormalCDF(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;

  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p <= phigh) {
    const q = p - 0.5, r = q*q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  }
  const q = Math.sqrt(-2 * Math.log(1-p));
  return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}

// z such that P(Z >= z) = p, for a standard normal Z.
function invNormalUpperTail(p) {
  return invNormalCDF(1 - p);
}

export function mobDamageConstants(level) {
  const healthPerMob = getMobStatValue(100, 400, level);
  const dodge = getMobStatValue(0, 50, level);
  const defensePre = getMobStatValue(5, 10, level);
  const defenseMult = 1 - calculateDefense(defensePre); // fraction of raw damage that gets through
  return { healthTotal: healthPerMob * 6, dodge, defenseMult };
}

// { events: attacks made unconditionally every round, conditional: attacks
// that happen with some probability (e.g. Brawler's extra swing) }. Each
// entry's `mult` is the damage_mult passed to _do_standard_attack in Battle.js.
export function classAttackProfile(fighterClass) {
  switch (fighterClass) {
    case FighterClasses.MAGE:
      return { events: [{ mult: 0.5 }, { mult: 0.5 }, { mult: 0.5 }], conditional: [] };
    case FighterClasses.HUNTER:
      return { events: [{ mult: 0.75 }, { mult: 0.75 }], conditional: [] };
    case FighterClasses.BRAWLER:
      return { events: [{ mult: 1 }], conditional: [{ prob: 0.15, mult: 1 }] };
    default:
      return { events: [{ mult: 1 }], conditional: [] };
  }
}

// Sum of event mults (unconditional + expected conditional), scaled by any
// gear multistrike chance. Mean damage per round factors exactly as
// pHit(h) * defenseMult * kEff * D(d) * (1 + critChance*critDamage(c)) —
// this trilinear structure is what makes the closed-form solve possible.
function kEffective(profile, multistrikeChance) {
  let k = 0;
  for (const e of profile.events) k += e.mult;
  for (const ce of profile.conditional) k += ce.prob * ce.mult;
  return k * (1 + multistrikeChance);
}

function pHitOf(attackerHit, dodge) {
  return Math.min(0.25 + (attackerHit / (attackerHit + dodge)) * 0.75, 0.95);
}

// d(pHit)/d(fighter_hit), accounting for the 0.95 cap (zero marginal value
// once capped — investing further in hit is pure waste beyond that point).
function dpHitDLevel(h, objectHit, dodge) {
  const attackerHit = 50 + 50 * h + objectHit;
  if (pHitOf(attackerHit, dodge) >= 0.95 - 1e-9) return 0;
  return 50 * 0.75 * dodge / ((attackerHit + dodge) ** 2);
}

// Exact mean/variance of one fighter's total damage in a single round, given
// their attack profile and resolved (p, D, critChance, critDamage).
function fighterRoundMeanVar(profile, p, D, critChance, critDamage, defenseMult, multistrikeChance) {
  const evalEvent = (mult) => {
    const dmg = defenseMult * D * mult;
    const m = p * dmg * (1 + critChance * critDamage);
    const m2 = p * dmg * dmg * ((1 - critChance) + critChance * (1 + critDamage) * (1 + critDamage));
    return { m, v: m2 - m * m };
  };

  let mean = 0, variance = 0;
  for (const e of profile.events) {
    const { m, v } = evalEvent(e.mult);
    mean += m; variance += v;
  }
  for (const ce of profile.conditional) {
    const { m, v } = evalEvent(ce.mult);
    mean += ce.prob * m;
    variance += ce.prob * v + ce.prob * (1 - ce.prob) * m * m;
  }
  if (multistrikeChance > 0) {
    const baseMean = mean, baseVar = variance;
    mean = (1 + multistrikeChance) * baseMean;
    variance = (1 + multistrikeChance) * baseVar + multistrikeChance * (1 - multistrikeChance) * baseMean * baseMean;
  }
  return { mean, variance };
}

// Largest h >= 0 solving kEff*defenseMult*dpHitDLevel(h)*D*Cr = lambda*10000*h
// (the FOC for fighter_hit). Monotonic decreasing LHS-RHS, so bisection is safe.
function solveHitForLambda(fc, D, Cr, lambda, seed) {
  const f = (h) => fc.kEff * fc.defenseMult * dpHitDLevel(h, fc.objectHit, fc.dodge) * D * Cr - lambda * 10000 * h;
  if (f(0) <= 0) return 0;

  let hi = Math.max(1, (seed || 0) * 2, fc.dodge);
  for (let i = 0; i < 60 && f(hi) > 0; i++) hi *= 2;

  let lo = 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid; else hi = mid;
  }
  return lo;
}

// Gauss-Seidel solve of the 3-variable FOC system for one fighter at a given
// shadow price lambda (gold cost per unit of expected mean damage). Damage
// and crit each have a direct closed-form update given the other two
// variables; only hit needs a numeric root (due to the capped, nonlinear
// pHit formula), so this converges in a handful of sweeps.
//
// Deliberately always starts from (0,0,0) rather than warm-starting from a
// neighboring lambda's solution: warm-starting across the huge lambda jumps
// early in the outer bisection (which spans many orders of magnitude) left
// this under-converged at a stale fixed point, making the outer bisection's
// mean(lambda) samples non-monotonic and causing it to converge to the wrong
// value entirely (silently — no error, no NaN, just a plausible-looking wrong
// answer). Solving fresh each time is cheap (pure arithmetic, no simulation)
// so there's no real cost to always doing it right.
function solveFighterForLambda(fc, lambda) {
  let d = 0, h = 0, c = 0;

  for (let iter = 0; iter < 20; iter++) {
    const D = 100 + 25 * d + fc.objectDamage;
    const cd = (0.25 * c + fc.objectCrit) / 100;
    const Cr = 1 + fc.critChance * cd;

    h = solveHitForLambda(fc, D, Cr, lambda, h);

    const attackerHit = 50 + 50 * h + fc.objectHit;
    const p = pHitOf(attackerHit, fc.dodge);
    const P = p * fc.defenseMult * fc.kEff;

    d = Math.max(0, (P * 25 * Cr) / (lambda * 10000));
    const D2 = 100 + 25 * d + fc.objectDamage;

    c = Math.max(0, (P * D2 * fc.critChance * 0.0025) / (lambda * 10000));
  }

  const D = 100 + 25 * d + fc.objectDamage;
  const cd = (0.25 * c + fc.objectCrit) / 100;
  const attackerHit = 50 + 50 * h + fc.objectHit;
  const p = pHitOf(attackerHit, fc.dodge);
  const mean = p * fc.defenseMult * fc.kEff * D * (1 + fc.critChance * cd);

  return { d, h, c, mean };
}

function totalMeanForLambda(fighterConstantsList, lambda) {
  const solved = fighterConstantsList.map(fc => solveFighterForLambda(fc, lambda));
  return { total: solved.reduce((s, r) => s + r.mean, 0), solved };
}

// Cheapest per-fighter (d, h, c) whose combined mean round-damage hits
// targetMean, via bisection on a shared shadow price (water-filling: every
// (fighter, stat) pair ends up at the same marginal gold-per-mean-damage).
function solveForTargetMean(fighterConstantsList, targetMean) {
  let loLambda = 1e-9, hiLambda = 1;

  let { total } = totalMeanForLambda(fighterConstantsList, hiLambda);
  for (let i = 0; i < 100 && total > targetMean; i++) {
    hiLambda *= 10;
    ({ total } = totalMeanForLambda(fighterConstantsList, hiLambda));
  }
  ({ total } = totalMeanForLambda(fighterConstantsList, loLambda));
  for (let i = 0; i < 100 && total < targetMean; i++) {
    loLambda /= 10;
    ({ total } = totalMeanForLambda(fighterConstantsList, loLambda));
  }

  let solved = null;
  for (let i = 0; i < 60; i++) {
    const mid = Math.sqrt(loLambda * hiLambda);
    const res = totalMeanForLambda(fighterConstantsList, mid);
    solved = res.solved;
    if (res.total > targetMean) loLambda = mid; else hiLambda = mid;
  }
  return solved;
}

// Minimum-gold fighter_damage / fighter_hit / fighter_crit per fighter such
// that the squad has at least `killProbability` chance of dealing `rounds`
// rounds' worth of damage sufficient to clear all 6 mobs at `level`. Item
// bonuses reduce the required fighter_* levels directly (see fc.objectDamage
// etc. above) — if gear alone already covers what's needed, the returned
// level is 0, never negative.
export function solveDamageAllocation({ level, fightersInfo, rounds, killProbability = 0.05 }) {
  const { healthTotal, dodge, defenseMult } = mobDamageConstants(level);
  const z = invNormalUpperTail(killProbability);

  const fighterConstantsList = fightersInfo.map(fi => {
    const b = fi.itemBonuses || {};
    const profile = classAttackProfile(fi.class);
    const multistrikeChance = (b.object_multistrike || 0) / 100;
    return {
      key: `${fi.pos[0]}-${fi.pos[1]}`,
      dodge, defenseMult,
      objectDamage: b.object_damage || 0,
      objectHit: b.object_hit || 0,
      objectCrit: b.object_crit || 0,
      critChance: 0.1 + (b.object_crit_chance || 0) / 100,
      profile, multistrikeChance,
      kEff: kEffective(profile, multistrikeChance),
    };
  });

  let targetRoundMean = healthTotal / rounds;
  let solved = solveForTargetMean(fighterConstantsList, targetRoundMean);

  for (let iter = 0; iter < 8; iter++) {
    solved = solveForTargetMean(fighterConstantsList, targetRoundMean, solved);

    let roundVar = 0;
    for (let i = 0; i < fighterConstantsList.length; i++) {
      const fc = fighterConstantsList[i], s = solved[i];
      const D = 100 + 25 * s.d + fc.objectDamage;
      const cd = (0.25 * s.c + fc.objectCrit) / 100;
      const attackerHit = 50 + 50 * s.h + fc.objectHit;
      const p = pHitOf(attackerHit, fc.dodge);
      const { variance } = fighterRoundMeanVar(fc.profile, p, D, fc.critChance, cd, fc.defenseMult, fc.multistrikeChance);
      roundVar += variance;
    }

    const stdTotal = Math.sqrt(rounds * roundVar);
    const neededRoundMean = Math.max((healthTotal - z * stdTotal) / rounds, healthTotal / rounds * 0.001);
    if (Math.abs(neededRoundMean - targetRoundMean) < targetRoundMean * 0.005) break;
    targetRoundMean = neededRoundMean;
  }

  const perFighter = {};
  let totalCost = 0;
  for (let i = 0; i < fighterConstantsList.length; i++) {
    const fc = fighterConstantsList[i], s = solved[i];
    // Round up: guarantees the tail-probability constraint still holds after
    // quantizing to integer levels (rounding down could drop below target).
    const fighter_damage = Math.ceil(s.d - 1e-9);
    const fighter_hit = Math.ceil(s.h - 1e-9);
    const fighter_crit = Math.ceil(s.c - 1e-9);
    perFighter[fc.key] = { fighter_damage, fighter_hit, fighter_crit };
    totalCost += costOfLvl(fighter_damage) + costOfLvl(fighter_hit) + costOfLvl(fighter_crit);
  }

  return { perFighter, totalCost, rounds, killProbability };
}
