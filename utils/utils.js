export function costOfLvl(lvl) {
  return lvl * lvl * 5000;
}

export function costOfLvlRaise(startingLvl, lvlIncrease) {
  return costOfLvl(startingLvl + lvlIncrease) - costOfLvl(startingLvl);
}

export function millify(n) {
  if (typeof n === "number" && !Number.isFinite(n)) {
    throw new Error("Invalid number");
  }

  if (typeof n === "string") {
    const num = Number(n);
    if (!Number.isNaN(num)) n = num;
  }

  if (n < 0) {
    return "-" + millify(-n);
  }

  if (n < 1000) {
    if (Number.isInteger(n)) {
      return String(n);
    } else {
      if (Number.isInteger(Math.trunc(n))) {
        return String(Math.trunc(n));
      } else {
        return parseFloat(n.toFixed(2)).toString();
      }
    }
  } else {
    const millnames = ["", "k", "m", "b", "t", "qa", "qi", "sx", "sp"];
    const maxIndex = millnames.length - 1;
    const thousands = Math.floor(Math.log10(n) / 3);
    const millidx = Math.max(0, Math.min(maxIndex, thousands));
    let formattedNumber = (n / 10 ** (3 * millidx)).toFixed(2);
    if (formattedNumber.endsWith(".00")) {
      formattedNumber = formattedNumber.slice(0, -1);
    }
    return `${formattedNumber}${millnames[millidx]}`;
  }
}

export function demillify(n) {
  if (typeof n === "number") return n;

  if (typeof n === "string" && !/[a-zA-Z]/.test(n)) {
    if (n.includes(".")) return parseFloat(n);
    return parseInt(n, 10);
  }

  if (typeof n !== "string") {
    throw new Error(`Number format ${n} not recognized`);
  }

  const lower = n.toLowerCase();
  if (lower.endsWith("k")) return parseFloat(lower.slice(0, -1)) * 1e3;
  if (lower.endsWith("m")) return parseFloat(lower.slice(0, -1)) * 1e6;
  if (lower.endsWith("b")) return parseFloat(lower.slice(0, -1)) * 1e9;
  if (lower.endsWith("t")) return parseFloat(lower.slice(0, -1)) * 1e12;
  if (lower.endsWith("qa")) return parseFloat(lower.slice(0, -2)) * 1e15;
  if (lower.endsWith("qi")) return parseFloat(lower.slice(0, -2)) * 1e18;
  if (lower.endsWith("sx")) return parseFloat(lower.slice(0, -2)) * 1e21;
  if (lower.endsWith("sp")) return parseFloat(lower.slice(0, -2)) * 1e24;
  throw new Error(`Number format ${n} not recognized`);
}

export function calculateDefense(defense) {
  const capped = Math.min(20000, defense);
  return Math.min(
    1 - 1 / Math.pow(1 + (defense + capped * 9) / 50000, 0.25),
    0.95,
  );
}

export function calculateFighterCost(fighterStats) {
  const {
    fighter_health = 0,
    fighter_damage = 0,
    fighter_hit = 0,
    fighter_defense = 0,
    fighter_crit = 0,
    fighter_dodge = 0,
  } = fighterStats;

  return costOfLvl(fighter_health) +
    costOfLvl(fighter_damage) +
    costOfLvl(fighter_hit) +
    costOfLvl(fighter_defense) +
    costOfLvl(fighter_crit) +
    costOfLvl(fighter_dodge);
}

export const MAX_TIER = 16;

export function calculateTierLevel(stat, level, tier) {
  const tierMultipliers = {
    1: 1.1,
    2: 1.2,
    3: 1.3,
    4: 1.4,
    5: 1.5,
    6: 1.75,
    7: 2,
    8: 2.25,
    9: 2.5,
    10: 2.75,
    11: 3,
    12: 3.5,
    13: 3.75,
    14: 4,
    15: 4.25,
    16: 4.5
  };
  if (stat === 'health') return (50 + Math.sqrt(level) * level / 3 * 50) * 100 * tierMultipliers[tier];
  if (stat === 'damage') return (25 + Math.sqrt(level) * level / 3 * 25) * 25 * tierMultipliers[tier]
  if (stat === 'defense') return (30 + Math.sqrt(level) * level / 3 * 30) * 10 * tierMultipliers[tier];
  if (stat === 'critDamage') return (10 + Math.sqrt(level) * level / 3 * 10) * 0.0025 * tierMultipliers[tier];
  if (stat === 'hit') return (15 + Math.sqrt(level) * level / 1.5 * 15) * 50 * tierMultipliers[tier];
  if (stat === 'dodge') return (15 + Math.sqrt(level) * level / 1.5 * 15) * 50 * tierMultipliers[tier];
  if (stat === 'lifesteal') return (0.02 + Math.sqrt(level) * level / 12500.0 * 1) * 1 * tierMultipliers[tier];
  if (stat === 'critChance') return (0.02 + Math.sqrt(level) * level / 250.0 * 0.01) * 1 * tierMultipliers[tier];
  if (stat === 'multistrike') return (0.02 + Math.sqrt(level) * level / 250.0 * 0.01) * 1 * tierMultipliers[tier];
  if (stat === 'thorns') return (0.02 + Math.sqrt(level) * level / 7500.0 * 1) * 1 * tierMultipliers[tier];
  if (stat === 'regen') return (0.01 + Math.sqrt(level) * level / 30000.0 * 1) * 1 * tierMultipliers[tier];
  if (stat === 'healing') return (50 + Math.sqrt(level) * level / 3 * 25) * 2 * tierMultipliers[tier];
}
