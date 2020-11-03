const puppeteer = require("puppeteer");
const Mutex = require("async-mutex").Mutex;
const fs = require("fs");
const _ = require("lodash");
const spellData = require("./SpellsPhase1.json");
const maxPages = 28;
const promises = [];
const cachedIds = {};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

//Type is incase Spells/Talents/PvPTalents/Covenants produces a different type of datastorage -- might not need here
async function getDetails(spellId, browser, className, spellName, type, mutex) {
  let newDataForId;
  const release = await mutex.acquire();
  if (!(spellId in cachedIds)) {
    let page;
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
    let pageSpellData;
    while (didTimeout) {
      try {
        await page.goto(`https://wowhead.com/spell=${spellId}`, {
          timeout: 30000 + 5000 * timeoutCounter
        });
        //could also grab rank 2/3/4 of spells to check if they add durations /reduce cds
        pageSpellData = await page.evaluate(() => {
          let datas = {};
          datas["Description"] = Array.from(document.querySelectorAll("span.q"))
            .map(e => e.textContent)
            .join(" ");
          const isRechargeCooldown = document
            .querySelector(
              `#tt${
                document.URL.match(/\d+/)[0]
              } > table > tbody > tr:nth-child(1) > td > table:nth-child(1) > tbody > tr > td`
            )
            .textContent.match(/(\d\d?\.?\d?\d?) (\w+) recharge/);
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
        //process
        newDataForId = filterData(pageSpellData, spellId, spellName);
        console.log(
          `${Object.keys(cachedIds).length + 1}/${promises.length} finished`
        );
        cachedIds[spellId] = newDataForId;
        didTimeout = false;
      } catch (e) {
        console.log(`Timeout on ${spellId}`, e);
        didTimeout = !!timeoutCounter % 3;
        timeoutCounter++;
      }
    }
    await page.close();
  } else {
    console.log(spellId, cachedIds);
    newDataForId = cachedIds[spellId];
  }
  if (newDataForId) {
    spellData["Spells"][className][spellId] = {
      ...spellData["Spells"][className][spellId],
      ...newDataForId
    };
  }
}

function filterData(pageSpellData, spellId, spellName) {
  let newDataForId = {};
  const doesIncludeSelf = pageSpellData["Range"].includes("Self");
  const isInPartyOrRaid = pageSpellData["Description"].includes(
    "party or raid, all party and raid"
  );
  const isAroundOrInfront = /nearby enemies[^.]|(enemies|targets [\w ]+) in front of you/.test(
    pageSpellData["Description"]
  );
  const summonNotEngageNoRadius =
    /Calls forth|Summon/.test(pageSpellData["Description"]) &&
    pageSpellData["Flags"] &&
    pageSpellData["Flags"].includes("Does not engage target") &&
    Object.keys(pageSpellData)
      .filter(topics => topics.includes("Effect"))
      .some(details => !pageSpellData[details].includes("Radius"));
  let doesIncludeRadius = false;
  if (!spellsThatArntPlacedButMatch.includes(spellId)) {
    doesIncludeRadius = Object.keys(pageSpellData)
      .filter(topics => topics.includes("Effect"))
      .some(details =>
        /^(Create Area Trigger|Dummy|Trigger Missile|School Damage|Distract).*Radius/.test(
          pageSpellData[details]
        )
      );
  }
  const isAoeSpeedBoost = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(
      details =>
        /Apply Aura: Increase Run Speed.*Radius/.test(pageSpellData[details]) &&
        !/target location/.test(pageSpellData["Description"])
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
  const maxTargOne =
    !!pageSpellData["Max targets"] &&
    pageSpellData["Max targets"].includes("1");
  //TODO Add in changes from ranks at somepoint
  const durMatchVals = pageSpellData["Duration"].match(
    /(\d\d?\.?\d?\d?) (?:(min)|(sec))/
  );
  const descDurMatch = pageSpellData.Description.match(
    /(\d\d?\.?\d?\d?) (?:(min)|(sec))/
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
      : /stuns/.test(pageSpellData["Description"])
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
  const doesItSD = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details => pageSpellData[details].includes("School Damage"));
  const doesItRC = pageSpellData["Range"].includes("Combat");
  const descDmg = pageSpellData["Description"].includes("damage");
  const doesItNegMech = negativeMechanics.includes(pageSpellData["Mechanic"]);
  const isTaunt = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details => pageSpellData[details].includes("Taunt"));
  const isDispel = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details => /Dispel|Spell Steal/.test(pageSpellData[details]));
  if (
    doesIncludeSelf ||
    isInPartyOrRaid ||
    isAroundOrInfront ||
    summonNotEngageNoRadius ||
    isMassRez ||
    isAoeSpeedBoost
  ) {
    //Self
    newDataForId["targetType"] = targetTypes[0];
  } else if (doesIncludeRadius) {
    //Placed
    newDataForId["targetType"] = targetTypes[1];
  } else if (doesIncludeHealingAndDamage) {
    //One Any
    newDataForId["targetType"] = targetTypes[2];
  } else if (
    !doesItNegMech &&
    (doesIncludeHealingInEffect ||
      ftInDesc ||
      porInDesc ||
      allyInDesc ||
      healThemInDesc ||
      isRez ||
      healTargInDesc) &&
    (oneTarAtATime || flagsOneTarg || maxTargOne || durLtCd)
  ) {
    //One Friendly
    newDataForId["targetType"] = targetTypes[3];
  } else if (
    !doesItNegMech &&
    (doesIncludeHealingInEffect ||
      ftInDesc ||
      porInDesc ||
      allyInDesc ||
      healThemInDesc ||
      isRez ||
      healTargInDesc) &&
    durGtCd
  ) {
    //Many Friendly
    newDataForId["targetType"] = targetTypes[4];
  } else if (
    (oneTarAtATime || flagsOneTarg || maxTargOne || durLtCd) &&
    (doesItNWD ||
      doesItRC ||
      doesItSD ||
      doesItTM ||
      descEnemy ||
      descDmg ||
      doesItNegMech ||
      isTaunt ||
      isDispel)
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
      isDispel)
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
  "Asleep"
];

//Hand of guldan, maim, starfire, necrotic strike
const spellsThatArntPlacedButMatch = ["105174", "22570", "194153", "223829"];

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
            "Spell",
            mutex
          )
        );
      } else {
        delete spellData["Spells"][classNames[className]][spellIds[spellId]];
      }
    }
  }
}

const brokenSpells = [
  46585,
  49028,
  111673,
  781,
  136,
  257284,
  321297,
  19577,
  193530,
  186289,
  115546,
  119996,
  324312,
  34433,
  453,
  10060,
  64901,
  315496,
  36554,
  195457,
  755,
  1714,
  48018,
  48020,
  111771,
  104316
];
const incorrectSpells = [
  47541,
  49998,
  206930,
  195182,
  108199,
  49184,
  55090,
  77575,
  212084,
  109304,
  19574,
  2643,
  257620,
  264735,
  266779,
  121253,
  132578,
  115450,
  218164,
  527,
  605,
  47536,
  32375,
  34861,
  64843,
  228260,
  32645,
  29722,
  5740,
  30283,
  1122,
  324536,
  196277,
  265187,
  34428,
  7384
];

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
  for (const className in classNames) {
    const spellIds = Object.keys(
      calculatedData["Spells"][classNames[className]]
    );
    for (const spellId in spellIds) {
      if (
        _.isEqual(
          targetData["Spells"][classNames[className]][spellIds[spellId]],
          calculatedData["Spells"][classNames[className]][spellIds[spellId]]
        )
      ) {
        console.log(
          `${calculatedData["Spells"][classNames[className]][spellIds[spellId]].spellName}, Spell ID: ${spellIds[spellId]} Now Equal`
        );
      }
    }
  }
}

const testingWorkingKey = false;

async function runAllThings() {
  const browser = await puppeteer.launch();
  const mutex = new Mutex();
  runSpells(browser, mutex);
  // runTalents(browser);
  // runPvPTalents(browser);
  // runCovenants(browser);

  Promise.all(promises).then(() => {
    let jsonToWrite = JSON.stringify(spellData);
    const testWorkingDataReal = require("./SpellsPhase2AllSpellsWorkingKey.json");
    const brokeSpellsFixedKey = require("./SpellsPhase2AllBrokenSpellsFIXED.json");
    if (testingWorkingKey) {
      if (!_.isEqual(testWorkingDataReal, spellData)) {
        findDifferences(testWorkingDataReal, spellData);
      }
    } else {
      checkForImprovements(brokeSpellsFixedKey, spellData);
      //fs.writeFileSync(`SpellsPhase2AllBrokenSpells.json`, jsonToWrite);
    }
    browser.close();
  });
}
runAllThings();
