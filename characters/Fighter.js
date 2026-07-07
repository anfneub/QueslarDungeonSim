import { calculateDefense } from "../utils/utils.js";
import { formatString } from "../utils/i18n.js";

export const FighterClasses = Object.freeze({
  ASSASSIN: "Assassin",
  BRAWLER: "Brawler",
  HUNTER: "Hunter",
  MAGE: "Mage",
  PRIEST: "Priest",
  SHADOW_DANCER: "Shadow Dancer",
  BERSERKER: "Berserker",
  PALADIN: "Paladin",
  CRUSADER: "Crusader",
  SENTINEL: "Sentinel",
  BASTION: "Bastion",
  NONE: "No Class",
});

export class Fighter {
  constructor(
    fighterClass,
    {
      name = null,
      fighter_health = 0,
      fighter_damage = 0,
      fighter_hit = 0,
      fighter_defense = 0,
      fighter_crit = 0,
      fighter_dodge = 0,
      object_health = 0,
      object_damage = 0,
      object_hit = 0,
      object_defense = 0,
      object_crit = 0,
      object_dodge = 0,
      object_lifesteal = 0,
      object_crit_chance = 0,
      object_multistrike = 0,
      object_thorns = 0,
      object_regen = 0,
      object_healing = 0,
      isDuplicate = false,
      base = null,
      equippedItemId = null
    } = {},
  ) {
    this.fighter_class = fighterClass;
    this.I18N = window.i18nManager;

    if (!Object.values(FighterClasses).includes(fighterClass)) {
      throw new Error(
        formatString(this.I18N.getConsoleMsg("ERR_IVLD_FIGHTER_CLS_PLH"), fighterClass),
      );
    }

    this.name = name || this.I18N.getFighterName(fighterClass.replace(" ", "_"));

    this.original_health = Math.ceil(500 + 100 * fighter_health) + object_health;
    this.total_health = this.original_health;
    this.current_health = this.total_health;
    this.damage = Math.ceil(100 + 25 * fighter_damage) + object_damage;
    this.hit = Math.ceil(50 + 50 * fighter_hit) + object_hit;
    this.defense_pre = 25 + 10 * fighter_defense + object_defense;
    this.defense_pre_print = 25 + 10 * fighter_defense;
    this.defense = calculateDefense(this.defense_pre);
    this.crit_damage = (0.0 + 0.25 * fighter_crit + object_crit) / 100.0;
    this.crit_chance = 0.1 + object_crit_chance / 100.0;
    this.dodge = Math.ceil(50.0 + 50.0 * fighter_dodge) + object_dodge;
    this.lifesteal = object_lifesteal;
    this.multistrike = object_multistrike;
    this.thorns = object_thorns;
    this.regen = object_regen;
    this.healing = object_healing;

    this.hit_counter = 0;

    this.isDuplicate = isDuplicate;
    this.base = base;
    this.equippedItemId = equippedItemId;
  }


  toString() {
    return `I am ${this.name}, a ${this.fighter_class} with Health: ${this.current_health}/${this.total_health}, Damage: ${this.damage}, Hit: ${this.hit}, Defense: ${(100 * this.defense).toFixed(2)}%, Defense pre: ${this.defense_pre_print}, Crit Chance: ${(100 * this.crit_chance).toFixed(2)}%, Crit Damage: ${(100 * this.crit_damage).toFixed(2)}%, Dodge: ${this.dodge}`;
  }

}