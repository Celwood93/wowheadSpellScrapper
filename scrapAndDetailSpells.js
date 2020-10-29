const puppeteer = require("puppeteer");
const fs = require("fs");
const data = require("./SpellsPhase1.json");

async function getDetails() {
  const spellIds = [20473]; //Object.keys(data);
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  for (id in spllIds) {
    await page.goto(`https://wowhead.com/spell=${id}`);
  }
}
getDetails();
