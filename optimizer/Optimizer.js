import { Fighter, FighterClasses } from "../characters/Fighter.js";
import { FightersSquad } from "../squads/FightersSquad.js";
import { MobsSquad } from "../squads/MobsSquad.js";
import { Battle } from "../battle/Battle.js";
import { costOfLvl, millify } from "../utils/utils.js";
import { solveDamageAllocation } from "./DamageModel.js";
import { formatString } from "../utils/i18n.js";

// The formation is fixed: column 1 (y=0) is Shadow Dancer / Berserker /
// Paladin top-to-bottom, column 2 (y=1) is Bastion, then Crusader/Priest in
// either order at row 2 / row 3 (see SWAPPABLE_GROUPS below — neither class
// has any position-dependent mechanic, so either arrangement is valid). The
// optimizer assumes this exact layout otherwise (it's load-bearing for the
// analytical damage model's class-specific assumptions) — if the grid
// doesn't match, refuse to compute rather than silently optimizing the wrong
// thing.
const REQUIRED_LAYOUT = {
    '0-0': FighterClasses.SHADOW_DANCER,
    '1-0': FighterClasses.BERSERKER,
    '2-0': FighterClasses.PALADIN,
    '0-1': FighterClasses.BASTION,
    '1-1': FighterClasses.CRUSADER,
    '2-1': FighterClasses.PRIEST,
};
// Groups of positions whose REQUIRED_LAYOUT classes may be swapped with each
// other and still be considered a valid layout — e.g. row 2/row 3 of column
// 2 (keys '1-1'/'2-1') may hold Crusader/Priest in either order. Every key
// in a group must appear together; a group is only ever checked as a whole
// (see _checkLayout).
const SWAPPABLE_GROUPS = [
    ['1-1', '2-1'],
];

// Win rate target when no budget is given (minimize cost to achieve this).
const DESCENT_TARGET = 0.80;
// Simulations per check while hill-climbing. Only used to rank candidate moves,
// so it doesn't need to be huge — a bad pick just wastes a little gold, it can
// never make the reported result wrong (see FINAL_SIMS below).
const ASCENT_SIMS = 100;
// Simulations for the final win-rate report (accurate).
const FINAL_SIMS = 500;
// Simulations for the final report when the result is close to the floor,
// where FINAL_SIMS alone is too noisy to trust (expected wins ~30 at the
// floor, scaled so this stays reliable as UNSTABLE_THRESHOLD changes).
const FINAL_SIMS_PRECISE = 30000;
// Win rates below this are flagged as unstable / a failure. 0.1%, not 1% —
// callers should still prefer the highest win rate they can afford; this is
// only the floor for "valid at all."
const UNSTABLE_THRESHOLD = 0.001;
// Coarse-to-fine level increments used while hill-climbing a stat.
const STEP_TIERS = [1000, 300, 100, 30, 10, 3, 1];
// Safety cap on hill-climb iterations so a pathological case can't hang forever.
const MAX_ASCEND_ITERS = 600;

const OPTIMIZABLE_STATS = [
    'fighter_health', 'fighter_damage', 'fighter_hit',
    'fighter_defense', 'fighter_crit', 'fighter_dodge',
];
// Order stats are listed in when displaying a build — purely cosmetic, has
// no effect on search/allocation (which iterate OPTIMIZABLE_STATS above).
const DISPLAY_STAT_ORDER = [
    'fighter_health', 'fighter_damage', 'fighter_hit',
    'fighter_dodge', 'fighter_defense', 'fighter_crit',
];
// Stats the analytical DamageModel sizes directly — excluded from the
// survival-only sub-search below so the two don't fight over the same knobs.
const SURVIVAL_STATS = ['fighter_health', 'fighter_defense', 'fighter_dodge'];
const DAMAGE_STATS = ['fighter_damage', 'fighter_hit', 'fighter_crit'];

// Candidate round-counts swept when building the analytical seed (see
// _buildAnalyticalSeed). Geometric spacing since cost trades off against
// rounds roughly log-linearly; final polish corrects any gap between grid
// points. Kept short — each point runs a full simulation-backed survival
// search, so this is the expensive part of the seed.
const SEED_ROUND_CANDIDATES = [16, 32, 64, 80, 96];
// Reduced sims/iters for the seed's survival sub-search — it only needs to be
// a good starting point, not the final answer (the full _ascend polish pass
// re-verifies and corrects everything against real simulated win rate).
const SEED_SURVIVAL_SIMS = 50;
const SEED_SURVIVAL_MAX_ITERS = 80;
const SEED_SURVIVAL_TARGET = 0.9;
// Skip the analytical seed sweep entirely when the real-stats seed already
// wins at least this often — the sweep is expensive and rarely helps once
// there's a decent real build to refine instead.
const REAL_SEED_SKIP_THRESHOLD = 0.3;
// Sample size for the final real-vs-analytical seed decision, once both are
// close enough (or both zero) that ASCENT_SIMS can't distinguish them.
const SEED_COMPARISON_SIMS = 500;
// Kill-probability target handed to the analytical damage solver. This is a
// per-round-count target for "did we deal enough damage," not the overall
// win-rate floor — the combination with survival odds is what the final
// simulated win rate reflects.
const SEED_KILL_PROBABILITY = 0.5;

// fightersInfo: Array of { pos: [x, y], class: FighterClass, itemBonuses: { object_health, … }, currentStats?: { fighter_health, … } }
export class Optimizer {
    // onSeedProgress(done, total): optional callback invoked as the analytical
    // seed sweeps SEED_ROUND_CANDIDATES (see _buildAnalyticalSeed). Only fires
    // on the budget path, and only when that sweep actually runs (skipped
    // when the real-stats seed is already decent — see
    // REAL_SEED_SKIP_THRESHOLD) — callers should treat "never called" the
    // same as "nothing to show progress for."
    async optimize(level, fightersInfo, budget = Infinity, onSeedProgress = null) {
        if (!fightersInfo || fightersInfo.length === 0) {
            return { text: window.i18nManager.getOptimizerMsg("NO_FIGHTERS"), build: null };
        }

        const layoutError = this._checkLayout(fightersInfo);
        if (layoutError) {
            return { text: layoutError, build: null };
        }

        if (budget < Infinity) {
            return this._optimizeWithBudget(level, fightersInfo, budget, onSeedProgress);
        } else {
            return this._optimizeNoBudget(level, fightersInfo);
        }
    }

    // ── No-budget path: hill-climb until we clear DESCENT_TARGET ──────────────

    async _optimizeNoBudget(level, fightersInfo) {
        const build = this._initBuild(fightersInfo);
        const measureWin = (b, sims) => this._simulate(level, b, fightersInfo, sims);
        await this._ascend(measureWin, build, fightersInfo, {
            targetWR: DESCENT_TARGET,
            sims: ASCENT_SIMS,
            maxIters: MAX_ASCEND_ITERS * 4, // no budget wall to stop us early, allow more room to climb
        });

        const finalWR = await this._simulate(level, build, fightersInfo, FINAL_SIMS);
        if (finalWR < DESCENT_TARGET * 0.5) return this._fail(level);

        return this._formatResults(build, fightersInfo, level, finalWR, Infinity);
    }

    // ── Budget path: maximize win rate within budget, starting from what's real ─

    async _optimizeWithBudget(level, fightersInfo, budget, onSeedProgress = null) {
        const measureWin = (b, sims) => this._simulate(level, b, fightersInfo, sims);

        // Candidate seed 1: the fighters' actual invested stats (if given), so
        // we never do worse than what the user already has — that build is
        // real, known-good, and already inside the budget it was measured
        // against.
        const realSeed = this._fitToBudget(this._initBuild(fightersInfo), budget);
        const realSeedCost = this._totalCost(realSeed);
        const realSeedWR = await this._simulate(level, realSeed, fightersInfo, ASCENT_SIMS);

        // Candidate seed 2: analytically size damage/hit/crit for a chosen
        // kill-within-R-rounds target (closed-form, see DamageModel.js), paired
        // with a simulation-searched survive-R-rounds allocation for the
        // remaining budget. This matters most when there's no real investment
        // to start from — hill-climbing from zero can plateau (see
        // _breakthroughPhase) long before finding a good joint allocation,
        // while this seed starts already in the right neighborhood. Skip it
        // when the real-stats seed is already decent: the sweep is the
        // expensive part of optimize() (several simulation-backed searches),
        // and it rarely beats a build that's already winning a third of the
        // time.
        let build = realSeed;
        if (realSeedWR < REAL_SEED_SKIP_THRESHOLD) {
            const analytical = await this._buildAnalyticalSeed(level, fightersInfo, budget, onSeedProgress);
            if (analytical) {
                if (realSeedCost === 0) {
                    // All-zero stats can never win, by construction — no need to
                    // "beat" it in a noisy sample. Any real allocation of the
                    // same budget is categorically at least as good a starting
                    // point, so just take it.
                    build = analytical.build;
                } else {
                    // Both quick estimates used only ASCENT_SIMS samples, which
                    // is blind exactly in the 1-5% range this decision usually
                    // matters at (e.g. both reading 0 wins purely by chance —
                    // see DamageModel.js's kill-probability discussion for why
                    // low rates need much larger samples to resolve). Re-check
                    // with a much bigger sample before picking a winner instead
                    // of trusting the noisy one.
                    const preciseReal = await this._simulate(level, realSeed, fightersInfo, SEED_COMPARISON_SIMS);
                    const preciseAnalytical = await this._simulate(level, analytical.build, fightersInfo, SEED_COMPARISON_SIMS);
                    if (preciseAnalytical >= preciseReal) build = analytical.build;
                }
            }
        } else if (onSeedProgress) {
            // Sweep skipped entirely — signal "done" so a progress bar
            // doesn't sit frozen at 0% for the rest of the call.
            onSeedProgress(SEED_ROUND_CANDIDATES.length, SEED_ROUND_CANDIDATES.length);
        }

        await this._ascend(measureWin, build, fightersInfo, {
            budget,
            sims: ASCENT_SIMS,
            maxIters: MAX_ASCEND_ITERS,
        });

        let finalWR = await this._simulate(level, build, fightersInfo, FINAL_SIMS);
        // Near the floor, FINAL_SIMS is too noisy to trust (expected wins ~2
        // at UNSTABLE_THRESHOLD). Re-check with a much larger sample before
        // deciding pass/fail.
        if (finalWR < UNSTABLE_THRESHOLD * 4) {
            finalWR = await this._simulate(level, build, fightersInfo, FINAL_SIMS_PRECISE);
        }

        if (finalWR < UNSTABLE_THRESHOLD) {
            const floorPct = (UNSTABLE_THRESHOLD * 100).toString();
            return {
                text: formatString(window.i18nManager.getOptimizerMsg("BUDGET_INSUFFICIENT"), millify(budget), floorPct, level),
                build: null,
            };
        }

        return this._formatResults(build, fightersInfo, level, finalWR, budget);
    }

    // ── Core hill-climb ─────────────────────────────────────────────────────────

    // Greedily applies whichever affordable stat increment yields the best
    // win-rate gain per gold spent, coarse-to-fine. Monotonic: cost only ever
    // goes up, and every accepted move is budget-checked before being applied,
    // so the result can never exceed `budget` and never regresses below the
    // starting build's win rate (up to simulation noise on individual picks).
    //
    // Candidates include single (fighter, stat) bumps for fine control, but
    // also squad-wide bumps (same stat across every fighter, or every stat for
    // one fighter, or every stat for everyone). Single-variable bumps alone get
    // stuck on a flat plateau when starting from a weak/zero build: nudging one
    // stat on one fighter changes nothing measurable while the other five still
    // die instantly, so every candidate looks equally useless. The coarse joint
    // moves give the climb a way to make simultaneous progress across fighters.
    async _ascend(measureFn, build, fightersInfo, { budget = Infinity, targetWR = null, sims, maxIters = MAX_ASCEND_ITERS, statSet = OPTIMIZABLE_STATS }) {
        let iters = 0;

        // Breakthrough phase: some class combos only pay off once a coalition
        // of a few fighters crosses a joint survivability/damage threshold
        // together (see _breakthroughPhase). Fixed step sizes below can
        // easily straddle that threshold — landing short every time — so this
        // runs first, sized directly off whatever budget is actually left.
        if (budget < Infinity) {
            iters = await this._breakthroughPhase(measureFn, build, fightersInfo, budget, targetWR, sims, iters, maxIters, statSet);
        }

        for (const step of STEP_TIERS) {
            let improved = true;
            while (improved && iters < maxIters) {
                improved = false;

                const baseWR = await measureFn(build, sims);
                if (targetWR !== null && baseWR >= targetWR) return baseWR;

                const baseCost = this._totalCost(build);
                const candidates = this._candidateMoves(build, fightersInfo, step, statSet);
                let best = null;

                for (const changes of candidates) {
                    const marginalCost = this._applyChanges(build, changes);
                    if (baseCost + marginalCost > budget) { this._revertChanges(build, changes); continue; }

                    const newWR = await measureFn(build, sims);
                    this._revertChanges(build, changes);

                    if (newWR <= baseWR) continue;
                    const roi = (newWR - baseWR) / marginalCost;
                    if (!best || roi > best.roi) {
                        best = { changes, roi };
                    }
                }

                if (best) {
                    this._applyChanges(build, best.changes);
                    improved = true;
                }
                iters++;
            }
        }

        return await measureFn(build, sims);
    }

    // Tries committing a large fraction of the remaining budget directly to a
    // small coalition of fighters (every stat, spread evenly across 1, 2, or 3
    // of them, or the whole squad), sized to whatever budget is actually left
    // rather than a fixed increment. This is what lets the search find, e.g.,
    // "these two fighters together" as a viable allocation even when neither
    // investing in one alone, nor a fixed step size, ever shows improvement on
    // its own — the fixed-step ascent below only refines from here.
    async _breakthroughPhase(measureFn, build, fightersInfo, budget, targetWR, sims, iters, maxIters, statSet) {
        const keys = fightersInfo.map(fi => this._key(fi.pos));
        const coalitions = [
            ...this._combinations(keys, 1),
            ...this._combinations(keys, 2),
            ...this._combinations(keys, 3),
            keys,
        ];
        const fractions = [1.0, 0.5, 0.25];

        let improved = true;
        while (improved && iters < maxIters) {
            improved = false;

            const baseWR = await measureFn(build, sims);
            if (targetWR !== null && baseWR >= targetWR) return iters;

            const baseCost = this._totalCost(build);
            const remaining = budget - baseCost;
            let best = null;

            for (const subset of coalitions) {
                for (const frac of fractions) {
                    const delta = this._maxUniformBump(build, subset, remaining * frac, statSet);
                    if (delta <= 0) continue;

                    const changes = subset.flatMap(key => statSet.map(stat => ({
                        key, stat, prevVal: build[key][stat], newVal: build[key][stat] + delta,
                    })));
                    const marginalCost = this._applyChanges(build, changes);
                    const newWR = await measureFn(build, sims);
                    this._revertChanges(build, changes);

                    if (newWR <= baseWR) continue;
                    const roi = (newWR - baseWR) / marginalCost;
                    if (!best || roi > best.roi) best = { changes, roi };
                }
            }

            if (best) {
                this._applyChanges(build, best.changes);
                improved = true;
            }
            iters++;
        }
        return iters;
    }

    // Largest integer delta such that adding it to every stat in `statSet` of
    // every fighter in `keys` costs no more than `budgetCap`. Pure cost math,
    // no simulation.
    _maxUniformBump(build, keys, budgetCap, statSet = OPTIMIZABLE_STATS) {
        if (budgetCap <= 0) return 0;
        const costFor = (delta) => {
            let c = 0;
            for (const key of keys) {
                for (const stat of statSet) {
                    const cur = build[key][stat];
                    c += costOfLvl(cur + delta) - costOfLvl(cur);
                }
            }
            return c;
        };
        if (costFor(1) > budgetCap) return 0;

        let hi = 1;
        while (costFor(hi) <= budgetCap) hi *= 2;
        let lo = Math.floor(hi / 2);
        while (lo < hi - 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (costFor(mid) <= budgetCap) lo = mid; else hi = mid;
        }
        return lo;
    }

    // Builds the list of candidate moves to try at a given step size: fine
    // single (fighter, stat) bumps, squad-wide single-stat bumps, per-fighter
    // all-stat bumps, small-coalition all-stat bumps, and one fully uniform
    // bump across everyone.
    //
    // The coalition moves (all stats, for every 2- or 3-fighter subset) matter
    // more than they look: some classes only pay off as a pair (e.g. one
    // fighter that scales up defensively as teammates die, paired with one
    // that can solo-tank hits) — investing in either alone can sit at 0% win
    // rate long after investing in both together would cross the threshold.
    // Per-fighter and all-fighter bumps can't express "these two, together,"
    // so without this the search gets stuck never discovering that a cheaper
    // duo/trio carry exists at all.
    _candidateMoves(build, fightersInfo, step, statSet = OPTIMIZABLE_STATS) {
        const keys = fightersInfo.map(fi => this._key(fi.pos));
        const bump = (key, stat) => ({ key, stat, prevVal: build[key][stat], newVal: build[key][stat] + step });
        const bumpAllStats = (subsetKeys) => subsetKeys.flatMap(key => statSet.map(stat => bump(key, stat)));
        const candidates = [];

        for (const key of keys) {
            for (const stat of statSet) {
                candidates.push([bump(key, stat)]);
            }
        }

        for (const stat of statSet) {
            candidates.push(keys.map(key => bump(key, stat)));
        }

        for (const key of keys) {
            candidates.push(bumpAllStats([key]));
        }

        for (const subset of this._combinations(keys, 2)) candidates.push(bumpAllStats(subset));
        for (const subset of this._combinations(keys, 3)) candidates.push(bumpAllStats(subset));

        candidates.push(bumpAllStats(keys));

        return candidates;
    }

    _combinations(items, size) {
        if (size > items.length) return [];
        const results = [];
        const pick = (start, chosen) => {
            if (chosen.length === size) { results.push(chosen.slice()); return; }
            for (let i = start; i < items.length; i++) {
                chosen.push(items[i]);
                pick(i + 1, chosen);
                chosen.pop();
            }
        };
        pick(0, []);
        return results;
    }

    _applyChanges(build, changes) {
        let marginalCost = 0;
        for (const { key, stat, newVal } of changes) {
            marginalCost += costOfLvl(newVal) - costOfLvl(build[key][stat]);
            build[key][stat] = newVal;
        }
        return marginalCost;
    }

    _revertChanges(build, changes) {
        for (const { key, stat, prevVal } of changes) {
            build[key][stat] = prevVal;
        }
    }

    // Scales a build down uniformly (by level) until it fits the budget.
    // Pure cost math, no simulation — used only when the starting build (e.g.
    // the fighters' real current stats) already exceeds the given budget.
    _fitToBudget(build, budget) {
        if (this._totalCost(build) <= budget) return build;

        const original = this._cloneBuild(build);
        const scaled = (s) => {
            const b = {};
            for (const key in original) {
                b[key] = {};
                for (const stat of OPTIMIZABLE_STATS) {
                    b[key][stat] = Math.floor((original[key][stat] || 0) * s);
                }
            }
            return b;
        };

        let lo = 0, hi = 1;
        for (let i = 0; i < 30; i++) {
            const mid = (lo + hi) / 2;
            if (this._totalCost(scaled(mid)) <= budget) lo = mid; else hi = mid;
        }
        return scaled(lo);
    }

    async _simulate(level, build, fightersInfo, numSims) {
        let wins = 0;
        for (let i = 0; i < numSims; i++) {
            const squad  = this._buildSquad(build, fightersInfo);
            const mobs   = new MobsSquad(level);
            const battle = new Battle(squad, mobs, 0);
            const [winner] = battle.battle();
            if (winner === "fighters") wins++;
            // Yield to the browser every 20 battles to keep the UI responsive.
            if (i % 20 === 19) await new Promise(r => setTimeout(r, 0));
        }
        return wins / numSims;
    }

    // Fraction of sims where every fighter is still alive after `rounds`
    // rounds — used only to size health/defense/dodge for the analytical
    // seed (see _buildAnalyticalSeed), decoupled from whether mobs are dead
    // yet. Steps the battle manually via the round-logic method directly
    // rather than Battle.battle(), which runs to a win/loss conclusion.
    async _survives(level, build, fightersInfo, rounds, numSims) {
        let survived = 0;
        for (let i = 0; i < numSims; i++) {
            const squad  = this._buildSquad(build, fightersInfo);
            const mobs   = new MobsSquad(level);
            const battle = new Battle(squad, mobs, 0);

            let ok = true;
            for (let r = 0; r < rounds; r++) {
                battle._do_one_round();
                if (squad.fighters.some(f => f.current_health <= 0)) { ok = false; break; }
            }
            if (ok) survived++;
            if (i % 20 === 19) await new Promise(res => setTimeout(res, 0));
        }
        return survived / numSims;
    }

    // Evaluates one SEED_ROUND_CANDIDATES entry: analytically size damage/hit/
    // crit for killing within `rounds` (DamageModel.js), then simulation-
    // search health/defense/dodge for surviving those same `rounds`. Returns
    // { build, quickWR, rounds } or null if the damage cost alone already
    // exceeds budget (leaving nothing for survival).
    //
    // The survival sub-search measures against a build that already has the
    // analytically-solved damage/hit/crit plugged in (not zero damage) — mobs
    // need to actually be dying at a realistic rate during those R rounds, or
    // "survive R full rounds of unmitigated 6-mob aggression" becomes an
    // unrealistically brutal, near-unaffordable bar for any but the smallest
    // R, and the search finds no viable investment at all and gives up at
    // zero health/defense/dodge. The final _ascend polish pass in
    // _optimizeWithBudget re-verifies the combined build against real
    // simulated win rate regardless, so any remaining gap gets corrected.
    async _evaluateRoundCandidate(level, fightersInfo, budget, rounds) {
        const damage = solveDamageAllocation({ level, fightersInfo, rounds, killProbability: SEED_KILL_PROBABILITY });
        if (damage.totalCost >= budget) return null;

        const survivalBuild = {};
        for (const fi of fightersInfo) {
            survivalBuild[this._key(fi.pos)] = Object.fromEntries(SURVIVAL_STATS.map(s => [s, 0]));
        }

        const measureSurvive = (b, sims) =>
            this._survives(level, this._mergeSeedBuilds(b, damage.perFighter, fightersInfo), fightersInfo, rounds, sims);
        await this._ascend(measureSurvive, survivalBuild, fightersInfo, {
            budget: budget - damage.totalCost,
            targetWR: SEED_SURVIVAL_TARGET,
            sims: SEED_SURVIVAL_SIMS,
            maxIters: SEED_SURVIVAL_MAX_ITERS,
            statSet: SURVIVAL_STATS,
        });

        const combined = this._mergeSeedBuilds(survivalBuild, damage.perFighter, fightersInfo);
        const quickWR = await this._simulate(level, combined, fightersInfo, ASCENT_SIMS);

        return { build: combined, quickWR, rounds };
    }

    // Picks the best round-count via a discrete ternary search over
    // SEED_ROUND_CANDIDATES instead of evaluating every entry. This assumes
    // quality-vs-rounds is unimodal for a fixed budget: too few rounds forces
    // overinvesting in damage and starves survival, too many forces the
    // opposite, and there's a sweet spot in between (SEED_ROUND_CANDIDATES is
    // shaped for this — 64 is the literal midpoint, 32/80 are the midpoints
    // of each half). Each iteration evaluates the two points a third of the
    // way in from either end and discards whichever end scored worse,
    // narrowing the range until at most 3 candidates remain to check
    // exhaustively — a fixed, bounded number of evaluations (4 of 5 for the
    // current candidate list) instead of all of them.
    async _buildAnalyticalSeed(level, fightersInfo, budget, onSeedProgress = null) {
        const n = SEED_ROUND_CANDIDATES.length;
        const cache = new Map(); // index -> result-or-null, so a re-visited index isn't recomputed
        let evalCount = 0;

        const evaluate = async (idx) => {
            if (cache.has(idx)) return cache.get(idx);
            const result = await this._evaluateRoundCandidate(level, fightersInfo, budget, SEED_ROUND_CANDIDATES[idx]);
            cache.set(idx, result);
            evalCount++;
            if (onSeedProgress) onSeedProgress(evalCount, n);
            return result;
        };
        const scoreOf = (result) => result ? result.quickWR : -1; // infeasible ranks worst, never wins a comparison

        let lo = 0, hi = n - 1;
        while (hi - lo > 2) {
            const m1 = lo + Math.floor((hi - lo) / 3);
            const m2 = hi - Math.floor((hi - lo) / 3);
            const r1 = await evaluate(m1);
            const r2 = await evaluate(m2);
            if (scoreOf(r1) < scoreOf(r2)) lo = m1 + 1; else hi = m2 - 1;
        }

        let best = null;
        for (let i = lo; i <= hi; i++) {
            const result = await evaluate(i);
            if (result && (!best || result.quickWR > best.quickWR)) best = result;
        }

        // Guarantee completion even though fewer than n evaluations may have run.
        if (onSeedProgress) onSeedProgress(n, n);
        return best;
    }

    _mergeSeedBuilds(survivalBuild, damagePerFighter, fightersInfo) {
        const build = {};
        for (const fi of fightersInfo) {
            const key = this._key(fi.pos);
            build[key] = {
                ...Object.fromEntries(OPTIMIZABLE_STATS.map(s => [s, 0])),
                ...survivalBuild[key],
                ...damagePerFighter[key],
            };
        }
        return build;
    }

    // ── Build helpers ──────────────────────────────────────────────────────────

    // Starts each fighter from their real invested stats when known (the
    // budget-constrained path always has these); otherwise starts from zero
    // and lets _ascend discover the right allocation for this class/level/gear
    // combination through simulation, rather than a generic formula guess.
    _initBuild(fightersInfo) {
        const build = {};
        for (const fi of fightersInfo) {
            const key = this._key(fi.pos);
            const cs  = fi.currentStats;
            build[key] = {};
            for (const stat of OPTIMIZABLE_STATS) {
                build[key][stat] = cs ? Math.max(0, Math.round(cs[stat] || 0)) : 0;
            }
        }
        return build;
    }

    _buildSquad(build, fightersInfo) {
        const grid = Array.from({ length: 3 }, () => [null, null]);
        for (const fi of fightersInfo) {
            const [x, y] = fi.pos;
            const stats  = build[this._key(fi.pos)];
            const bonuses = fi.itemBonuses || {};
            grid[x][y]   = new Fighter(fi.class, { ...stats, ...bonuses });
        }
        return new FightersSquad(
            grid[0][0], grid[1][0], grid[2][0],
            grid[0][1], grid[1][1], grid[2][1],
        );
    }

    _key(pos)   { return `${pos[0]}-${pos[1]}`; }

    // Returns an error string if fightersInfo doesn't match REQUIRED_LAYOUT
    // (right count, right positions, right class per position) — except
    // positions inside a SWAPPABLE_GROUPS group, which are checked as a set
    // rather than position-by-position, so any permutation within the group
    // is accepted. Returns null (no error) if it matches.
    _checkLayout(fightersInfo) {
        const requiredKeys = Object.keys(REQUIRED_LAYOUT);

        if (fightersInfo.length !== requiredKeys.length) {
            return formatString(window.i18nManager.getOptimizerMsg("LAYOUT_COUNT_MISMATCH"), requiredKeys.length, fightersInfo.length);
        }

        const seen = new Map();
        for (const fi of fightersInfo) {
            seen.set(this._key(fi.pos), fi.class);
        }

        const swappableKeys = new Set(SWAPPABLE_GROUPS.flat());

        for (const key of requiredKeys) {
            if (swappableKeys.has(key)) continue; // checked per-group below

            const expected = REQUIRED_LAYOUT[key];
            const actual = seen.get(key);
            const [x, y] = key.split('-');
            if (actual === undefined) {
                return formatString(window.i18nManager.getOptimizerMsg("LAYOUT_SLOT_EMPTY"), expected, x, y);
            }
            if (actual !== expected) {
                return formatString(window.i18nManager.getOptimizerMsg("LAYOUT_SLOT_MISMATCH"), expected, x, y, actual);
            }
        }

        for (const group of SWAPPABLE_GROUPS) {
            const expectedClasses = group.map(key => REQUIRED_LAYOUT[key]);
            const expectedLabel = expectedClasses.join('/');

            for (const key of group) {
                const actual = seen.get(key);
                const [x, y] = key.split('-');
                if (actual === undefined) {
                    return formatString(window.i18nManager.getOptimizerMsg("LAYOUT_SLOT_EMPTY"), expectedLabel, x, y);
                }
                if (!expectedClasses.includes(actual)) {
                    return formatString(window.i18nManager.getOptimizerMsg("LAYOUT_SLOT_MISMATCH"), expectedLabel, x, y, actual);
                }
            }

            const actualClasses = group.map(key => seen.get(key));
            if (new Set(actualClasses).size !== new Set(expectedClasses).size) {
                // Both slots got the same class instead of one of each.
                const [x, y] = group[0].split('-');
                return formatString(window.i18nManager.getOptimizerMsg("LAYOUT_SLOT_MISMATCH"), expectedLabel, x, y, actualClasses[0]);
            }
        }

        return null;
    }

    _cloneBuild(build) {
        const clone = {};
        for (const key in build) clone[key] = { ...build[key] };
        return clone;
    }

    _totalCost(build) {
        let total = 0;
        for (const key in build) {
            const s = build[key];
            for (const stat of OPTIMIZABLE_STATS) total += costOfLvl(s[stat] || 0);
        }
        return total;
    }

    _fail(level) {
        return {
            text: formatString(window.i18nManager.getOptimizerMsg("BUILD_NOT_FOUND"), level),
            build: null,
        };
    }

    // ── Output ─────────────────────────────────────────────────────────────────

    _formatResults(build, fightersInfo, level, winRate, budget = Infinity) {
        // Two decimals: with UNSTABLE_THRESHOLD at 0.1%, one decimal place
        // can't distinguish a passing build from a failing one near the floor.
        const pct = (winRate * 100).toFixed(2);
        const I18N = window.i18nManager;
        let text = formatString(I18N.getOptimizerMsg("RESULTS_HEADER"), level) + '\n';

        if (winRate === 0) {
            text += formatString(I18N.getOptimizerMsg("WIN_RATE_FAILED"), pct) + '\n';
        } else if (winRate < UNSTABLE_THRESHOLD) {
            text += formatString(I18N.getOptimizerMsg("WIN_RATE_UNSTABLE"), pct) + '\n';
        } else {
            text += formatString(I18N.getOptimizerMsg("WIN_RATE"), pct) + '\n';
        }

        const totalCost = this._totalCost(build);
        if (budget < Infinity) {
            const remaining = budget - totalCost;
            text += formatString(I18N.getOptimizerMsg("TOTAL_COST_WITH_BUDGET"), millify(totalCost), millify(remaining), millify(budget)) + '\n\n';
        } else {
            text += formatString(I18N.getOptimizerMsg("TOTAL_COST"), millify(totalCost)) + '\n\n';
        }

        const orderedFightersInfo = this._orderedForDisplay(fightersInfo);

        // Print as a 3x2 grid — column 1 (SD/Berserker/Paladin) on the left,
        // column 2 (Bastion/Crusader/Priest) flushed to the right of the
        // matching row, rather than one long vertical list.
        for (let row = 0; row < 3; row++) {
            const leftLines = this._fighterBlockLines(orderedFightersInfo[row], build);
            const rightLines = this._fighterBlockLines(orderedFightersInfo[row + 3], build);
            text += this._sideBySideBlock(leftLines, rightLines) + '\n';
        }

        const fighters = orderedFightersInfo.map(fi => ({
            class: fi.class,
            pos:   fi.pos,
            stats: { ...build[this._key(fi.pos)] },
        }));

        return { text, build: { fighters } };
    }

    // Always display results in a fixed order — Shadow Dancer, Berserker,
    // Paladin, Bastion, Crusader, Priest — rather than whatever order the
    // caller happened to build fightersInfo in. REQUIRED_LAYOUT's key
    // insertion order already matches this exactly.
    _orderedForDisplay(fightersInfo) {
        const order = Object.keys(REQUIRED_LAYOUT);
        const byKey = new Map(fightersInfo.map(fi => [this._key(fi.pos), fi]));
        return order.map(key => byKey.get(key)).filter(Boolean);
    }

    // One fighter's result block as an array of lines: a header line plus one
    // line per stat, in DISPLAY_STAT_ORDER.
    _fighterBlockLines(fi, build) {
        const s = build[this._key(fi.pos)];
        const lines = [`${fi.class}:`];
        for (const stat of DISPLAY_STAT_ORDER) {
            const label = stat.replace('fighter_', '').padEnd(7);
            lines.push(`   ${label}: ${s[stat]}`);
        }
        return lines;
    }

    // Merges two fighters' line blocks into one multi-line string, left block
    // padded to a fixed column width so the right block lines up as a second
    // column (this is plain monospace text, not an HTML table).
    _sideBySideBlock(leftLines, rightLines, colWidth = 32) {
        const rowCount = Math.max(leftLines.length, rightLines.length);
        const rows = [];
        for (let i = 0; i < rowCount; i++) {
            const left = leftLines[i] || '';
            const right = rightLines[i] || '';
            rows.push(right ? `${left.padEnd(colWidth)}${right}` : left);
        }
        return rows.join('\n') + '\n';
    }
}
