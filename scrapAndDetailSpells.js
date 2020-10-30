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
async function getDetails(spellId, browser, type) {
  let newDataForId;
  if (!(spellId in cachedIds)) {
    let pages = await browser.pages();

    while (pages.length === maxPages) {
      pages = await browser.pages();
      await sleep(3000);
    }

    const page = await browser.newPage();

    await page.goto(`https://wowhead.com/spell=${spellId}`);

    const pageSpellData = await page.evaluate(() => {
      let datas = {};
      datas["Description"] = document.querySelector("span.q").textContent;
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
      return datas;
    });
    //process
    newDataForId = filterData(pageSpellData);
    console.log(
      `${Object.keys(cachedIds).length + 1}/${promises.length} finished`
    );
    cachedIds[spellId] = newDataForId;
    await page.close();
  } else {
    newDataForId = cachedIds[spellId];
  }

  // spellData["Spells"][className][spellName] = {
  //   ...spellData["Spells"][className][spellName],
  //   ...newDataForId
  // };
}

function filterData(pageSpellData) {
  let newDataForId = pageSpellData;
  return newDataForId;
}

async function runSpells(browser) {
  const classNames = Object.keys(spellData["Spells"]);
  for (const className in classNames) {
    const spellNames = Object.keys(spellData["Spells"][classNames[className]]);
    for (const spellName in spellNames) {
      const spellId =
        spellData["Spells"][classNames[className]][spellNames[spellName]]
          .spellId;
      promises.push(getDetails(spellId, browser, "Spell"));
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
    // let jsonToWrite = JSON.stringify(spellIds);
    // fs.writeFileSync(`SpellsPhase2Test.json`, jsonToWrite);
    browser.close();
  });
}
runAllThings();
