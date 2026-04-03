import { Fighter, FighterClasses } from "../characters/Fighter.js";
import { Mob } from "../characters/Mob.js";
import { calculateDefense } from "../utils/utils.js";
import { formatString } from "../utils/i18n.js";

function getAdjacent(i, j) {
  const rows = 3,
    cols = 2;
  const directions = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  const neighbors = [];
  for (const [di, dj] of directions) {
    const ni = i + di;
    const nj = j + dj;
    if (0 <= ni && ni < rows && 0 <= nj && nj < cols) neighbors.push([ni, nj]);
  }
  return neighbors;
}

export class Battle {
  constructor(fighters, mobs, verbose = 0) {
    this.fighters = fighters;
    this.mobs = mobs;
    this.continue_flag = true;
    this.current_round = 1;
    this.verbose = verbose;

    this.dead_fighters = [];
    this.shadow_dancer_double_damage = false;
    this.cannot_be_dodged = false;
    this.paladin_aura = false;
    this.bastion_aura = false;
    this.multistriker_attack = false;

    // Imports i18nManager from global;
    this.I18N = window.i18nManager;
  }

  update_dead_fighters() {
    this.dead_fighters = [];
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ]) {
      const f = this.fighters.all_fighters[x][y];
      if (f && f.current_health === 0.0) this.dead_fighters.push(f);
    }
  }

  update_crusader_total_health() {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        const f = this.fighters.all_fighters[i][j];
        if (f && f.fighter_class === FighterClasses.CRUSADER) {
          f.total_health = Math.round(f.original_health * (1 + 0.2 * this.dead_fighters.length));
        }
      }
    }
  }

  battle() {
    while (this.continue_flag) {
      this._do_one_round();
      if (this.current_round > 300) break;
      if (this._check_battle_is_over()) break;
    }

    const tot_mob_health = this._sumMobsHealth();
    if (this.current_round > 300) {
      return [
        "mobs",
        this.current_round,
        this.I18N.getBattleMsg("LOSE_DUE_TO_EXHAUST"),
        tot_mob_health,
      ];
    }

    const winner = this._check_battle_is_over();
    return [
      winner,
      this.current_round,
      this.I18N.getBattleMsg("HEALTH_0"),
      tot_mob_health,
    ];
  }

  _sumMobsHealth() {
    let sum = 0;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        const m = this.mobs.mobs[i][j];
        if (m) sum += m.current_health;
      }
    }
    return sum;
  }

  _do_one_round() {

    // get order of attacks, sorted by hit
    const sorted_attack_list = this._sort_by_hit();

    let current_attack = 0;
    for (const row of sorted_attack_list) {
      const i = row.i, j = row.j;
      let attacker, target;
      if (row.type === "fighters") {
        attacker = this.fighters.all_fighters[i][j];
        target = this._find_target("mobs");
      } else {
        attacker = this.mobs.mobs[i][j];
        target = this._find_target("fighters");
      }

      if (target === null) {
        this.continue_flag = false;
        break;
      }
      if (attacker === null || attacker.current_health === 0.0) continue;

      // change target to sentinel if attack receiver has lesst than 25% hp
      if (
        target instanceof Fighter &&
        target.current_health / target.total_health < 0.25
      ) {
        const f = this.fighters.all_fighters;
        const sentinel = [];
        for (let x = 0; x < 3; x++) {
          for (let y = 0; y < 2; y++) {
            if (
              f[x][y] &&
              f[x][y].fighter_class === FighterClasses.SENTINEL &&
              f[x][y].current_health > 0.0
            ) {
              sentinel.push(f[x][y]);
            }
          }
        }
        if (sentinel.length > 0) target = sentinel[0];
      }

      current_attack += 1;

      // update dead fighters, for crusader
      this.update_dead_fighters();
      // this.update_crusader_total_health();

      // roll for multistrike
      if (attacker instanceof Fighter && attacker.multistrike > 0) {
        let multistrike = attacker.multistrike / 100.0;

        if (attacker.fighter_class === FighterClasses.CRUSADER) {
          if (this.dead_fighters.length > 0) multistrike = (1 + 0.2 * this.dead_fighters.length) * multistrike;
        }

        const rng_multistrike = Math.random();
        if (rng_multistrike < multistrike) {
          if (this.verbose >= 1)
            this._draw_table_head(this.I18N.getBattleMsg("MULTISTRIKE"));
          this.multistriker_attack = true;
        }
      }


      // check for bastion and paladin auras
      if (attacker instanceof Mob) {
        let fighters = this.fighters.all_fighters;

        let target_i = null;
        let target_j = null;
        for (let i = 0; i < fighters.length; i++) {
          for (let j = 0; j < fighters[i].length; j++) {
            if (
              fighters[i][j] &&
              fighters[i][j].fighter_class === target.fighter_class &&
              fighters[i][j].current_health > 0
            ) {
              target_i = i;
              target_j = j;
              break;
            }
          }
          if (target_i !== null) break;
        }

        if (target_i !== null) {
          // === Bastion Aura Check (adjacent cells) ===
          const adjacentPositions = getAdjacent(target_i, target_j);

          for (const [adj_i, adj_j] of adjacentPositions) {
            const fighter = fighters[adj_i]?.[adj_j];
            if (
              fighter &&
              fighter.fighter_class === FighterClasses.BASTION &&
              fighter.current_health > 0
            ) {
              this.bastion_aura = true;
              break;
            }
          }

          // === Paladin Aura Check (same column) ===
          if (target.fighter_class !== FighterClasses.PALADIN) {
            for (let i = 0; i < fighters.length; i++) {
              const fighter = fighters[i]?.[target_j];
              if (
                fighter &&
                fighter.fighter_class === FighterClasses.PALADIN &&
                fighter.current_health > 0
              ) {
                this.paladin_aura = true;
                break;
              }
            }
          }
        }
      }

      // assassin attacks back column first
      if (
        attacker instanceof Fighter &&
        attacker.fighter_class === FighterClasses.ASSASSIN
      ) {
        target = this._find_target_for_assassin();
        if (target === null) {
          this.continue_flag = false;
          break;
        }
      }

      // brawler has 15% chance to attack twice
      if (
        attacker instanceof Fighter &&
        attacker.fighter_class === FighterClasses.BRAWLER
      ) {
        const rng_brawler = Math.random();
        if (this.verbose >= 2)
          console.log(`\nRNG brawler: ${rng_brawler} < 0.15`);
        if (rng_brawler < 0.15) {
          if (this.verbose >= 1)
            this._draw_table_head(this.I18N.getBattleMsg("SP_BR_DOUBLE"), true);
          this._do_standard_attack(attacker, target);

          if (attacker.multistrike > 0) {
            const rng_multistrike_brawler = Math.random();
            if (rng_multistrike_brawler < multistrike) {
              if (this.verbose >= 1)
                this._draw_table_head(this.I18N.getBattleMsg("MULTISTRIKE2"));
              this._do_standard_attack(attacker, target);
            }
          }

          target = this._find_target("mobs");
          if (target === null) {
            this.continue_flag = false;
            break;
          }
        }
      }

      // hunter attacks a whole row dealing 75% damage
      if (
        attacker instanceof Fighter &&
        attacker.fighter_class === FighterClasses.HUNTER
      ) {
        const targets_hunter = this._find_target_for_hunter();
        if (targets_hunter === null) {
          this.continue_flag = false;
          break;
        } else {
          for (const lcl_target of targets_hunter) {
            if (lcl_target) {
              this._do_standard_attack(attacker, lcl_target, 0.75);
            }
          }
        }

        if (this.multistriker_attack) {
          const targets_hunter = this._find_target_for_hunter();
          if (targets_hunter === null) {
            this.continue_flag = false;
            break;
          } else {
            for (const lcl_target of targets_hunter) {
              if (lcl_target) {
                this._do_standard_attack(attacker, lcl_target, 0.75);
              }
            }
          }
          this.multistriker_attack = false;
        }

        this._print_debug(i, j, row.type, current_attack, targets_hunter);
        continue;
      }

      // mage attacks a whole column dealing 50% damage
      if (
        attacker instanceof Fighter &&
        attacker.fighter_class === FighterClasses.MAGE
      ) {
        const targets_mage = this._find_target_for_mage();
        if (targets_mage === null) {
          this.continue_flag = false;
          break;
        } else {
          for (const lcl_target of targets_mage) {
            if (lcl_target) {
              this._do_standard_attack(attacker, lcl_target, 0.5);
            }
          }
        }

        if (this.multistriker_attack) {
          const targets_mage = this._find_target_for_mage();
          if (targets_mage === null) {
            this.continue_flag = false;
            break;
          } else {
            for (const lcl_target of targets_mage) {
              if (lcl_target) {
                this._do_standard_attack(attacker, lcl_target, 0.5);
              }
            }
          }
          this.multistriker_attack = false;
        }

        this._print_debug(i, j, row.type, current_attack, targets_mage);
        continue;
      }

      // berserker attacks with increased damage based on health
      if (
        attacker instanceof Fighter &&
        attacker.fighter_class === FighterClasses.BERSERKER
      ) {
        const health_ratio = attacker.current_health / attacker.total_health;
        let damage_mult = 1.0;
        if (0.75 <= health_ratio && health_ratio <= 1.0) {
          damage_mult = 1.0;
        } else if (0.5 <= health_ratio && health_ratio < 0.75) {
          damage_mult = 1.25;
        } else if (0.25 <= health_ratio && health_ratio < 0.5) {
          damage_mult = 1.5;
        } else if (health_ratio < 0.25) {
          this.cannot_be_dodged = true;
          damage_mult = 1.75;
        }
        this._do_standard_attack(attacker, target, damage_mult);
        if (this.multistriker_attack) {
          this._do_standard_attack(attacker, target, damage_mult);
          this.multistriker_attack = false;
        }
        this._print_debug(i, j, row.type, current_attack, [target]);
        continue;
      }

      this._do_standard_attack(attacker, target);
      if (this.multistriker_attack) {
        this._do_standard_attack(attacker, target);
        this.multistriker_attack = false;
      }
      this._print_debug(i, j, row.type, current_attack, [target]);
    }

    // regen and healing
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        const f = this.fighters.all_fighters[i][j];

        // regen
        if (f && f.regen > 0.0 && f.current_health > 0.0) {
          let regen_amount = Math.round(f.regen * f.total_health / 100.0);

          if (f.fighter_class === FighterClasses.CRUSADER) {
            this.update_dead_fighters();
            regen_amount = Math.round((1 + 0.2 * this.dead_fighters.length) * regen_amount);
          }

          f.current_health = Math.min(f.current_health + regen_amount, f.total_health);
          if (this.verbose >= 1) { this._draw_table_head(formatString(this.I18N.getBattleMsg("REGEN"), f.fighter_class, regen_amount)) };
        }

        // healing
        if (f && f.healing > 0.0 && f.current_health > 0.0) {

          let selectedFighter = null;
          let smallestHealthPercent = Infinity;

          for (let x = 0; x < 3; x++) {
            for (let y = 0; y < 2; y++) {
              const f = this.fighters.all_fighters[x][y];
              if (f && (i !== x || j !== y) && f.current_health > 0.0 && f.current_health / f.total_health < smallestHealthPercent) {
                smallestHealthPercent = f.current_health / f.total_health;
                selectedFighter = f;
              }
            }
          }
          if (selectedFighter) {

            let healing_amount = f.healing;
            if (f.fighter_class === FighterClasses.CRUSADER) {
              this.update_dead_fighters();
              healing_amount = Math.round((1 + 0.2 * this.dead_fighters.length) * healing_amount);
            }

            selectedFighter.current_health = Math.min(selectedFighter.current_health + healing_amount, selectedFighter.total_health);
            if (this.verbose >= 1) { this._draw_table_head(formatString(this.I18N.getBattleMsg("HEALING"), f.fighter_class, selectedFighter.fighter_class, healing_amount)) };
          }
        }
      }
    }

    // priest may resurrect a dead fighter with 25% max health at the end of the round
    this.update_dead_fighters();

    const f = this.fighters.all_fighters;
    const priest = [];
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 2; y++) {
        if (
          f[x][y] &&
          f[x][y].fighter_class === FighterClasses.PRIEST &&
          f[x][y].current_health > 0.0
        ) {
          priest.push(f[x][y]);
        }
      }
    }

    if (priest.length > 0 && this.dead_fighters.length > 0) {
      const rng_priest = Math.random();
      if (rng_priest < 0.1) {
        const idx = Math.floor(Math.random() * this.dead_fighters.length);
        const resurrected_fighter = this.dead_fighters[idx];
        resurrected_fighter.current_health = Math.round(
          resurrected_fighter.total_health * 0.25,
        );
        resurrected_fighter.hit_counter = 0;

        this.update_dead_fighters();

        if (this.verbose >= 1)
          this._draw_table_head(
            formatString(
              this.I18N.getBattleMsg("PRIEST_RESURRECTED"),
              resurrected_fighter.name,
            ),
            true,
          );
      }
    }

    if (this.verbose >= 1) {
      this._draw_table_head(this.I18N.getBattleMsg("FINAL_ROUND"));
      this._draw_health_table(null, null, null);
      console.log("<br/><br/>");
    }
    this.current_round += 1;
  }

  /**
   * Print table head for Round information.
   * @param {*} content
   * @param {boolean} sigle If needs display a sigle info
   */
  _draw_table_head(content, sigle = false) {
    let head = `<table style="border: 1px solid white; border-collapse: collapse; width: 100%; text-align: center; background:#36405a">\n`;
    head += `<thead><tr><th colspan="4" style="border: 1px solid white; padding: 16px;"> ${content} </th></tr></thead>${sigle ? "</table>" : ""}`;
    console.log(head);
  }

  /**
   * Print row for special moves/passive effect.
   * @param {*} content
   */
  _draw_table_row(content) {
    let row = `<tr><th colspan="4" style="border: 1px solid white; padding: 16px;"> ${content} </th></tr>`;
    console.log(row);
  }

  _print_debug(i, j, type, current_attack, targets = null) {
    if (this.verbose >= 1) {
      this._draw_table_row(formatString(this.I18N.getBattleMsg("ROUND_INFO"), this.current_round, current_attack));
      this._draw_health_table(i, j, type, targets);
    }
  }

  _draw_health_table(i, j, att_type, targets, test = false) {
    const fighters = this.fighters.all_fighters;
    const mobs = this.mobs.mobs;

    const formattedString = (selI, selJ, selType, x, y, type) => {
      if (type === "fighters" && !fighters[x][y]) return "";
      if (type === "mobs" && !mobs[x][y]) return "";

      let label =
        type === "fighters"
          ? this.I18N.getFighterName(fighters[x][y].fighter_class)
          : //? fighters[x][y].fighter_class
          formatString(
            this.I18N.getBattleMsg("HEALTH_TABLE_LINE"),
            mobs[x][y].mob_class,
            mobs[x][y].level,
          );
      //: `${mobs[x][y].mob_class} lvl ${mobs[x][y].level}`;
      if (selI === x && selJ === y && att_type === type) label += " ⚔️";
      const char = type === "fighters" ? fighters[x][y] : mobs[x][y];
      if (targets && targets.includes(char)) label += " 🛡️";

      let current, total;
      if (type === "fighters") {
        const f = fighters[x][y];
        current = Math.trunc(f.current_health);
        total = Math.trunc(f.total_health);
      } else {
        const m = mobs[x][y];
        current = Math.trunc(m.current_health);
        total = Math.trunc(m.total_health);
      }

      return `${label}\n${current}/${total}`;
    };

    // Build data grid
    const rows = [0, 1, 2].map((x) => [
      formattedString(i, j, att_type, x, 1, "mobs"),
      formattedString(i, j, att_type, x, 0, "mobs"),
      formattedString(i, j, att_type, x, 0, "fighters"),
      formattedString(i, j, att_type, x, 1, "fighters"),
    ]);

    const headers = this.I18N.getBattleMsg("headers");

    // Calculate column widths
    const allCells = [headers, ...rows];

    // Build HTML table
    // Table body, table head process with this._draw_table_head
    let output = "<tbody>";
    output += "<tr>";
    headers.forEach((headerline) => {
      output += `<td style="border: 1px solid white; padding: 8px;">${headerline}</td>`;
    });
    output += "</tr>";
    for (const row of rows) {
      output += `<tr height="55px">`;
      row.forEach((cell) => {
        // Handle multi-line cells by replacing newlines with <br>
        const cellContent = (cell || "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .join("<br>");

        output += `<td style="width:25%; border: 1px solid white; padding: 8px; ${cellContent.indexOf("⚔️") > 0 ? "background: #b40900;" : ""
          } ${cellContent.indexOf("🛡️") > 0 ? "background: #0000c4;" : ""
          } ">${cellContent.replace("EMPTY", "")}</td>`;
      });
      output += "</tr>";
    }
    output += "</tbody></table>";

    // Print to HTML <pre> element
    const outputEl = document.getElementById("battle-output");

    if (test) console.warn(JSON.stringify(output));

    if (outputEl) {
      outputEl.textContent = output;
      //outputEl.innerHTML = output;
    } else {
      console.log(output); // fallback if no element exists
    }
  }

  _do_standard_attack(attacker, target, damage_mult = 1.0) {

    // define attacker and target names
    let attacker_name, target_name;
    // Add safety check for null/undefined targets
    if (!target) {
      if (this.verbose >= 1)
        console.log(
          formatString(
            this.I18N.getBattleMsg("ERR_IVLD_TGT_ID"),
            attacker instanceof Mob
              ? this.I18N.getBattleMsg("mob")
              : this.I18N.getBattleMsg("fighter"),
          ),
        );

      return;
    }

    if (attacker instanceof Mob)
      attacker_name = formatString(
        this.I18N.getBattleMsg("MOB_ATK_NAME"),
        attacker.level,
        attacker.mob_class,
      );
    else if (attacker instanceof Fighter)
      attacker_name = this.I18N.getFighterName(attacker.fighter_class);
    else throw new Error(this.I18N.getBattleMsg("ERR_IVLD_ATKR"));

    if (target instanceof Mob)
      target_name = formatString(
        this.I18N.getBattleMsg("MOB_TGT_NAME"),
        target.level,
        target.mob_class,
      );
    else if (target instanceof Fighter)
      target_name = this.I18N.getFighterName(target.fighter_class);
    else throw new Error(this.I18N.getBattleMsg("ERR_IVLD_TGT"));

    let target_defense = 1 - target.defense;
    let target_defense_pre = target.defense_pre;
    let target_dodge = target.dodge;
    let attacker_hit = attacker.hit;
    let attacker_damage = attacker.damage;
    let attacker_crit_damage = attacker.crit_damage;
    let additional_dr = 0.0;

    // Update dead fighters
    this.update_dead_fighters();

    // Implicits
    let lifesteal = 0;
    let attacker_crit_chance = 0;
    let multistrike = 0;
    let thorns = 0;

    if (attacker instanceof Fighter) {
      lifesteal = attacker.lifesteal;
      attacker_crit_chance = attacker.crit_chance;
      multistrike = attacker.multistrike;
    }

    if (target instanceof Fighter) {
      thorns = target.thorns;
    }

    // Crusader defense bonus, including implicits
    if (
      target instanceof Fighter &&
      target.fighter_class === FighterClasses.CRUSADER
    ) {
      target.total_health = Math.round(target.original_health * (1 + 0.2 * this.dead_fighters.length));
      target_defense_pre =
        (1 + 0.2 * this.dead_fighters.length) * target.defense_pre;
      target_defense = 1 - calculateDefense(target_defense_pre);
      target_dodge = (1 + 0.2 * this.dead_fighters.length) * target_dodge;
    }

    // Crusader attack bonus, including implicits
    if (
      attacker instanceof Fighter &&
      attacker.fighter_class === FighterClasses.CRUSADER
    ) {
      attacker.total_health = Math.round(attacker.original_health * (1 + 0.2 * this.dead_fighters.length));
      attacker_hit = (1 + 0.2 * this.dead_fighters.length) * attacker_hit;
      attacker_damage = (1 + 0.2 * this.dead_fighters.length) * attacker_damage;
      attacker_crit_damage = (1 + 0.2 * this.dead_fighters.length) * attacker_crit_damage;
      attacker_crit_chance = 0.1 + ((1 + 0.2 * this.dead_fighters.length) * (attacker_crit_chance - 0.1));
      lifesteal = (1 + 0.2 * this.dead_fighters.length) * lifesteal;
      multistrike = (1 + 0.2 * this.dead_fighters.length) * multistrike;
      thorns = (1 + 0.2 * this.dead_fighters.length) * thorns;
    }

    // Shadow dancer evasion roll
    if (
      target instanceof Fighter &&
      target.fighter_class === FighterClasses.SHADOW_DANCER
    ) {
      const rng_evade = Math.random();
      if (this.verbose >= 2)
        console.log(`Shadow dancer evade rng: ${rng_evade.toFixed(3)} < 0.25`);
      if (rng_evade < 0.25) {
        if (this.verbose >= 1)
          this._draw_table_head(this.I18N.getBattleMsg("SP_SD_EVADED"));
        this.shadow_dancer_double_damage = true;
        attacker.hit_counter += 1;
        return;
      }
    }

    // Bastion aura
    if (target instanceof Fighter && this.bastion_aura) {
      if (this.verbose >= 1)
        this._draw_table_head(this.I18N.getBattleMsg("SP_BS_DMG_DODGE"), true);
      additional_dr = additional_dr + 0.25;
      target_dodge *= 1.5;
      this.bastion_aura = false;
    }

    // Hit chance
    const attacker_chance = Math.min(
      0.25 + (attacker_hit / (attacker_hit + target_dodge)) * 0.75,
      0.95,
    );
    let rng_attack;
    if (this.cannot_be_dodged) {
      rng_attack = -1.0;
      if (this.verbose >= 1)
        this._draw_table_head(formatString(this.I18N.getBattleMsg("ATK_CANNOT_DODGE"), attacker_name), true);
      this.cannot_be_dodged = false;
    } else {
      rng_attack = Math.random();
      if (this.verbose >= 2)
        this._draw_table_head(formatString(this.I18N.getBattleMsg("ATK_RNG_SUCC"), rng_attack.toFixed(3), attacker_chance.toFixed(3)), true);
    }

    // hit roll
    if (rng_attack < attacker_chance) {
      attacker.hit_counter += 1;

      // Shadow dancer double damage
      if (
        attacker instanceof Fighter &&
        attacker.fighter_class === FighterClasses.SHADOW_DANCER &&
        this.shadow_dancer_double_damage
      ) {
        if (this.verbose >= 1)
          this._draw_table_head(
            this.I18N.getBattleMsg("SP_SD_APL_DOUBLEDMG"),
            true,
          );
        attacker_damage = attacker_damage * 2;
        this.shadow_dancer_double_damage = false;
      }

      // Paladin aura -> damage reduction
      if (target instanceof Fighter && this.paladin_aura) {
        if (this.verbose >= 1)
          this._draw_table_head(
            this.I18N.getBattleMsg("SP_PL_DMG_REDUCTION"),
            true,
          );
        additional_dr = additional_dr + 0.15;
        this.paladin_aura = false;
      }

      // damage amount
      let dmg_amount;
      if (thorns > 0) {
        dmg_amount = target_defense * (1 - additional_dr) * (1 - thorns / 100.0) * attacker_damage * damage_mult;
      } else {
        dmg_amount = target_defense * (1 - additional_dr) * attacker_damage * damage_mult;
      }
      let dmg_for_thorns = target_defense * (1 - additional_dr) * attacker_damage * damage_mult;
      let damage_info_key = "DAMAGE_INFO";

      // crit roll
      const rng_crit = Math.random();
      if (this.verbose >= 2)
        this._draw_table_head(
          formatString(
            this.I18N.getBattleMsg("CRT_RNG_INFO"),
            rng_crit.toFixed(3),
          ),
          true,
        );
      if (rng_crit < attacker_crit_chance) {
        dmg_amount = dmg_amount * (1 + attacker_crit_damage);
        dmg_for_thorns = dmg_for_thorns * (1 + attacker_crit_damage);
        damage_info_key = "DAMAGE_INFO_CRIT";
      }
      const dmg_final = Math.floor(dmg_amount);
      const dmg_applied = Math.max(dmg_final, 0.0);
      if (this.verbose >= 1)
        this._draw_table_head(
          formatString(
            this.I18N.getBattleMsg(damage_info_key),
            attacker_name,
            target_name,
            dmg_applied,
          ),
        );

      const dmg_real = Math.min(target.current_health, dmg_applied);

      target.current_health = Math.max(0.0, target.current_health - dmg_applied);

      // lifesteal

      if (attacker instanceof Fighter && (lifesteal > 0)) {
        let lifesteal_amount = Math.floor(dmg_real * lifesteal / 100);
        attacker.current_health = Math.min(attacker.current_health + lifesteal_amount, attacker.total_health);
        if (this.verbose >= 1) { this._draw_table_head(formatString(this.I18N.getBattleMsg("LIFESTEAL"), attacker_name, lifesteal_amount)) };
      }

      // thorns
      if (target instanceof Fighter && (thorns > 0)) {
        let thorns_damage = Math.floor(dmg_for_thorns * thorns / 100);
        attacker.current_health = Math.max(0.0, attacker.current_health - thorns_damage);
        if (this.verbose >= 1) { this._draw_table_head(formatString(this.I18N.getBattleMsg("THORNS"), attacker_name, target_name, thorns_damage)) };
      }

    } else {
      if (this.verbose >= 1) this._draw_table_head(formatString(this.I18N.getBattleMsg("ATK_MISS"), attacker_name, target_name));
    }
  }

  _check_battle_is_over() {
    let fighters_health = 0;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        const f = this.fighters.all_fighters[i][j];
        if (f) fighters_health += f.current_health;
      }
    }
    if (fighters_health === 0.0) return "mobs";

    let mobs_health = 0;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        const m = this.mobs.mobs[i][j];
        if (m) mobs_health += m.current_health;
      }
    }
    if (mobs_health === 0.0) return "fighters";
    return null;
  }

  _find_target(target_group) {
    if (target_group === "mobs") {
      for (const [i, j] of [
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 1],
        [1, 1],
        [2, 1],
      ]) {
        const m = this.mobs.mobs[i][j];
        if (m && m.current_health > 0.0) return m;
      }
      return null;
    }
    if (target_group === "fighters") {
      for (const [i, j] of [
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 1],
        [1, 1],
        [2, 1],
      ]) {
        const f = this.fighters.all_fighters[i][j];
        if (f && f.current_health > 0.0) return f;
      }
      return null;
    }
    throw new Error(`Unknown target type ${target_group}`);
  }

  _find_target_for_assassin() {
    for (const [i, j] of [
      [0, 1],
      [1, 1],
      [2, 1],
      [0, 0],
      [1, 0],
      [2, 0],
    ]) {
      const m = this.mobs.mobs[i][j];
      if (m && m.current_health > 0.0) return m;
    }
    return null;
  }

  _find_target_for_hunter() {
    for (const pair of [
      [
        [0, 0],
        [0, 1],
      ],
      [
        [1, 0],
        [1, 1],
      ],
      [
        [2, 0],
        [2, 1],
      ],
    ]) {
      const [[f1_i, f1_j], [f2_i, f2_j]] = pair;
      const f1 = this.mobs.mobs[f1_i][f1_j];
      const f2 = this.mobs.mobs[f2_i][f2_j];
      if ((f1 && f1.current_health > 0.0) || (f2 && f2.current_health > 0.0))
        return [f1, f2];
    }
    return null;
  }

  _find_target_for_mage() {
    for (const triple of [
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
      [
        [0, 1],
        [1, 1],
        [2, 1],
      ],
    ]) {
      const [[f1_i, f1_j], [f2_i, f2_j], [f3_i, f3_j]] = triple;
      const f1 = this.mobs.mobs[f1_i][f1_j];
      const f2 = this.mobs.mobs[f2_i][f2_j];
      const f3 = this.mobs.mobs[f3_i][f3_j];
      if (
        (f1 && f1.current_health > 0.0) ||
        (f2 && f2.current_health > 0.0) ||
        (f3 && f3.current_health > 0.0)
      )
        return [f1, f2, f3];
    }
    return null;
  }

  _sort_by_hit() {
    const d = [];
    for (const [i, j] of [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ]) {
      const fighter = this.fighters.all_fighters[i][j];
      if (fighter !== null)
        d.push({ i, j, type: "fighters", hit: fighter.hit });
      else d.push({ i, j, type: "fighters", hit: 0.0 });

      const mob = this.mobs.mobs[i][j];
      if (mob !== null) d.push({ i, j, type: "mobs", hit: mob.hit });
      else d.push({ i, j, type: "mobs", hit: 0.0 });
    }
    d.sort((a, b) => {
      if (b.hit !== a.hit) return b.hit - a.hit;
      if (-b.j !== -a.j) return -b.j - -a.j;
      return -b.i - -a.i;
    });
    return d;
  }
}
