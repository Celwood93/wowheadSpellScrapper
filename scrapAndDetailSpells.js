const puppeteer = require("puppeteer");
const fs = require("fs");
const spellData = require("./SpellsPhase1Test.json"); //for testing atm
const maxPages = 100;
const promises = [];
const cachedIds = {};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

//Type is incase Spells/Talents/PvPTalents/Covenants produces a different type of datastorage -- might not need here
async function getDetails(spellId, browser, className, spellName, type) {
  let newDataForId;
  if (!(spellId in cachedIds)) {
    let pages = await browser.pages();

    while (pages.length === maxPages) {
      pages = await browser.pages();
      await sleep(3000);
    }

    const page = await browser.newPage();

    await page.goto(`https://wowhead.com/spell=${spellId}`);
    //could also grab rank 2/3/4 of spells to check if they add durations /reduce cds
    const pageSpellData = await page.evaluate(() => {
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
        datas.Cooldown = `${isRechargeCooldown[1]} ${isRechargeCooldown[2]}`;
      }
      return datas;
    });
    //process
    newDataForId = filterData(pageSpellData, spellId);
    console.log(
      `${Object.keys(cachedIds).length + 1}/${promises.length} finished`
    );
    cachedIds[spellId] = newDataForId;
    await page.close();
  } else {
    newDataForId = cachedIds[spellId];
  }

  spellData["Spells"][className][spellName] = {
    ...spellData["Spells"][className][spellName],
    ...newDataForId
  };
}

function filterData(pageSpellData, spellId) {
  let newDataForId = {};
  const doesIncludeSelf = pageSpellData["Range"].includes("Self");
  const doesIncludeRadius = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details => pageSpellData[details].includes("Radius"));
  const doesIncludeHealingAndDamage =
    /damage to an enemy/.test(pageSpellData["Description"]) &&
    /healing to an ally/.test(pageSpellData["Description"]);
  const doesIncludeHealingInEffect = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details => pageSpellData[details].includes("Heal"));
  const ftInDesc = /friendly target/.test(pageSpellData["Description"]);
  const porInDesc = /party or raid member/.test(pageSpellData["Description"]);
  const allyInDesc = /ally/.test(pageSpellData["Description"]);
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
    /(\d\d?\.?\d?\d?) (min)?(sec)?/
  );
  const descDurMatch = pageSpellData.Description.match(
    /(\d\d?\.?\d?\d?) (min)?(sec)?/
  );
  const cdMatch = pageSpellData["Cooldown"].match(
    /(\d\d?\.?\d?\d?) (min)?(sec)?/
  );
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

  //TODO Add in changes from ranks at somepoint
  const cd = cdMatch ? (cdMatch[2] ? cdMatch[1] * 60 : cdMatch[1]) : 0;
  const durLtCd = dur < cd;
  const durGtCd = dur > cd;

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
  if (doesIncludeSelf) {
    //Self
    newDataForId["targetType"] = targetTypes[0];
  } else if (doesIncludeRadius) {
    //Placed
    newDataForId["targetType"] = targetTypes[1];
  } else if (doesIncludeHealingAndDamage) {
    //One Any
    newDataForId["targetType"] = targetTypes[2];
  } else if (
    (doesIncludeHealingInEffect ||
      ftInDesc ||
      porInDesc ||
      allyInDesc ||
      healThemInDesc ||
      healTargInDesc) &&
    (oneTarAtATime || flagsOneTarg || maxTargOne || durLtCd)
  ) {
    //One Friendly
    newDataForId["targetType"] = targetTypes[3];
  } else if (
    (doesIncludeHealingInEffect ||
      ftInDesc ||
      porInDesc ||
      allyInDesc ||
      healThemInDesc ||
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
      doesItNegMech)
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
      doesItNegMech)
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
  "Rooted"
];

async function runSpells(browser) {
  const classNames = Object.keys(spellData["Spells"]);
  for (const className in classNames) {
    const spellNames = Object.keys(spellData["Spells"][classNames[className]]);
    for (const spellName in spellNames) {
      if (true) {
        const spellId =
          spellData["Spells"][classNames[className]][spellNames[spellName]]
            .spellId;
        promises.push(
          getDetails(
            spellId,
            browser,
            classNames[className],
            spellNames[spellName],
            "Spell"
          )
        );
      }
    }
  }
}

async function runAllThings() {
  const browser = await puppeteer.launch();
  runSpells(browser);
  // runTalents(browser);
  // runPvPTalents(browser);
  // runCovenants(browser);

  Promise.all(promises).then(() => {
    let jsonToWrite = JSON.stringify(spellData);
    fs.writeFileSync(`SpellsPhase2Test.json`, jsonToWrite);
    browser.close();
  });
}
runAllThings();
