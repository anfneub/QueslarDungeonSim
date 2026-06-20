import { calculateDefense } from "../utils/utils.js";

export const MobClasses = Object.freeze({
  MOB: "Mob",
  BOSS: "Boss",
});

export function getMobStatValue(baseValue, baseIncrement, level) {
  if (level <= 600) {
    return baseValue + baseIncrement * level;
  }

  let totalValue = baseValue + baseIncrement * 600;
  let currentLevel = level - 600;
  let increment = 2 * baseIncrement;
  let processedLevel = 600;

  while (currentLevel > 300) {
    totalValue += increment * 300;
    currentLevel -= 300;
    processedLevel += 300;

    if (processedLevel >= 2100) {
      // Limit additional growth in scaling
    } else {
      increment += baseIncrement;
    }
  }

  return totalValue + currentLevel * increment;
}

export class Mob {
  constructor(level) {
    //this.mob_class = MobClasses.MOB;
    this.mob_class = window.i18nManager
      ? window.i18nManager.getMobInfo().MOB
      : MobClasses.MOB;
    this.level = level;

    this.total_health = getMobStatValue(100, 400, this.level);
    this.current_health = this.total_health;
    this.damage = getMobStatValue(25, 50, this.level);
    this.hit = getMobStatValue(0, 50, this.level);
    this.defense = calculateDefense(getMobStatValue(5, 10, this.level));
    this.crit_damage = 0.0;
    this.crit_chance = 0.0;
    this.dodge = getMobStatValue(0, 50, this.level);

    this.hit_counter = 0;
  }

  toString() {
    return `I am a level ${this.level} ${this.mob_class} with Health: ${this.current_health}/${this.total_health}, Damage: ${this.damage}, Hit: ${this.hit}, Defense: ${(100 * this.defense).toFixed(2)}%, Crit: ${(100 * this.crit).toFixed(2)}%, Dodge: ${this.dodge}`;
  }
}
