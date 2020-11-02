const puppeteer = require("puppeteer");
const Mutex = require("async-mutex").Mutex;
const fs = require("fs");
const _ = require("lodash");
const spellData = require("./SpellsPhase1Test.json"); //for testing atm
const maxPages = 28;
const promises = [];
const cachedIds = {};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

//Type is incase Spells/Talents/PvPTalents/Covenants produces a different type of datastorage -- might not need here
async function getDetails(spellId, browser, className, spellName, type, mutex) {
  let newDataForId;
  if (!(spellId in cachedIds)) {
    const release = await mutex.acquire();
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
        newDataForId = filterData(pageSpellData, spellId);
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
    spellData["Spells"][className][spellName] = {
      ...spellData["Spells"][className][spellName],
      ...newDataForId
    };
  }
}

function filterData(pageSpellData, spellId) {
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
    console.log(pageSpellData);
    console.log(`Failed to work for ${spellId}`);
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
  "Banished"
];

//Hand of guldan, maim, starfire, necrotic strike
const spellsThatArntPlacedButMatch = ["105174", "22570", "194153", "223829"];

async function runSpells(browser, mutex) {
  const classNames = Object.keys(spellData["Spells"]);
  for (const className in classNames) {
    const spellNames = Object.keys(spellData["Spells"][classNames[className]]);
    for (const spellName in spellNames) {
      if (true) {
        const spellId =
          spellData["Spells"][classNames[className]][spellNames[spellName]]
            .spellId;
        if (!brokenSpells.concat(incorrectSpells).includes(spellId * 1)) {
          promises.push(
            getDetails(
              spellId,
              browser,
              classNames[className],
              spellNames[spellName],
              "Spell",
              mutex
            )
          );
        } else {
          delete spellData["Spells"][classNames[className]][
            spellNames[spellName]
          ];
        }
      }
    }
  }
}

const brokenSpells = [];
const incorrectSpells = [
  30449,
  48438,
  106898,
  212040,
  33786,
  213764,
  22570,
  194153,
  78675,
  11366,
  44614,
  5143,
  53600,
  212056,
  212048,
  98008,
  198067,
  187874
];

async function findDifferences(trueData, newData) {
  const classNames = Object.keys(trueData["Spells"]);
  for (const className in classNames) {
    const spellNames = Object.keys(trueData["Spells"][classNames[className]]);
    for (const spellName in spellNames) {
      if (
        !_.isEqual(
          trueData["Spells"][classNames[className]][spellNames[spellName]],
          newData["Spells"][classNames[className]][spellNames[spellName]]
        )
      ) {
        console.log(
          `${spellNames[spellName]} Not Equal`,
          trueData["Spells"][classNames[className]][spellNames[spellName]],
          newData["Spells"][classNames[className]][spellNames[spellName]]
        );
      }
    }
  }
}

async function runAllThings() {
  const browser = await puppeteer.launch();
  const mutex = new Mutex();
  runSpells(browser, mutex);
  // runTalents(browser);
  // runPvPTalents(browser);
  // runCovenants(browser);
  // console.log(
  //   filterData(
  //     JSON.parse(
  //       '{"Description":"Hurls molten lava at the target, dealing (108% of Spell power) Fire damage. Elemental ,  Restoration (Level 20)Lava Burst will always critically strike if the target is affected by Flame Shock ElementalGenerates 10 Maelstrom.","Duration":"n/a","School":"Fire","Mechanic":"n/a","Dispel type":"n/a","GCD category":"Normal","Cost":"2.5% of base mana","Range":"40 yards (Long)","Cast time":"2 seconds","Cooldown":"8 sec","GCD":"1.5 seconds","Effect #1":"Trigger Missile (Lava Burst)","Effect #2":"Give Power (Maelstrom)","Flags":["Cannot be used while shapeshifted","Persists through death"]}'
  //     ),
  //     "51505"
  //   )
  // );

  Promise.all(promises).then(() => {
    let jsonToWrite = JSON.stringify(spellData);
    const testWorkingDataReal = require("./SpellsPhase2AllWorking.json");
    if (!_.isEqual(testWorkingDataReal, spellData)) {
      findDifferences(testWorkingDataReal, spellData);
    }
    //fs.writeFileSync(`SpellsPhase2Test.json`, jsonToWrite);
    browser.close();
  });
}
runAllThings();
