const puppeteer = require("puppeteer");
const { performance } = require("perf_hooks");
const fs = require("fs");

async function scrapeSpell(classType, timer = 0) {
  const classtype = classReadable[classType];
  await sleep(timer);
  let t0 = performance.now();
  console.log(`${classtype} starting`);
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  if (!(classtype in spellIds["Spells"])) {
    spellIds["Spells"][classtype] = {};
  }
  if (!(classtype in spellIds["Talents"])) {
    spellIds["Talents"][classtype] = {};
  }
  if (!(classtype in spellIds["Covenants"])) {
    spellIds["Covenants"][classtype] = {};
  }
  for (spec in classSpecs[classType]) {
    let url = `https://shadowlands.wowhead.com/talent-calc/${classType}/${classSpecs[classType][spec]}`;
    let readableSpec = classSpecs[classType][spec];
    if (readableSpec === "beast-mastery") {
      readableSpec = "beast Mastery";
    }
    if (!(readableSpec.toUpperCase() in spellIds["Talents"][classtype])) {
      spellIds["Talents"][classtype][readableSpec.toUpperCase()] = {
        Normal: {},
        PvP: {}
      };
    }
    console.log(`checking ${readableSpec}`);
    await page.goto(url, { timeout: 0 });

    //go through each class
    //go through each spec
    //go through spell.all -> whenever we get a repeat add the spec to the spell db entry. If its already there throw a notification for us to know
    //use blacklist to ignore spells at certain levels, and always ignore passives.
    //Then go through talents, make sure to grab the row and column info - issue here with the fact some are passive
    //Go through pvp talents aswell - some also passive
    //then grab covenant abilities - replace the kyrian one with https://www.wowhead.com/item=177278/phial-of-serenity
    const talentData = await page.evaluate(() => {
      tds = Array.from(
        document.querySelectorAll(
          "table.talentcalc-core > tbody > tr.talentcalc-row > td[data-row]"
        )
      );
      return tds.map(td => {
        const spellId = td.querySelector("a.screen").href;
        const row = td.getAttribute("data-row");
        const col = td.getAttribute("data-col");
        const spellName = td.querySelector("div > table > tbody > tr > td")
          .textContent;
        return {
          spellId,
          row,
          col,
          spellName
        };
      });
    });

    talentData.forEach(({ spellId, row, col, spellName }) => {
      const regex = /spell=(\d+)/;
      const found = spellId.match(regex);
      if (!found) {
        console.log(`error with ${spellId}, could not be parsed`);
        return;
      } else {
        if (found.length !== 2) {
          console.log(
            `error with ${spellId}, parse didnt get sufficient values`
          );
          return;
        }
      }
      if (
        spellName in
        spellIds["Talents"][classtype][readableSpec.toUpperCase()]["Normal"]
      ) {
        console.log(`${spellName} already in talents for ${classtype}`);
      } else {
        spellIds["Talents"][classtype][readableSpec.toUpperCase()]["Normal"][
          spellName
        ] = {
          spellId: found[1],
          row,
          col
        };
      }
    });

    await page.click("div.talentcalc-pvp > div.iconmedium > a");

    const pvpTalentData = await page.evaluate(() => {
      tds = Array.from(
        document.querySelectorAll("div.talentcalc-pvp-talent:not(.active)")
      );
      return tds.map(td => {
        const spellId = td.querySelector("span + a").href;
        const spellName = td.textContent;
        return {
          spellId,
          spellName
        };
      });
    });
    pvpTalentData.forEach(({ spellId, spellName }) => {
      const regex = /spell=(\d+)/;
      const found = spellId.match(regex);
      if (!found) {
        console.log(`error with ${spellId}, could not be parsed`);
        return;
      } else {
        if (found.length !== 2) {
          console.log(
            `error with ${spellId}, parse didnt get sufficient values`
          );
          return;
        }
      }
      if (
        spellName in
        spellIds["Talents"][classtype][readableSpec.toUpperCase()]["PvP"]
      ) {
        console.log(`${spellName} already in PvP talents for ${classtype}`);
      } else {
        spellIds["Talents"][classtype][readableSpec.toUpperCase()]["PvP"][
          spellName
        ] = {
          spellId: found[1]
        };
      }
    });

    const covenantData = await page.evaluate(() => {
      tds = Array.from(
        document.querySelectorAll(
          "div.talentcalc-covenants-cell-flex > div[data-row] > div.inner > div.iconmedium + div.iconmedium"
        )
      );
      return tds.map(td => {
        const covNum = td.parentElement.parentElement.getAttribute(
          "data-covenant"
        );
        const spellId = td.querySelector("a").href;
        return {
          covNum,
          spellId
        };
      });
    });

    covenantData.forEach(({ covNum, spellId }) => {
      const regex = /spell=(\d+)/;
      const found = spellId.match(regex);
      if (!found) {
        console.log(`error with ${spellId}, could not be parsed`);
        return;
      } else {
        if (found.length !== 2) {
          console.log(
            `error with ${spellId}, parse didnt get sufficient values`
          );
          return;
        }
      }
      let spellID = found[1];
      const covenantName = covenantOptions[covNum];
      //if covenant is Summon steward switch to vial
      if (spellID === "324739") {
        spellID = "177278"; //Vial of serenity
      }
      if (!(covenantName in spellIds["Covenants"][classtype])) {
        spellIds["Covenants"][classtype][covenantName] = {};
      }
      spellIds["Covenants"][classtype][covenantName][spellID] = {
        spellId: spellID
      };
    });

    const spellData = await page.evaluate(() => {
      const tds = Array.from(
        document.querySelectorAll(
          "div.talentcalc-spell-list-table > table > tbody > tr"
        )
      );
      return tds.reduce((storage, td) => {
        const childs = td.children;
        const abilityLearntLevel = childs[0].textContent;
        const doesItHaveAStar = childs[1].textContent;

        const isItPassive = childs[2].textContent.includes("(Passive)");

        const spellDetails = childs[2].children;
        const spellName = spellDetails[1].textContent;
        const spellId = spellDetails[1].href;
        storage.push({
          abilityLearntLevel,
          doesItHaveAStar,
          isItPassive,
          spellName,
          spellId
        });
        return storage;
      }, []);
    });

    spellData.forEach(
      ({
        abilityLearntLevel,
        doesItHaveAStar,
        isItPassive,
        spellName,
        spellId
      }) => {
        if (isItPassive) {
          return;
        }

        const isItBlacklisted = blacklistedSpells[classType].some(blSpell =>
          RegExp(blSpell).test(
            `${abilityLearntLevel}${doesItHaveAStar}:${spellName}`
          )
        );
        if (isItBlacklisted) {
          return;
        }
        const regex = /spell=(\d+)/;
        const found = spellId.match(regex);
        if (!found) {
          console.log(`error with ${spellId}, could not be parsed`);
          return;
        } else {
          if (found.length !== 2) {
            console.log(
              `error with ${spellId}, parse didnt get sufficient values`
            );
            return;
          }
        }
        if (spellName in spellIds["Spells"][classtype]) {
          spellIds["Spells"][classtype][spellName]["spec"].push(
            readableSpec.toUpperCase()
          );
        } else {
          spellIds["Spells"][classtype][spellName] = {
            spec: [readableSpec.toUpperCase()],
            spellId: found[1]
          };
        }
      }
    );
  }
  //We cut out hex, since we couldnt distinguish it from the other 8 hexs, so now we just add it in manually.
  //Earth shield is bugged as of this moment, its not included with talents for some reason
  if (classType === "Shaman" && !("Hex" in spellIds["Spells"]["Shaman"])) {
    spellIds["Spells"]["Shaman"]["Hex"] = {
      spec: ["RESTORATION", "ELEMENTAL", "ENHANCEMENT"],
      spellId: "51514"
    };
  }
  if (
    classType === "Shaman" &&
    !("Earth Shield" in spellIds["Spells"]["Shaman"])
  ) {
    spellIds["Spells"]["Shaman"]["Earth Shield"] = {
      spec: ["RESTORATION"],
      spellId: "974"
    };
  }
  browser.close();
  let t1 = performance.now();
  console.log(`${classType} finished in ${(t1 - t0) / 1000} seconds`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const classes = [
  "death-knight",
  "demon-hunter",
  "druid",
  "hunter",
  "mage",
  "monk",
  "paladin",
  "priest",
  "rogue",
  "shaman",
  "warlock",
  "warrior"
];

const classReadable = {
  "death-knight": "Death Knight",
  "demon-hunter": "Demon Hunter",
  druid: "Druid",
  hunter: "Hunter",
  mage: "Mage",
  monk: "Monk",
  paladin: "Paladin",
  priest: "Priest",
  rogue: "Rogue",
  shaman: "Shaman",
  warlock: "Warlock",
  warrior: "Warrior"
};
const covenantOptions = {
  "1": "Kyrian",
  "2": "Venthyr",
  "3": "Night Fae",
  "4": "Necrolord"
};

const classSpecs = {
  "death-knight": ["blood", "frost", "unholy"],
  "demon-hunter": ["vengeance", "havoc"],
  druid: ["restoration", "feral", "guardian", "balance"],
  hunter: ["beast-mastery", "marksmanship", "survival"],
  mage: ["fire", "frost", "arcane"],
  monk: ["windwalker", "mistweaver", "brewmaster"],
  paladin: ["retribution", "holy", "protection"],
  priest: ["discipline", "holy", "shadow"],
  rogue: ["assasination", "subtlety", "outlaw"],
  shaman: ["restoration", "elemental", "enhancement"],
  warlock: ["destruction", "affliction", "demonology"],
  warrior: ["fury", "arms", "protection"]
};
const blacklistedSpells = {
  "death-knight": [
    "1:Frost Breath",
    "6:Runeforging",
    "10:Death Gate",
    "27:Path of Frost"
  ],
  "demon-hunter": [
    "1:Fodder to the Flame",
    "1:Glide",
    "1:Soul Carver",
    "1:Chaos Nova",
    "1:Chaos Strike",
    "1:Demon's Bite",
    "1:Fel Rush",
    "1:Vengeful Retreat"
  ],
  druid: [
    "1:Flap",
    "10:Dreamwalk",
    "10:Strength of the Wild",
    "19:Charm Woodland Creature",
    "22:Teleport: Moonglade",
    "24:Flight Form",
    "13:Sunfire"
  ],
  hunter: [
    "1:Volley",
    "1:Steel Trap",
    "1:Bestial Wrath",
    "5:Beast Lore",
    "5:Call Pet 1",
    "5:Dismiss Pet",
    "5:Feed Pet",
    "5:Tame Beast",
    "6:Wake Up",
    "10:Call Pet 2",
    "12:Chakrams",
    "17:Call Pet 3",
    "19:Aspect of the Chameleon",
    "19:Fireworks",
    "19:Play Dead",
    "41:Call Pet 4",
    "43:Eagle Eye",
    "47:Fetch",
    "48:Call Pet 5"
  ],
  mage: [
    "1:Polymorph",
    "1:Shoot",
    "1:Illusion",
    "(1|10|11|23|24|25|28|32|52|58):(Ancient )?(Portal|Teleport): .*",
    "5:Conjure Refreshments",
    "11:Teleport",
    "24:Portal",
    "17:Conjure Mana Gem",
    "25:Polymorph"
  ],
  monk: [
    "1\\*:Spinning Crane Kick",
    "10\\*Blackout Kick",
    "10:Soothing Mist",
    "11:Zen Pilgrimage",
    "17:Touch of Fatality",
    "37:Zen Flight"
  ],
  paladin: [
    "1\\*:Judgement",
    "1:Tyr's Deliverance",
    "1:Crusader's Direhorn",
    "(1):Summon .*",
    "19:Contemplation",
    "54:Sense Undead"
  ],
  priest: ["1:Shoot", "22:Mind Vision"],
  rogue: ["1:Detection", "24:Pick Lock", "24:Pick Pocket"],
  shaman: [
    "1:Surge of Earth",
    "1:Fae Transfusion",
    "1:Primordial Wave",
    "14:Far Sight",
    "32:Astral Recall",
    "41:Hex"
  ],
  warlock: [
    "1:DreadSteed",
    "1:Felsteed",
    "1:Shoot",
    "17:Eye of Kilrogg",
    "21:Subjugate Demon",
    "31:Ritual of Doom",
    "32:Soulstone",
    "33:Ritual of Summoning",
    "47:Create Soulwell"
  ],
  warrior: ["1:Hotbar Slot 01", "1:Hotbar Slot 02"]
};

let spellIds = { Spells: {}, Talents: {}, Covenants: {} };
let promises = [];

for (let k = 0; k < classes.length; k++) {
  promises.push(scrapeSpell(classes[k], 1000 * k));
}

Promise.all(promises).then(() => {
  let jsonToWrite = JSON.stringify(spellIds);
  fs.writeFileSync(`SpellsPhase1.json`, jsonToWrite);
});
