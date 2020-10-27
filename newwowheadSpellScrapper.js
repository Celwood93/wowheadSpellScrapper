const puppeteer = require("puppeteer");
const fs = require("fs");

async function scrapeSpell(url, timer) {
  await sleep(timer);
  console.log(`${url} starting`);
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto(url);
  let result = true;

  do {
    const data = await page.evaluate(() => {
      const tds = Array.from(
        document.querySelectorAll(
          "tr.listview-row > td.listview-cb + td + td > div"
        )
      );
      return tds
        .filter(
          (td) => !/Rank \d|Summon|listview\-name\-info/.test(td.innerHTML)
        )
        .map((td) => td.children[0].getAttribute("href"));
    });
    data.forEach((link) => {
      const regex = /spell=(\d+)\/([\w-]+)/;
      try {
        const found = link.match(regex);
        if (!found) {
          console.log(`error with ${link}, could not be parsed`);
          return;
        } else {
          if (found.length !== 3) {
            console.log(
              `error with ${link}, parse didnt get sufficient values`
            );
            return;
          }
        }
        if (!(found[1] in spellIds)) {
          spellIds[found[1]] = { spellId: found[1], spellName: found[2] };
        } else {
          console.log(`url ${link} repeated in json`);
        }
      } catch (e) {
        console.log(`error ${e} for link ${link}`);
      }
    });
    result = await page.evaluate(() => {
      const tds = Array.from(
        document.querySelectorAll("div.listview-nav > span + a")
      );
      return tds.map((td) => td.getAttribute("data-active")).includes("yes");
    });
    try {
      if (result) {
        await Promise.all([
          page.waitForNavigation({ timeout: 15000 }),
          page.click("div.listview-nav > span + a"),
        ]);
      }
    } catch (e) {
      console.log(
        `Failed to click button and navigate at ${url} with error: ${e}`
      );
    }
  } while (result);

  browser.close();
  console.log(`${url} finished`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
let spellIds = {};
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
  "warrior",
];
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
  warrior: ["fury", "arms", "protection"],
};
//For only level 1 spells
const blacklistedSpells = {
  "death-knight": ["Frost Breath"],
  "demon-hunter": ["Foodder to the Flame", "Glide", "Soul Carver"],
  druid: ["Flap"],
  hunter: ["Volley", "Steel Trap"],
  mage: ["Polymorph", "Shoot"], //Want to exclude all spells matching with Portal: and Teleport: and Ancient Teleport: also only 1 polymorph - all others are at 25
  monk: ["Spinning Crane Kick"],
  paladin: ["Judgement", "Tyr's Deliverance"], //Want to exclude all Summon [Warhorse|Charger|\w+] [Ram|Elekk|Kodo]
  priest: ["Shoot"],
  rogue: ["Detection"], //Not sure about this one, could be legit
  shaman: ["Surge of Earth", "Fae Transfusion"], //only one hex @ 41 only heroism/bloodlust once / race specific
  warlock: ["DreadSteed", "Felsteed", "Shoot"],
  warrior: ["Hotbar Slot 01", "Hotbar Slot 02"],
};
// const types = ["7", "-12", "-2", "-16"];
// let promises = [];

// for (let k = 0; k < classes.length; k++) {
//   for (let j = 0; j < types.length; j++) {
//     promises.push(
//       scrapeSpell(
//         `https://shadowlands.wowhead.com/${classes[k]}#spells;type:${types[j]}`,
//         10000 * k + 1000 * j
//       )
//     );
//   }
// }

// Promise.all(promises).then(() => {
//   let jsonToWrite = JSON.stringify(spellIds);
//   fs.writeFileSync(`newTest.json`, jsonToWrite);
// });
