const puppeteer = require("puppeteer");
const { performance } = require("perf_hooks");
const fs = require("fs");
const Mutex = require("async-mutex").Mutex;
const maxPages = 5;

async function scrapeSpell(classType, browser, mutex) {
  const classtype = classReadable[classType];
  let page;
  const release = await mutex.acquire();
  try {
    let pages = await browser.pages();

    while (pages.length > maxPages) {
      pages = await browser.pages();
      await sleep(500);
    }

    page = await browser.newPage();
  } finally {
    release();
  }
  let t0 = performance.now();
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
    let url = `https://wowhead.com/talent-calc/${classType}/${classSpecs[classType][spec]}`;
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
    await page.goto(url, { timeout: 0 });

    //go through each class
    //go through each spec
    //go through spell.all -> whenever we get a repeat add the spec to the spell db entry. If its already there throw a notification for us to know
    //use blacklist to ignore spells at certain levels, and always ignore passives.
    //Then go through talents, make sure to grab the row and column info - issue here with the fact some are passive
    //Go through pvp talents aswell - some also passive
    //then grab covenant abilities - replace the kyrian one with https://www.wowhead.com/item=177278/phial-of-serenity //doesnt work cause its an item
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
        found[1] in
        spellIds["Talents"][classtype][readableSpec.toUpperCase()]["Normal"]
      ) {
        console.log(`${spellName} already in talents for ${classtype}`);
      } else {
        spellIds["Talents"][classtype][readableSpec.toUpperCase()]["Normal"][
          found[1]
        ] = {
          spellId: found[1],
          spellName: spellName,
          row,
          col
        };
      }
    });

    let pvpTalentData;
    while (
      !pvpTalentData ||
      (pvpTalentData && Object.keys(pvpTalentData).length < 1)
    ) {
      sleep(500);
      await page.waitForSelector("div.talentcalc-pvp > div.iconmedium > a");
      await page.click("div.talentcalc-pvp > div.iconmedium > a");
      pvpTalentData = await page.evaluate(async () => {
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
    }
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
        found[1] in
        spellIds["Talents"][classtype][readableSpec.toUpperCase()]["PvP"]
      ) {
        console.log(`${spellName} already in PvP talents for ${classtype}`);
      } else {
        spellIds["Talents"][classtype][readableSpec.toUpperCase()]["PvP"][
          found[1]
        ] = {
          spellId: found[1],
          spellName: spellName
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
        const conflictingSpell = spellData.some(entry => {
          if (entry.spellId === spellId) {
            return false;
          }
          if (entry.isItPassive) {
            return false;
          }
          const isItBlacklisted = blacklistedSpells[classType].some(blSpell =>
            RegExp(blSpell).test(
              `${entry.abilityLearntLevel}${entry.doesItHaveAStar}:${entry.spellName}`
            )
          );
          if (isItBlacklisted) {
            return false;
          }
          if (entry.spellName === spellName) {
            if (entry.doesItHaveAStar) {
              return true;
            }
          }
          return false;
        });
        if (conflictingSpell) {
          return;
        }
        //If command pet add the corresponding spells
        if (found[1] === "272651") {
          [
            { id: "264667", name: "Primal Fury" },
            { id: "264735", name: "Survival of the Fittest" },
            { id: "53271", name: "Master's Call" }
          ].forEach(({ id, name }) => {
            if (id in spellIds["Spells"][classtype]) {
              spellIds["Spells"][classtype][id]["spec"].push(
                readableSpec.toUpperCase()
              );
            } else {
              spellIds["Spells"][classtype][id] = {
                spec: [readableSpec.toUpperCase()],
                spellId: id,
                spellName: name
              };
            }
          });
          return;
        }
        //If command demon add the corresponding spells
        if (found[1] === "119898") {
          [
            { id: "89808", name: "Singe Magic" },
            { id: "6358", name: "Seduction" },
            { id: "19647", name: "Spell Lock" }
          ].forEach(({ id, name }) => {
            if (id in spellIds["Spells"][classtype]) {
              spellIds["Spells"][classtype][id]["spec"].push(
                readableSpec.toUpperCase()
              );
            } else {
              spellIds["Spells"][classtype][id] = {
                spec: [readableSpec.toUpperCase()],
                spellId: id,
                spellName: name
              };
            }
          });
          if (readableSpec.toUpperCase() === "DEMONOLOGY") {
            spellIds["Spells"][classtype]["89766"] = {
              spec: [readableSpec.toUpperCase()],
              spellId: "89766",
              spellName: "Axe Toss"
            };
          }
          return;
        }
        if (found[1] in spellIds["Spells"][classtype]) {
          spellIds["Spells"][classtype][found[1]]["spec"].push(
            readableSpec.toUpperCase()
          );
        } else {
          spellIds["Spells"][classtype][found[1]] = {
            spec: [readableSpec.toUpperCase()],
            spellId: found[1],
            spellName: spellName
          };
        }
      }
    );
  }
  //We cut out hex, since we couldnt distinguish it from the other 8 hexs, so now we just add it in manually.
  //Earth shield is bugged as of this moment, its not included with talents for some reason
  if (classtype === "Shaman" && !("51514" in spellIds["Spells"]["Shaman"])) {
    spellIds["Spells"]["Shaman"]["51514"] = {
      spec: ["RESTORATION", "ELEMENTAL", "ENHANCEMENT"],
      spellId: "51514",
      spellName: "Hex"
    };
  }
  //ATM this is a talent, needs to be the actual spell id for resto, but i cant find that anywhere atm.
  if (classtype === "Shaman" && !("974" in spellIds["Spells"]["Shaman"])) {
    spellIds["Spells"]["Shaman"]["974"] = {
      spec: ["RESTORATION"],
      spellId: "974",
      spellName: "Earth Shield"
    };
  }
  if (
    classtype === "Demon Hunter" &&
    !("187827" in spellIds["Spells"]["Demon Hunter"])
  ) {
    spellIds["Spells"]["Demon Hunter"]["187827"] = {
      spec: ["VENGEANCE"],
      spellId: "187827",
      spellName: "Metamorphosis"
    };
    spellIds["Spells"]["Demon Hunter"]["191427"].spec = ["HAVOC"];
  }
  if (classtype === "Priest" && !("205448" in spellIds["Spells"]["Priest"])) {
    spellIds["Spells"]["Priest"]["205448"] = {
      spec: ["SHADOW"],
      spellId: "205448",
      spellName: "Void Bolt"
    };
  }
  if (
    classtype === "Warrior" &&
    !("317485" in spellIds["Covenants"]["Warrior"]["Venthyr"]) &&
    !("317349" in spellIds["Covenants"]["Warrior"]["Venthyr"])
  ) {
    spellIds["Covenants"]["Warrior"]["Venthyr"]["317485"] = {
      spec: ["FURY"],
      spellId: "317485",
      hidden: true
    };
    spellIds["Covenants"]["Warrior"]["Venthyr"]["317349"] = {
      spec: ["ARMS", "PROTECTION"],
      spellId: "317349",
      hidden: true
    };
    spellIds["Covenants"]["Warrior"]["Venthyr"]["317320"] = {
      spellId: "317320",
      idOfReplacedSpell: ["5308", "163201"],
      enabledSpells: ["317485", "317349"]
    };
  }
  if (
    classtype === "Shaman" &&
    "193876" in spellIds["Talents"]["Shaman"]["ENHANCEMENT"]["PvP"] &&
    !("204361" in spellIds["Talents"]["Shaman"]["ENHANCEMENT"]["PvP"]) &&
    !("204362" in spellIds["Talents"]["Shaman"]["ENHANCEMENT"]["PvP"])
  ) {
    spellIds["Talents"]["Shaman"]["ENHANCEMENT"]["PvP"]["204361"] = {
      spellId: "204361",
      spellName: "Bloodlust",
      hidden: true
    };
    spellIds["Talents"]["Shaman"]["ENHANCEMENT"]["PvP"]["204362"] = {
      spellId: "204362",
      spellName: "Bloodlust",
      hidden: true
    };
    spellIds["Talents"]["Shaman"]["ENHANCEMENT"]["PvP"]["193876"] = {
      ...spellIds["Talents"]["Shaman"]["ENHANCEMENT"]["PvP"]["193876"],
      idOfReplacedSpell: ["32182", "2825"],
      enabledSpells: ["204362", "204361"]
    };
  }
  page.close();
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
  1: "Kyrian",
  2: "Venthyr",
  3: "Night Fae",
  4: "Necrolord"
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
    "(19|10):Corpse Exploder",
    "27:Path of Frost",
    "29\\*:Raise Dead",
    "37:Control Undead"
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
    "(1|21):Flap",
    "10:Track Beasts",
    "10:Dreamwalk",
    "10:Strength of the Wild",
    "(19|10):Charm Woodland Creature",
    "22:Teleport: Moonglade",
    "24:Flight Form",
    "13:Sunfire"
  ],
  hunter: [
    "1:Volley",
    "1:Steel Trap",
    "1:Bestial Wrath",
    "1:Death Chakram",
    "5:Beast Lore",
    "5:Call Pet 1",
    "5:Dismiss Pet",
    "5:Feed Pet",
    "5:Tame Beast",
    "(10|6):Wake Up",
    "10:Call Pet 2",
    "12:Chakrams",
    "17:Call Pet 3",
    "(19|10):Aspect of the Chameleon",
    "(19|10):Fireworks",
    "(19|10):Play Dead",
    "41:Call Pet 4",
    "43:Eagle Eye",
    "(10|47):Fetch",
    "48:Call Pet 5"
  ],
  mage: [
    "1:Polymorph",
    "1:Shoot",
    "(1|10):Illusion",
    "(1|10|11|21|23|24|25|28|32|52|58):(Ancient )?(Portal|Teleport): .*",
    "5:Conjure Refreshments",
    "(21|11):Teleport",
    "24:Portal",
    "17:Conjure Mana Gem",
    "25:Polymorph",
    "32\\*:Fire Blast"
  ],
  monk: [
    "1\\*:Spinning Crane Kick",
    "10:Soothing Mist",
    "11:Zen Pilgrimage",
    "17:Touch of Fatality",
    "(37|30):Zen Flight"
  ],
  paladin: [
    "1\\*:Judgment",
    "3\\*:Judgment",
    "1:Tyr's Deliverance",
    "1:Crusader's Direhorn",
    "(1):Summon .*",
    "(19|10):Contemplation",
    "54:Sense Undead"
  ],
  priest: ["1:Shoot", "22:Mind Vision"],
  rogue: [
    "(1|10):Detection",
    "(24|14):Pick Lock",
    "24:Pick Pocket",
    "1:Sinister Strike"
  ],
  shaman: [
    "1:Surge of Earth",
    "1:Fae Transfusion",
    "1:Primordial Wave",
    "14:Far Sight",
    "32:Astral Recall",
    "41:Hex"
  ],
  warlock: [
    "1:Dreadsteed",
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

async function runScript() {
  const browser = await puppeteer.launch();
  const mutex = new Mutex();

  for (let k = 0; k < classes.length; k++) {
    promises.push(scrapeSpell(classes[k], browser, mutex, 12000 * k));
  }

  Promise.all(promises).then(() => {
    let jsonToWrite = JSON.stringify(spellIds);
    fs.writeFileSync(`SpellsPhase1NEW.json`, jsonToWrite);
    browser.close();
  });
}

runScript();
