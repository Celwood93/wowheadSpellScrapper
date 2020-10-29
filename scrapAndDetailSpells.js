const puppeteer = require("puppeteer");
const fs = require("fs");
const spellData = require("./SpellsPhase1.json");
const maxPages = 100;

//Type is incase Spells/Talents/PvPTalents/Covenants produces a different type of datastorage -- might not need here
async function getDetails(spellId, browser, type) {
  let pages = await browser.pages();
  while (pages.length === maxPages) {
    pages = await browser.pages();
    await sleep(3000);
  }
  const page = await browser.newPage();
  await page.goto(`https://wowhead.com/spell=${spellId}`);
  //returns all spell information that ISNT currently included.
  await page.close();
}
const cachedIds = {};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runSpells(browser) {
  for (const className in Object.keys(spellData["Spells"])) {
    for (const spellName in Object.keys(spellData["Spells"][className])) {
      const spellId = spellData["Spells"][className][spellName].spellId;
      const newDataForId = await collectInformationOnSpellId(
        spellId,
        browser,
        "Spell"
      );
      spellData["Spells"][className][spellName] = {
        ...spellData["Spells"][className][spellName],
        ...newDataForId
      };
    }
  }
}

async function collectInformationOnSpellId(spellId, browser, type) {
  let newDataForId;
  if (!(spellId in cachedIds)) {
    newDataForId = await getDetails(spellId, browser, type);
    cachedIds[spellId] = newDataForId;
  } else {
    newDataForID = cachedIds[spellId];
  }
  return newDataForId;
}
async function runAllThings() {
  const browser = await puppeteer.launch();
  promises.push(runSpells(browser));
  // promises.push(runTalents(browser));
  // promises.push(runPvPTalents(browser));
  // promises.push(runCovenants(browser));

  Promise.all(promises).then(() => {
    let jsonToWrite = JSON.stringify(spellIds);
    fs.writeFileSync(`SpellsPhase2.json`, jsonToWrite);
    browser.close();
  });
}
runAllThings();
