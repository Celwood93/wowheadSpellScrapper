const puppeteer = require("puppeteer");
const Mutex = require("async-mutex").Mutex;
const fs = require("fs");
const _ = require("lodash");
const spellData = require("./SpellsPhase1.json");
const maxPages = 28;
const promises = [];
const cachedIds = {};
const cachedData = require("./CachedPageSpellData.json");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

//Type is incase Spells/Talents/PvPTalents/Covenants produces a different type of datastorage -- might not need here
async function getDetails(
  spellId,
  browser,
  className,
  spellName,
  type,
  spec,
  mutex
) {
  let newDataForId;
  let pageSpellData;
  let usingCache = false;
  const release = await mutex.acquire();
  if (!(spellId in cachedIds)) {
    let page;
    if (!(spellId in cachedData)) {
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
      let timeoutCounter = 1;
      let didTimeout = true;
      while (didTimeout) {
        try {
          await page.goto(`https://wowhead.com/spell=${spellId}`, {
            timeout: 30000 + 5000 * timeoutCounter
          });
          //could also grab rank 2/3/4 of spells to check if they add durations /reduce cds
          pageSpellData = await page.evaluate(() => {
            let datas = {};
            datas["Description"] = Array.from(
              document.querySelectorAll("span.q")
            )
              .map(e => e.textContent)
              .join(" ");
            const isRechargeCooldown = document
              .querySelector(
                `#tt${
                  document.URL.match(/\d+/)[0]
                } > table > tbody > tr:nth-child(1) > td > table:nth-child(1) > tbody > tr > td`
              )
              .textContent.match(/(\d\d?\.?\d?\d?) (\w+) recharge/);
            const iconId = document
              .querySelector("ul>li.icon-db-link>div>a")
              .textContent.replace(/\s/g, "");
            datas["iconId"] = iconId;
            const correctPhraseForSpellReplace = document.querySelector(
              "table>tbody>tr>td>span.q"
            );
            const replaceSpell = document.querySelector(
              "table>tbody>tr>td>span.q>a"
            );
            if (
              correctPhraseForSpellReplace &&
              /^Replaces /.test(correctPhraseForSpellReplace.textContent) &&
              replaceSpell &&
              replaceSpell.href
            ) {
              const didMatch = replaceSpell.href.match(/spell=(\d+)/);
              if (didMatch && didMatch[1]) {
                datas["idOfReplacedSpell"] = didMatch[1];
              }
            }
            Array.from(document.querySelectorAll("#spelldetails > tbody > tr"))
              .map(el => {
                const tharr = Array.from(
                  el.querySelectorAll(
                    "th:not(.grid-hideable-cell):not(.grid-nesting-wrapper)"
                  )
                ).flat();
                const tdarr = Array.from(
                  el.querySelectorAll(
                    "td:not(.grid-hideable-cell):not(.grid-nesting-wrapper)"
                  )
                ).flat();
                return tharr.forEach((e, i) => {
                  if (e.textContent === "Flags") {
                    datas[e.textContent] = Array.from(
                      tdarr[i].querySelectorAll("li")
                    ).map(el => el.textContent);
                  } else {
                    datas[e.textContent] = tdarr[i].textContent;
                  }
                });
              })
              .flat();
            if (isRechargeCooldown) {
              datas.Cooldown = `${isRechargeCooldown[1]} ${
                isRechargeCooldown[2]
              }`;
            }
            return datas;
          });
          cachedData[spellId] = pageSpellData;
          //process
          didTimeout = false;
        } catch (e) {
          console.log(`Timeout on ${spellId}`, e);
          didTimeout = !!timeoutCounter % 3;
          timeoutCounter++;
        }
      }
    } else {
      release();
      usingCache = true;
      pageSpellData = cachedData[spellId];
    }
    if (pageSpellData) {
      newDataForId = filterData(pageSpellData, spellId, spellName);
      if (!usingCache) {
        console.log(
          `${Object.keys(cachedIds).length + 1}/${promises.length} finished`
        );
      }
      if (Object.keys(druidAffinities).includes(spellId)) {
        newDataForId = {
          ...newDataForId,
          enabledSpells: druidAffinities[spellId]
        };
      }
      cachedIds[spellId] = newDataForId;
    }
    if (page) {
      await page.close();
    }
  } else {
    newDataForId = cachedIds[spellId];
    release();
  }
  if (newDataForId) {
    if (type === "Spells") {
      spellData["Spells"][className][spellId] = {
        ...spellData["Spells"][className][spellId],
        ...newDataForId
      };
    } else if (type === "Talents") {
      spellData["Talents"][className][spec]["Normal"][spellId] = {
        ...spellData["Talents"][className][spec]["Normal"][spellId],
        ...newDataForId
      };
    }
  }
}

function filterData(pageSpellData, spellId, spellName) {
  let newDataForId = {};
  const isPassive =
    pageSpellData["Flags"] &&
    pageSpellData["Flags"].some(e => /Passive spell/.test(e));
  const doesIncludeSelf = pageSpellData["Range"].includes("Self");
  const isUnlimitedRange = pageSpellData["Range"].includes(
    "Anywhere - Unlimited"
  );
  const isPetOrDemon =
    /your pet|your summoned Demon/.test(pageSpellData["Description"]) &&
    !/enemy|your target|the target/.test(pageSpellData["Description"]);
  const isInPartyOrRaid = /party or raid, all party and raid/.test(
    pageSpellData["Description"]
  );
  const isRaidWideCooldown = /[hH]eals all (party or raid members|allies)/.test(
    pageSpellData["Description"]
  );
  const allHealersInRaid = /all healers in your party or raid/.test(
    pageSpellData["Description"]
  );
  const givesAttackSpeedSteroid = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details =>
      /Apply Aura: Mod Attack Speed %[^-]*\d\d/.test(pageSpellData[details])
    );
  const isAroundOrInfront = /(enemies|targets [\w ]+|enemies directly) in front of you/.test(
    pageSpellData["Description"]
  );
  const aroundShortRange =
    / nearby enemies/.test(pageSpellData["Description"]) &&
    /\(Vision\)|(8|5) yards/.test(pageSpellData["Range"]);
  const teleportOrTransfer = /swap locations|Teleports you/.test(
    pageSpellData["Description"]
  );
  const canSummon = /Calls forth|Summon|^Raises/.test(
    pageSpellData["Description"]
  );
  const doesntEngage =
    pageSpellData["Flags"] &&
    pageSpellData["Flags"].some(e => /Does not engage target/.test(e));
  let doesIncludeRadius = false;
  if (!spellsThatArntPlacedButMatch.includes(spellId)) {
    doesIncludeRadius = Object.keys(pageSpellData)
      .filter(topics => topics.includes("Effect"))
      .some(details =>
        /^(Create Area Trigger|Dummy|Trigger Missile|School Damage|Distract|Dispel|Persistent Area Aura|Apply Aura: Stun).*Radius/.test(
          pageSpellData[details]
        )
      );
  }
  const descTargLoc = /(to the|at a) target location/.test(
    pageSpellData["Description"]
  );
  const isAoeSpeedBoost = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(
      details =>
        /Apply Aura: Increase Run Speed.*Radius/.test(pageSpellData[details]) &&
        !/target location/.test(pageSpellData["Description"])
    );
  const doesOverrideSpell = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details =>
      /Apply Aura: Overrides Actionbar Spell/.test(pageSpellData[details])
    );
  const isMassRez = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details => pageSpellData[details].includes("Mass Resurrection"));
  const isRez = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details => /^Resurrect/.test(pageSpellData[details]));
  const doesIncludeHealingAndDamage =
    /damage to an enemy/.test(pageSpellData["Description"]) &&
    /healing to an ally/.test(pageSpellData["Description"]);
  const doesIncludeHealingInEffect = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details =>
      /Periodic Heal|Heal\b|Healing\b/.test(pageSpellData[details])
    );
  const ftInDesc = /friendly (target|healer)/.test(
    pageSpellData["Description"]
  );
  const porInDesc = /party or raid member|group member/.test(
    pageSpellData["Description"]
  );
  const attackInDesc = /attack/.test(pageSpellData["Description"]);
  const allyInDesc = /\bally\b|\ballies\b/.test(pageSpellData["Description"]);
  const healThemInDesc = /healing them/.test(pageSpellData["Description"]);
  const healTargInDesc = /healing the target/.test(
    pageSpellData["Description"]
  );
  const oneTarAtATime = /one target at a time/.test(
    pageSpellData["Description"]
  );
  const flagsOneTarg =
    !!pageSpellData["Flags"] &&
    pageSpellData["Flags"].some(e =>
      e.includes("The aura can only affect one target")
    );
  const isRequireUntapped =
    !!pageSpellData["Flags"] &&
    pageSpellData["Flags"].some(e => e.includes("Requires untapped target"));
  const maxTargOne =
    !!pageSpellData["Max targets"] &&
    pageSpellData["Max targets"].includes("1");
  //TODO Add in changes from ranks at somepoint
  const durMatchVals = pageSpellData["Duration"].match(
    /(\d\d?\.?\d?\d?) (?:(min)|(sec))/
  );
  const descDurMatch = pageSpellData.Description.match(
    /(?:[^%] for|over) (\d\d?\.?\d?\d?) (?:(min)|(sec))/
  );
  const cdMatch = pageSpellData["Cooldown"].match(
    /(\d\d?\.?\d?\d?) (?:(min)|(sec))/
  );
  //TODO Add in changes from ranks at somepoint
  let dur;
  if (durMatchVals) {
    if (durMatchVals[2]) {
      dur = durMatchVals[1] * 60;
    } else {
      dur = durMatchVals[1];
    }
  } else if (pageSpellData["Duration"].includes("Channeled")) {
    dur = -1;
  } else if (descDurMatch) {
    if (descDurMatch[2]) {
      dur = descDurMatch[1] * 60;
    } else {
      dur = descDurMatch[1];
    }
  } else if (pageSpellData["Duration"].includes("n/a")) {
    dur = -1;
  } else {
    dur = 0;
  }
  //Spellsteal includes a time in the description, i think its the only spell that does.
  if (spellId === "30449") {
    dur = -1;
  }
  const cd = cdMatch ? (cdMatch[2] ? cdMatch[1] * 60 : cdMatch[1]) : 0;
  const gcdAdd = /\d\d?\.?\d?/.test(pageSpellData["GCD"])
    ? pageSpellData["GCD"].match(/\d\d?\.?\d?/)[0]
    : 0;
  const castTimeAdd = /\d\d?\.\d?\d?/.test(pageSpellData["Cast time"])
    ? pageSpellData["Cast time"].match(/\d\d?\.?\d?/)[0]
    : /Channeled/.test(pageSpellData["Cast time"])
    ? dur
    : 0;
  const cdRealistic = (1 * cd + 1 * gcdAdd + 1 * castTimeAdd) * 1.5;
  const durLtCd = 1 * dur < 1 * cdRealistic;
  const durGtCd = 1 * dur > 1 * cdRealistic;
  if (!negativeMechanics.includes(pageSpellData["Mechanic"])) {
    Object.keys(pageSpellData)
      .filter(topics => topics.includes("Effect"))
      .some(details => pageSpellData[details].includes("Interrupt"))
      ? (pageSpellData["Mechanic"] = "Interrupted")
      : /interrupt/.test(pageSpellData["Description"])
      ? (pageSpellData["Mechanic"] = "Interrupted")
      : 0;
    Object.keys(pageSpellData)
      .filter(topics => topics.includes("Effect"))
      .some(details => pageSpellData[details].includes("Stun"))
      ? (pageSpellData["Mechanic"] = "Stunned")
      : /stuns|stunning/.test(pageSpellData["Description"])
      ? (pageSpellData["Mechanic"] = "Stunned")
      : 0;
    Object.keys(pageSpellData)
      .filter(topics => topics.includes("Effect"))
      .some(details => pageSpellData[details].includes("Fear"))
      ? (pageSpellData["Mechanic"] = "Disoriented")
      : /disorient/.test(pageSpellData["Description"])
      ? (pageSpellData["Mechanic"] = "Disoriented")
      : 0;
  }
  const doesItTM = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details => pageSpellData[details].includes("Trigger Missle"));
  const descEnemy = pageSpellData["Description"].includes("enemy");
  const doesItNWD = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details =>
      pageSpellData[details].includes("Normalized Weapon Damage")
    );
  //TODO maybe find better way to do these - right now not enough similar spells to justfy more specific stuff. Might change when we do talents
  const isPowerInfusion = spellName === "Power Infusion";
  const isCurseOfTongues = spellName === "Curse of Tongues";
  const isDemonicGateway = spellName === "Demonic Gateway";
  const isOneAnyException =
    spellName === "Shadowstep" ||
    spellName === "Wild Charge" ||
    spellName === "Death Coil" ||
    spellName === "Gorefiend's Grasp";
  const isSelfException =
    spellName === "Summon Demonic Tyrant" || spellName === "Malefic Rapture";
  const isRapture = spellName === "Rapture";
  const doesItSD = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details => pageSpellData[details].includes("School Damage"));
  const doesItRC = pageSpellData["Range"].includes("Combat");
  const descDmg = pageSpellData["Description"].includes("damage");
  const doesItNegMech = negativeMechanics.includes(pageSpellData["Mechanic"]);
  const isTaunt =
    Object.keys(pageSpellData)
      .filter(topics => topics.includes("Effect"))
      .some(details => pageSpellData[details].includes("Taunt")) ||
    pageSpellData["Description"].includes("Taunts");
  const isDispel = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details => /Dispel|Spell Steal/.test(pageSpellData[details]));
  const isFriendlyDispel = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details =>
      /Dispel\s\((Curse|Disease|Poison)\)/.test(pageSpellData[details])
    );
  const isStalked = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details => /Apply Aura: Stalked/.test(pageSpellData[details]));
  const isWeaponRequired =
    pageSpellData["Flags"] &&
    pageSpellData["Flags"].some(e => e.includes("Requires main hand weapon"));

  if (pageSpellData.idOfReplacedSpell) {
    newDataForId = {
      ...newDataForId,
      idOfReplacedSpell: pageSpellData["idOfReplacedSpell"]
    };
  }
  if (pageSpellData.iconId) {
    newDataForId = {
      ...newDataForId,
      iconId: pageSpellData["iconId"]
    };
  } else {
    console.log(`failed to find icon id for ${spellId} ${spellName}`);
  }
  if (isPassive) {
    newDataForId["isPassive"] = true;
  } else if (
    doesIncludeSelf ||
    isInPartyOrRaid ||
    isAroundOrInfront ||
    aroundShortRange ||
    (canSummon && doesntEngage) ||
    isMassRez ||
    isAoeSpeedBoost ||
    isUnlimitedRange ||
    isPetOrDemon ||
    doesOverrideSpell ||
    teleportOrTransfer ||
    allHealersInRaid ||
    givesAttackSpeedSteroid ||
    isRaidWideCooldown ||
    isSelfException
  ) {
    //Self
    newDataForId["targetType"] = targetTypes[0];
  } else if (doesIncludeRadius || descTargLoc || isDemonicGateway) {
    //Placed
    newDataForId["targetType"] = targetTypes[1];
  } else if (doesIncludeHealingAndDamage || isOneAnyException) {
    //One Any
    newDataForId["targetType"] = targetTypes[2];
  } else if (
    !doesItNegMech &&
    ((doesIncludeHealingInEffect && !doesItRC) ||
      ftInDesc ||
      porInDesc ||
      allyInDesc ||
      healThemInDesc ||
      isRez ||
      healTargInDesc ||
      isPowerInfusion ||
      isFriendlyDispel ||
      isRapture) && //not sure how else to catch it, its too unique
    (oneTarAtATime || flagsOneTarg || maxTargOne || durLtCd)
  ) {
    //One Friendly
    newDataForId["targetType"] = targetTypes[3];
  } else if (
    !doesItNegMech &&
    ((doesIncludeHealingInEffect && !doesItRC) ||
      ftInDesc ||
      porInDesc ||
      allyInDesc ||
      healThemInDesc ||
      isRez ||
      healTargInDesc ||
      isFriendlyDispel) &&
    durGtCd
  ) {
    //Many Friendly
    newDataForId["targetType"] = targetTypes[4];
  } else if (
    (oneTarAtATime ||
      flagsOneTarg ||
      maxTargOne ||
      durLtCd ||
      isRequireUntapped) &&
    (doesItNWD ||
      doesItRC ||
      doesItSD ||
      doesItTM ||
      descEnemy ||
      descDmg ||
      doesItNegMech ||
      isTaunt ||
      isDispel ||
      isWeaponRequired ||
      isStalked ||
      isRequireUntapped ||
      attackInDesc)
  ) {
    //One Enemy
    newDataForId["targetType"] = targetTypes[5];
  } else if (
    durGtCd &&
    (doesItNWD ||
      doesItRC ||
      doesItSD ||
      doesItTM ||
      descEnemy ||
      descDmg ||
      doesItNegMech ||
      isTaunt ||
      isDispel ||
      isWeaponRequired ||
      isStalked ||
      isRequireUntapped ||
      attackInDesc ||
      isCurseOfTongues)
  ) {
    //Many Enemy
    newDataForId["targetType"] = targetTypes[6];
  } else {
    console.log(`Failed to work for ${spellId} - ${spellName}`);
  }

  return newDataForId;
}
const targetTypes = [
  "SELF",
  "PLACED",
  "ONE_ANY",
  "ONE_FRIENDLY",
  "MANY_FRIENDLY",
  "ONE_ENEMY",
  "MANY_ENEMY"
];

const negativeMechanics = [
  "Stunned",
  "Snared",
  "Disoriented",
  "Polymorphed",
  "Rooted",
  "Interrupted",
  "Banished",
  "Asleep",
  "Charmed"
];

//Hand of guldan, maim, starfire, necrotic strike, howling blast, scourge strike, multishot, kegsmash, voidEruption, incinerate, solarBeam, implosion
const spellsThatArntPlacedButMatch = [
  "105174",
  "22570",
  "194153",
  "223829",
  "49184",
  "55090",
  "257620",
  "2643",
  "121253",
  "228260",
  "29722",
  "78675",
  "196277"
];

async function runSpells(browser, mutex) {
  const classNames = Object.keys(spellData["Spells"]);
  for (const className in classNames) {
    const spellIds = Object.keys(spellData["Spells"][classNames[className]]);
    for (const spellId in spellIds) {
      const spellName =
        spellData["Spells"][classNames[className]][spellIds[spellId]].spellName;
      let isAllowedSpell;
      if (testingWorkingKey) {
        isAllowedSpell = !brokenSpells
          .concat(incorrectSpells)
          .includes(spellIds[spellId] * 1);
      } else {
        isAllowedSpell = brokenSpells
          .concat(incorrectSpells)
          .includes(spellIds[spellId] * 1);
      }

      if (isAllowedSpell) {
        promises.push(
          getDetails(
            spellIds[spellId],
            browser,
            classNames[className],
            spellName,
            "Spells",
            "",
            mutex
          )
        );
      } else {
        delete spellData["Spells"][classNames[className]][spellIds[spellId]];
      }
    }
  }
}

async function runTalents(browser, mutex) {
  const classNames = Object.keys(spellData["Talents"]);
  for (const className in classNames) {
    const specNames = Object.keys(spellData["Talents"][classNames[className]]);
    for (const specName in specNames) {
      const spellIds = Object.keys(
        spellData["Talents"][classNames[className]][specNames[specName]][
          "Normal"
        ]
      );
      for (spellId in spellIds) {
        const spellName =
          spellData["Talents"][classNames[className]][specNames[specName]][
            "Normal"
          ][spellIds[spellId]].spellName;
        let isAllowedSpell;
        if (testingWorkingKey) {
          isAllowedSpell = !brokenSpells
            .concat(incorrectSpells)
            .includes(spellIds[spellId] * 1);
        } else {
          isAllowedSpell = brokenSpells
            .concat(incorrectSpells)
            .includes(spellIds[spellId] * 1);
        }

        if (isAllowedSpell) {
          promises.push(
            getDetails(
              spellIds[spellId],
              browser,
              classNames[className],
              spellName,
              "Talents",
              specNames[specName],
              mutex
            )
          );
        } else {
          delete spellData["Talents"][classNames[className]][
            specNames[specName]
          ]["Normal"][spellIds[spellId]];
        }
      }
    }
  }
}

const brokenSpells = [];
const incorrectSpells = [];

async function findDifferences(trueData, newData) {
  const classNames = Object.keys(trueData["Spells"]);
  for (const className in classNames) {
    const spellIds = Object.keys(trueData["Spells"][classNames[className]]);
    for (const spellId in spellIds) {
      if (
        !_.isEqual(
          trueData["Spells"][classNames[className]][spellIds[spellId]],
          newData["Spells"][classNames[className]][spellIds[spellId]]
        )
      ) {
        console.log(
          `${trueData["Spells"][classNames[className]][spellIds[spellId]].spellName} Not Equal`,
          trueData["Spells"][classNames[className]][spellIds[spellId]],
          newData["Spells"][classNames[className]][spellIds[spellId]]
        );
      }
    }
  }
}

function checkForImprovements(targetData, calculatedData) {
  const classNames = Object.keys(calculatedData["Spells"]);
  let spellsLength = 0;
  let spellsWorkingLength = 0;
  for (const className in classNames) {
    const spellIds = Object.keys(
      calculatedData["Spells"][classNames[className]]
    );
    spellsLength += spellIds.length;
    for (const spellId in spellIds) {
      if (
        _.isEqual(
          targetData["Spells"][classNames[className]][spellIds[spellId]],
          calculatedData["Spells"][classNames[className]][spellIds[spellId]]
        )
      ) {
        spellsWorkingLength++;
        console.log(
          `${calculatedData["Spells"][classNames[className]][spellIds[spellId]].spellName}, Spell ID: ${spellIds[spellId]} Now Equal With ${calculatedData["Spells"][classNames[className]][spellIds[spellId]].targetType}`
        );
      }
    }
  }
  console.log(`${spellsWorkingLength}/${spellsLength} now work`);
}
//Feral(rake, rip, swipe, maim), Guardian(thrash, frenzied regeneration, incapacitating roar),
// Resto(rejuv, swiftmend, wild growth, ursols vortex), Balance(moonkin form, starsurge, starfire, sunfire, typhoon)
const druidAffinities = {
  197490: ["1822", "1079", "213764", "22570"],
  197491: ["106832", "22842", "99"],
  197492: ["774", "18562", "48438", "102793"],
  197488: ["24858", "78674", "194153", "93402", "132469"]
};

const testingWorkingKey = true;

async function runAllThings() {
  const browser = await puppeteer.launch();
  const mutex = new Mutex();
  runSpells(browser, mutex);
  runTalents(browser, mutex);
  // runPvPTalents(browser, mutex);
  // runCovenants(browser, mutex);

  Promise.all(promises).then(async () => {
    let jsonToWrite = JSON.stringify(spellData);
    //const testWorkingDataReal = require("./SpellsPhase2AllSpellsWorkingKey.json");
    // const brokeSpellsFixedKey = require("./SpellsPhase2AllBrokenSpellsFIXED.json");
    const stringifiedOldCachedData = await fs.readFileSync(
      "./CachedPageSpellData.json"
    );
    const oldCachedData = JSON.parse(stringifiedOldCachedData);
    if (!_.isEqual(oldCachedData, cachedData)) {
      console.log("Cached Data updating");
      fs.writeFileSync(
        `./CachedPageSpellData.json`,
        JSON.stringify(cachedData)
      );
    }
    if (testingWorkingKey) {
      fs.writeFileSync(`SpellsPhase2AllSpellsWorkingKey.json`, jsonToWrite);
      // if (!_.isEqual(testWorkingDataReal, spellData)) {
      //   findDifferences(testWorkingDataReal, spellData);
      // }
    } else {
      checkForImprovements(brokeSpellsFixedKey, spellData);
      fs.writeFileSync(`SpellsPhase2AllBrokenSpells.json`, jsonToWrite);
    }
    browser.close();
  });
}
runAllThings();
