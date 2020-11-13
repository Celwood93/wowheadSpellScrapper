const puppeteer = require("puppeteer");
const Mutex = require("async-mutex").Mutex;
const fs = require("fs");
const _ = require("lodash");
const { performance } = require("perf_hooks");
const spellData = require("./SpellsPhase1.json");
let spellDataReformatted;
const maxPages = 20;
let promises = [];
const failedSpells = [];
const cachedIds = {};
const cachedData = require("./CachedPageSpellData.json");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
  let page;
  try {
    if (!(spellId in cachedIds)) {
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
              const listedSpellName = document.querySelector(
                "h1.heading-size-1"
              );
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
                  datas["idOfReplacedSpell"] = [didMatch[1]];
                }
              }
              Array.from(
                document.querySelectorAll("#spelldetails > tbody > tr")
              )
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
              if (listedSpellName) {
                datas.SpellName = listedSpellName.textContent;
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
        if (type === "Covenants") {
          newDataForId = {
            spellName: pageSpellData.SpellName,
            ...newDataForId
          };
        }
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
        if (type === "Spells") {
          newDataForId = {
            ...spellData["Spells"][className][spellId],
            ...newDataForId
          };
        } else if (type === "Talents") {
          ({ row, col, ...remaining } = spellData["Talents"][className][spec][
            "Normal"
          ][spellId]);
          let talentCalcLoc = [{ spec, row, col }];
          if (spellId in cachedIds) {
            talentCalcLoc.concat(cachedIds[spellId].talentCalcLoc);
          }
          newDataForId = {
            ...remaining,
            talentCalcLoc,
            ...newDataForId
          };
        } else if (type === "PvPTalents") {
          newDataForId = {
            ...spellData["Talents"][className][spec]["PvP"][spellId],
            ...newDataForId
          };
        } else if (type === "Covenants") {
          newDataForId = {
            ...spellData["Covenants"][className][spec][spellId],
            ...newDataForId
          };
        }
        //TODO potential for race conditions. Consider adding mutex
        cachedIds[spellId] = newDataForId;
      }
      if (page) {
        await page.close();
      }
    } else {
      newDataForId = cachedIds[spellId];
      if (type === "Talents") {
        ({ row, col, ...remaining } = spellData["Talents"][className][spec][
          "Normal"
        ][spellId]);
        if (newDataForId.talentCalcLoc) {
          newDataForId.talentCalcLoc.push({ spec, row, col });
        } else {
          newDataForId["talentCalcLoc"] = [{ spec, row, col }];
        }
      }
      release();
    }
    if (newDataForId) {
      if (type === "Spells") {
        if (Array.isArray(spellDataReformatted["Spells"][className])) {
          spellDataReformatted["Spells"][className] = [
            ...spellDataReformatted["Spells"][className],
            spellId
          ];
        } else {
          spellDataReformatted["Spells"][className] = [spellId];
        }
      } else if (type === "Talents") {
        if (
          Array.isArray(
            spellDataReformatted["Talents"][className][spec]["Normal"]
          )
        ) {
          spellDataReformatted["Talents"][className][spec]["Normal"] = [
            ...spellDataReformatted["Talents"][className][spec]["Normal"],
            spellId
          ];
        } else {
          spellDataReformatted["Talents"][className][spec]["Normal"] = [
            spellId
          ];
        }
      } else if (type === "PvPTalents") {
        if (
          Array.isArray(spellDataReformatted["Talents"][className][spec]["PvP"])
        ) {
          spellDataReformatted["Talents"][className][spec]["PvP"] = [
            ...spellDataReformatted["Talents"][className][spec]["PvP"],
            spellId
          ];
        } else {
          spellDataReformatted["Talents"][className][spec]["PvP"] = [spellId];
        }
      } else if (type === "Covenants") {
        if (Array.isArray(spellDataReformatted["Covenants"][className][spec])) {
          spellDataReformatted["Covenants"][className][spec] = [
            ...spellDataReformatted["Covenants"][className][spec],
            spellId
          ];
        } else {
          spellDataReformatted["Covenants"][className][spec] = [spellId];
        }
      }
    }
  } catch (e) {
    if (page) {
      await page.close();
    }
    release();
    failedSpells.push(spellId);
    console.log(e);
    await fs.appendFileSync("log.txt", e);
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
    !/enemy|(a friendly|your|the) target/.test(pageSpellData["Description"]);
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
  const descTargLoc = /(to the|at a|at the|in the) target(ed)? (location|area)|at the ground/.test(
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
    (/damage to an enemy/.test(pageSpellData["Description"]) &&
      /healing to an ally/.test(pageSpellData["Description"])) ||
    /friends and foes/.test(pageSpellData["Description"]) ||
    /enemy target[\w, %\(\)]+ allies/.test(pageSpellData["Description"]);
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
  const stingTarget = /Stings the target/.test(pageSpellData["Description"]);
  const reduceTarget = /Reduces? the target's/.test(
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
  //Spellsteal includes a time in the description, i think its the only spell that does. (this was not true)
  if (spellId === "30449") {
    dur = -1;
  }
  const cd = cdMatch ? (cdMatch[2] ? cdMatch[1] * 60 : cdMatch[1]) : 0;
  const gcdAdd = /\d\d?\.?\d?/.test(pageSpellData["GCD"])
    ? pageSpellData["GCD"].match(/\d\d?\.?\d?/)[0]
    : 0;
  const castTimeAdd = /\d\d?\.?\d?\d?/.test(pageSpellData["Cast time"])
    ? pageSpellData["Cast time"].match(/\d\d?\.?\d?/)[0]
    : /Channeled/.test(pageSpellData["Cast time"])
    ? dur
    : 0;
  const cdRealistic = (1 * cd + 1 * gcdAdd + 1 * castTimeAdd) * 1.5;
  const durLtCd = 1 * dur < 1 * cdRealistic;
  const durGtCd = 1 * dur > 1 * cdRealistic;
  if (
    !negativeMechanics.includes(pageSpellData["Mechanic"]) &&
    !positiveMechanics.includes(pageSpellData["Mechanic"])
  ) {
    Object.keys(pageSpellData)
      .filter(topics => topics.includes("Effect"))
      .some(details => pageSpellData[details].includes("Interrupt"))
      ? (pageSpellData["Mechanic"] = "Interrupted")
      : /interrupt/.test(pageSpellData["Description"])
      ? (pageSpellData["Mechanic"] = "Interrupted")
      : 0;
    Object.keys(pageSpellData)
      .filter(topics => topics.includes("Effect"))
      .some(
        details =>
          !/Immunity/.test(pageSpellData[details]) &&
          !/FX - Test - Mind Blast \+ Stun/.test(pageSpellData[details]) &&
          !/Value: ?-\d\d?%/.test(pageSpellData[details]) &&
          /Stun/.test(pageSpellData[details])
      )
      ? (pageSpellData["Mechanic"] = "Stunned")
      : !/frees you from all stuns/.test(pageSpellData["Description"]) &&
        /stuns|stunning/.test(pageSpellData["Description"])
      ? (pageSpellData["Mechanic"] = "Stunned")
      : 0;
    Object.keys(pageSpellData)
      .filter(topics => topics.includes("Effect"))
      .some(
        details =>
          !/Immunity/.test(pageSpellData[details]) &&
          !/Value: ?-\d\d?%/.test(pageSpellData[details]) &&
          /Fear/.test(pageSpellData[details])
      )
      ? (pageSpellData["Mechanic"] = "Disoriented")
      : /disorient/.test(pageSpellData["Description"])
      ? (pageSpellData["Mechanic"] = "Disoriented")
      : 0;
  }
  const doesItTM = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details => pageSpellData[details].includes("Trigger Missle"));
  const descEnemy = pageSpellData["Description"].includes("enemy");
  const afflictsInDesc = pageSpellData["Description"].includes("afflicts");
  const marksInDesc = pageSpellData["Description"].includes("Marks ");
  const doesItNWD = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details =>
      pageSpellData[details].includes("Normalized Weapon Damage")
    );
  const doesItPLH = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details =>
      pageSpellData[details].includes("Periodically Leech Health")
    );
  //TODO change to an id list for these spells.
  const isCurseOfTongues = spellName === "Curse of Tongues";
  const isDemonicGateway = spellName === "Demonic Gateway";
  const isOneAnyException =
    spellName === "Shadowstep" ||
    spellName === "Wild Charge" ||
    spellName === "Death Coil" ||
    spellName === "Gorefiend's Grasp" ||
    spellName === "Mind Sear" ||
    spellId === "325727" ||
    spellId === "304971" ||
    spellId === "324724" ||
    spellId === "320674" ||
    spellId === "326059";
  const isSelfException =
    spellName === "Summon Demonic Tyrant" ||
    spellName === "Malefic Rapture" ||
    spellName === "Song of Chi-Ji" ||
    spellName === "Summon Vilefiend" ||
    spellName === "Glacial Advance" ||
    spellName === "Savage Roar" ||
    spellName === "Primal Wrath" ||
    spellName === "Arcane Orb" ||
    spellName === "Chi Burst" ||
    spellName === "Invoke Chi-Ji, the Red Crane" ||
    spellName === "Divine Star" ||
    spellName === "Halo" ||
    spellName === "Storm Elemental" ||
    spellName === "Fire Nova" ||
    spellName === "Power Siphon" ||
    spellName === "Channel Demonfire" ||
    spellName === "Nether Portal" ||
    spellName === "Demonic Strength" ||
    spellName === "Reanimation" ||
    spellName === "Spirit Link" ||
    spellName === "Soulshatter" ||
    spellName === "Call Observer" ||
    spellId === "324631" ||
    spellId === "315443" ||
    spellId === "327104";

  const isFriendlyException =
    spellName === "Rapture" ||
    spellName === "Interlope" ||
    spellName === "Thundercharge" ||
    spellName === "Power Infusion" ||
    spellId === "204362" ||
    spellId === "204361";
  const doesItSD = Object.keys(pageSpellData)
    .filter(topics => topics.includes("Effect"))
    .some(details => pageSpellData[details].includes("School Damage"));
  const dropAtFeet = /feet of the caster/.test(pageSpellData["Description"]);
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
  const isFriendlyDispel =
    Object.keys(pageSpellData)
      .filter(topics => topics.includes("Effect"))
      .some(details =>
        /Dispel\s\((Curse|Disease|Poison)\)/.test(pageSpellData[details])
      ) ||
    /remove all harmful magical effects/.test(pageSpellData["Description"]);
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
  } else if (spellsThatAreOnFriendliesButNotYourself.includes(spellId)) {
    //Friendly that isnt self
    newDataForId["targetType"] = targetTypes[7];
  } else if (
    doesIncludeSelf ||
    isInPartyOrRaid ||
    isAroundOrInfront ||
    aroundShortRange ||
    (canSummon && doesntEngage && !descTargLoc) ||
    isMassRez ||
    isAoeSpeedBoost ||
    isUnlimitedRange ||
    isPetOrDemon ||
    (doesOverrideSpell &&
      !doesItNegMech &&
      spellId !== "324386") /*Cant be vesper totem*/ ||
    teleportOrTransfer ||
    allHealersInRaid ||
    givesAttackSpeedSteroid ||
    isRaidWideCooldown ||
    dropAtFeet ||
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
    !stingTarget &&
    ((doesIncludeHealingInEffect && !doesItRC && !doesItSD) ||
      ftInDesc ||
      porInDesc ||
      (allyInDesc && !descEnemy) ||
      healThemInDesc ||
      isRez ||
      healTargInDesc ||
      isFriendlyDispel ||
      isFriendlyException) && //not sure how else to catch it, its too unique
    (oneTarAtATime || flagsOneTarg || maxTargOne || durLtCd)
  ) {
    //One Friendly
    newDataForId["targetType"] = targetTypes[3];
  } else if (
    !doesItNegMech &&
    !stingTarget &&
    ((doesIncludeHealingInEffect && !doesItRC) ||
      ftInDesc ||
      porInDesc ||
      (allyInDesc && !descEnemy) ||
      healThemInDesc ||
      isRez ||
      healTargInDesc ||
      isFriendlyDispel ||
      isFriendlyException) &&
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
      doesItPLH ||
      doesItRC ||
      doesItSD ||
      afflictsInDesc ||
      marksInDesc ||
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
      stingTarget ||
      reduceTarget)
  ) {
    //One Enemy
    newDataForId["targetType"] = targetTypes[5];
  } else if (
    durGtCd &&
    (doesItNWD ||
      doesItPLH ||
      doesItRC ||
      doesItSD ||
      doesItTM ||
      descEnemy ||
      descDmg ||
      doesItNegMech ||
      isTaunt ||
      isDispel ||
      isWeaponRequired ||
      afflictsInDesc ||
      isStalked ||
      isRequireUntapped ||
      attackInDesc ||
      isCurseOfTongues ||
      stingTarget ||
      reduceTarget)
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
  "MANY_ENEMY",
  "FRIENDLY_NOT_SELF"
];

const positiveMechanics = ["Invulnerable"];

const negativeMechanics = [
  "Stunned",
  "Snared",
  "Disoriented",
  "Polymorphed",
  "Rooted",
  "Interrupted",
  "Banished",
  "Asleep",
  "Disarmed",
  "Charmed",
  "Sapped",
  "Shackled",
  "Incapacitated"
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
  "196277",
  "207311",
  "202770",
  "157997",
  "157980",
  "341385",
  "51690",
  "192249",
  "316262",
  "304971",
  "320674"
];

const spellsThatAreOnFriendliesButNotYourself = [
  "321358",
  "73325",
  "3411",
  "6940",
  "183998",
  "57934",
  "34477",
  "108968"
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
        delete spellDataReformatted["Spells"][classNames[className]][
          spellIds[spellId]
        ];
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
          delete spellDataReformatted["Talents"][classNames[className]][
            specNames[specName]
          ]["Normal"][spellIds[spellId]];
        }
      }
    }
  }
}

async function runPvPTalents(browser, mutex) {
  const classNames = Object.keys(spellData["Talents"]);
  for (const className in classNames) {
    const specNames = Object.keys(spellData["Talents"][classNames[className]]);
    for (const specName in specNames) {
      const spellIds = Object.keys(
        spellData["Talents"][classNames[className]][specNames[specName]]["PvP"]
      );
      for (spellId in spellIds) {
        const spellName =
          spellData["Talents"][classNames[className]][specNames[specName]][
            "PvP"
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
              "PvPTalents",
              specNames[specName],
              mutex
            )
          );
        } else {
          delete spellData["Talents"][classNames[className]][
            specNames[specName]
          ]["PvP"][spellIds[spellId]];
        }
      }
    }
  }
}

async function runCovenants(browser, mutex) {
  const classNames = Object.keys(spellData["Covenants"]);
  for (const className in classNames) {
    const covenantNames = Object.keys(
      spellData["Covenants"][classNames[className]]
    );
    for (const covenantName in covenantNames) {
      const covenantSpellIds = Object.keys(
        spellData["Covenants"][classNames[className]][
          covenantNames[covenantName]
        ]
      );
      for (const covenantSpellId in covenantSpellIds) {
        const spellName =
          spellData["Covenants"][classNames[className]][
            covenantNames[covenantName]
          ][covenantSpellIds[covenantSpellId]].spellName;
        let isAllowedSpell;
        if (testingWorkingKey) {
          isAllowedSpell = !brokenSpells
            .concat(incorrectSpells)
            .includes(covenantSpellIds[covenantSpellId] * 1);
        } else {
          isAllowedSpell = brokenSpells
            .concat(incorrectSpells)
            .includes(covenantSpellIds[covenantSpellId] * 1);
        }

        if (isAllowedSpell) {
          promises.push(
            getDetails(
              covenantSpellIds[covenantSpellId],
              browser,
              classNames[className],
              spellName,
              "Covenants",
              covenantNames[covenantName],
              mutex
            )
          );
        } else {
          delete spellDataReformatted["Covenants"][classNames[className]][
            covenantNames[covenantName]
          ][covenantSpellIds[covenantSpellId]];
        }
      }
    }
  }
}

const brokenSpells = [];
const incorrectSpells = [];
/**
 * Takes in true data, which is the current working list of spells and compares it to newData, which is the newly created list of spells
 * If there is something thats in both newData and trueData that is different, it will print to the screen, if there is something
 * in newData that is not in true data, it will print the data structure with only the spells unique to newData.
 */

async function findDifferences(trueData, newData) {
  let classNames = Object.keys(trueData["Spells"]);
  for (const className in classNames) {
    const spellIds = trueData["Spells"][classNames[className]];
    for (const spellId in spellIds) {
      if (
        newData["Spells"][classNames[className]].includes(spellIds[spellId]) &&
        !_.isEqual(
          trueData["AllSpells"][spellIds[spellId]],
          newData["AllSpells"][spellIds[spellId]]
        )
      ) {
        console.log("spells", spellIds[spellId]);
      }
      newData["Spells"][classNames[className]] = newData["Spells"][
        classNames[className]
      ].filter(e => e !== spellIds[spellId]);
    }
    if (newData["Spells"][classNames[className]].length === 0) {
      delete newData["Spells"][classNames[className]];
    }
  }
  if (Object.keys(newData["Spells"]).length === 0) {
    delete newData["Spells"];
  }
  classNames = Object.keys(trueData["Talents"]);
  for (const className in classNames) {
    const specNames = Object.keys(trueData["Talents"][classNames[className]]);
    for (const specName in specNames) {
      const spellIds =
        trueData["Talents"][classNames[className]][specNames[specName]][
          "Normal"
        ];
      for (spellId in spellIds) {
        if (
          newData["Talents"][classNames[className]][specNames[specName]][
            "Normal"
          ].includes(spellIds[spellId]) &&
          !_.isEqual(
            newData["AllSpells"][spellIds[spellId]],
            trueData["AllSpells"][spellIds[spellId]]
          )
        ) {
          console.log("talents", spellIds[spellId]);
        }
        newData["Talents"][classNames[className]][specNames[specName]][
          "Normal"
        ] = newData["Talents"][classNames[className]][specNames[specName]][
          "Normal"
        ].filter(e => e !== spellIds[spellId]);
      }
      if (
        newData["Talents"][classNames[className]][specNames[specName]]["Normal"]
          .length === 0
      ) {
        delete newData["Talents"][classNames[className]][specNames[specName]][
          "Normal"
        ];
      }
    }
  }

  classNames = Object.keys(trueData["Covenants"]);
  for (const className in classNames) {
    const covenantNames = Object.keys(
      trueData["Covenants"][classNames[className]]
    );
    for (const covenantName in covenantNames) {
      const covenantSpellIds =
        trueData["Covenants"][classNames[className]][
          covenantNames[covenantName]
        ];
      for (const covenantSpellId in covenantSpellIds) {
        if (
          newData["Covenants"][classNames[className]][
            covenantNames[covenantName]
          ].includes(covenantSpellIds[covenantSpellId]) &&
          !_.isEqual(
            newData["AllSpells"][covenantSpellIds[covenantSpellId]],
            trueData["AllSpells"][covenantSpellIds[covenantSpellId]]
          )
        ) {
          console.log("covs", covenantSpellIds[covenantSpellId]);
        }
        newData["Covenants"][classNames[className]][
          covenantNames[covenantName]
        ] = newData["Covenants"][classNames[className]][
          covenantNames[covenantName]
        ].filter(e => e !== covenantSpellIds[covenantSpellId]);
      }
      if (
        newData["Covenants"][classNames[className]][covenantNames[covenantName]]
          .length === 0
      ) {
        delete newData["Covenants"][classNames[className]][
          covenantNames[covenantName]
        ];
      }
    }
    if (Object.keys(newData["Covenants"][classNames[className]]).length === 0) {
      delete newData["Covenants"][classNames[className]];
    }
  }
  if (Object.keys(newData["Covenants"]).length === 0) {
    delete newData["Covenants"];
  }
  classNames = Object.keys(trueData["Talents"]);
  for (const className in classNames) {
    const specNames = Object.keys(trueData["Talents"][classNames[className]]);
    for (const specName in specNames) {
      const spellIds =
        trueData["Talents"][classNames[className]][specNames[specName]]["PvP"];
      for (spellId in spellIds) {
        if (
          newData["Talents"][classNames[className]][specNames[specName]][
            "PvP"
          ].includes(spellIds[spellId]) &&
          !_.isEqual(
            newData["AllSpells"][spellIds[spellId]],
            trueData["AllSpells"][spellIds[spellId]]
          )
        ) {
          console.log("pvptalents", spellIds[spellId]);
        }
        newData["Talents"][classNames[className]][specNames[specName]][
          "PvP"
        ] = newData["Talents"][classNames[className]][specNames[specName]][
          "PvP"
        ].filter(e => e !== spellIds[spellId]);
      }
      if (
        newData["Talents"][classNames[className]][specNames[specName]]["PvP"]
          .length === 0
      ) {
        delete newData["Talents"][classNames[className]][specNames[specName]][
          "PvP"
        ];
      }
      if (
        Object.keys(
          newData["Talents"][classNames[className]][specNames[specName]]
        ).length === 0
      ) {
        delete newData["Talents"][classNames[className]][specNames[specName]];
      }
    }
    if (Object.keys(newData["Talents"][classNames[className]]).length === 0) {
      delete newData["Talents"][classNames[className]];
    }
  }
  if (Object.keys(newData["Talents"]).length === 0) {
    delete newData["Talents"];
  }

  if (!_.isEqual(trueData["AllSpells"], newData["AllSpells"])) {
    console.log(
      "found in truedata but not in newdata",
      trueData["AllSpells"].filter(x => !newData["AllSpells"].includes(x)),
      "found in newdata but not in truedata",
      newData["AllSpells"].filter(x => !trueData["AllSpells"].includes(x))
    );
    newData["AllSpells"] = newData["AllSpells"].filter(
      x => !trueData["AllSpells"].includes(x)
    );
  } else {
    delete newData["AllSpells"];
  }

  //do something to verify the two things here
  let jsonToWrite = JSON.stringify(newData);
  fs.writeFileSync(`NewDataSpellsNotInTrueData.json`, jsonToWrite);
}

function checkForImprovements(targetData, calculatedData) {
  let classNames = Object.keys(calculatedData["Spells"]);
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
  classNames = Object.keys(calculatedData["Talents"]);
  for (const className in classNames) {
    const specNames = Object.keys(
      calculatedData["Talents"][classNames[className]]
    );
    for (const specName in specNames) {
      const spellIds = Object.keys(
        calculatedData["Talents"][classNames[className]][specNames[specName]][
          "Normal"
        ]
      );
      spellsLength += spellIds.length;
      for (spellId in spellIds) {
        if (
          _.isEqual(
            targetData["Talents"][classNames[className]][specNames[specName]][
              "Normal"
            ][spellIds[spellId]],
            calculatedData["Talents"][classNames[className]][
              specNames[specName]
            ]["Normal"][spellIds[spellId]]
          )
        ) {
          spellsWorkingLength++;
          console.log(
            `${calculatedData["Talents"][classNames[className]][specNames[specName]]["Normal"][spellIds[spellId]].spellName}, Spell ID: ${spellIds[spellId]} Now Equal With ${calculatedData["Talents"][classNames[className]][specNames[specName]]["Normal"][spellIds[spellId]].targetType}`
          );
        }
      }
    }
  }
  classNames = Object.keys(calculatedData["Talents"]);
  for (const className in classNames) {
    const specNames = Object.keys(
      calculatedData["Talents"][classNames[className]]
    );
    for (const specName in specNames) {
      const spellIds = Object.keys(
        calculatedData["Talents"][classNames[className]][specNames[specName]][
          "PvP"
        ]
      );
      spellsLength += spellIds.length;
      for (spellId in spellIds) {
        if (
          _.isEqual(
            targetData["Talents"][classNames[className]][specNames[specName]][
              "PvP"
            ][spellIds[spellId]],
            calculatedData["Talents"][classNames[className]][
              specNames[specName]
            ]["PvP"][spellIds[spellId]]
          )
        ) {
          spellsWorkingLength++;
          console.log(
            `${calculatedData["Talents"][classNames[className]][specNames[specName]]["PvP"][spellIds[spellId]].spellName}, Spell ID: ${spellIds[spellId]} Now Equal With ${calculatedData["Talents"][classNames[className]][specNames[specName]]["PvP"][spellIds[spellId]].targetType}`
          );
        }
      }
    }
  }
  classNames = Object.keys(calculatedData["Covenants"]);
  for (const className in classNames) {
    const covenantNames = Object.keys(
      calculatedData["Covenants"][classNames[className]]
    );
    for (const covenantName in covenantNames) {
      const covenantSpellIds = Object.keys(
        calculatedData["Covenants"][classNames[className]][
          covenantNames[covenantName]
        ]
      );
      spellsLength += covenantSpellIds.length;
      for (const covenantSpellId in covenantSpellIds) {
        if (
          !_.isEqual(
            targetData["Covenants"][classNames[className]][
              covenantNames[covenantName]
            ][covenantSpellIds[covenantSpellId]],
            calculatedData["Covenants"][classNames[className]][
              covenantNames[covenantName]
            ][covenantSpellIds[covenantSpellId]]
          )
        ) {
          spellsWorkingLength++;
          console.log(
            `${calculatedData["Covenants"][classNames[className]][covenantNames[covenantName]][covenantSpellIds[covenantSpellId]].spellName}, Spell ID: ${covenantSpellIds[covenantSpellId]} Now Equal With ${calculatedData["Covenants"][classNames[className]][covenantNames[covenantName]][covenantSpellIds[covenantSpellId]].targetType}`
          );
        }
      }
    }
  }
  console.log(`${spellsWorkingLength}/${spellsLength} now work`);
}
//Feral(rake, rip, swipe, maim), x3
//Guardian(thrash, frenzied regeneration, incapacitating roar), x2
//Resto(rejuv, swiftmend, wild growth, ursols vortex), x1
//Balance(moonkin form, starsurge, starfire, sunfire, typhoon) x2
const druidAffinities = {
  197490: ["1822", "1079", "213764", "22570"],
  202155: ["1822", "1079", "22570"],
  202157: ["1822", "1079", "213764", "22570"],
  197491: ["106832", "22842", "99"],
  217615: ["22842", "99"],
  197492: ["774", "18562", "48438", "102793"],
  197488: ["24858", "78674", "194153", "93402", "132469"],
  197632: ["24858", "78674", "194153", "132469"]
};

const testingWorkingKey = true;

async function runAllThings() {
  const browser = await puppeteer.launch();
  const spellDataReformattedUnparsed = await fs.readFileSync(
    "./SpellsPhase1.json"
  );
  spellDataReformatted = JSON.parse(spellDataReformattedUnparsed);
  let t0 = performance.now();
  const mutex = new Mutex();
  runSpells(browser, mutex);
  runTalents(browser, mutex);
  runPvPTalents(browser, mutex);
  runCovenants(browser, mutex);
  //Since there are alot of repeat spells, shuffling increases the chance that we can use cached data for them.
  promises = _.shuffle(promises);

  Promise.all(promises).then(async () => {
    if (failedSpells.length > 0) {
      fs.writeFileSync(
        `./CachedPageSpellData.json`,
        JSON.stringify(cachedData)
      );
      console.log(
        `${failedSpells.length} failed spells. Cached data has been updated.`
      );
    } else {
      spellDataReformatted["AllSpells"] = cachedIds;
      let jsonToWrite = JSON.stringify(spellDataReformatted);
      const currentSpellData = require("./SpellsPhase2.json");
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
        if (!_.isEqual(currentSpellData, spellDataReformatted)) {
          fs.writeFileSync(`SpellsPhase2New.json`, jsonToWrite);
          findDifferences(currentSpellData, spellDataReformatted);
        } else {
          console.log("equal");
        }
      } else {
        checkForImprovements(brokeSpellsFixedKey, spellData);
        //fs.writeFileSync(`SpellsPhase2AllBrokenSpells.json`, jsonToWrite);
      }
    }
    let t1 = performance.now();
    console.log(`finished in ${(t1 - t0) / 1000} seconds`);
    browser.close();
  });
}
runAllThings();
