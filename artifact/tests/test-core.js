process.env.NODE_PATH = '/opt/node22/lib/node_modules';
require('module').Module._initPaths();
const { chromium } = require('playwright');
const path = require('path');
const FILE_PATH = 'file://' + path.resolve(__dirname, '..', 'sous-chef.html');
const CHROME_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
function assert(cond, msg, detail) {
  if (cond) { pass++; console.log('  PASS - ' + msg); }
  else { fail++; console.log('  FAIL - ' + msg + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}

// A database whose writes take LAT ms to reach the "server" and echo back.
function latencyDb(lat) {
  return `
(function () {
  var LAT = ${lat};
  var store = { recipes: { a: { name: 'Alpha', baseServings: 4, ingredients: [
    { amount: 1, unit: 'cup', name: 'flour' }, { amount: 2, unit: 'cup', name: 'milk' },
    { amount: 3, unit: 'tbsp', name: 'sugar' }, { amount: 1, unit: 'tsp', name: 'salt' }], instructions: ['Mix 5 minutes.'] } },
    week: { items: { a: 4 }, checked: {} } };
  var rl = [], wl = [];
  function rs() { return { docs: Object.keys(store.recipes).map(function (id) { return { id: id, exists: true, data: function () { return JSON.parse(JSON.stringify(store.recipes[id])); } }; }) }; }
  function ws() { var w = JSON.parse(JSON.stringify(store.week)); return { exists: true, data: function () { return w; } }; }
  function notifyWeek() { var s = ws(); wl.forEach(function (f) { f(s); }); }
  window.__serverWeek = function () { return JSON.parse(JSON.stringify(store.week)); };
  window.__remoteWrite = function (w) { store.week = JSON.parse(JSON.stringify(w)); notifyWeek(); };
  var db = {
    collection: function () { return {
      onSnapshot: function (n) { rl.push(n); setTimeout(function () { n(rs()); }, 10); return function () {}; },
      doc: function (id) { return { set: function (d) { store.recipes[id] = d; setTimeout(function () { rl.forEach(function (f) { f(rs()); }); }, LAT); return Promise.resolve(); }, delete: function () { return Promise.resolve(); } }; }
    }; },
    doc: function () { return {
      onSnapshot: function (n) { wl.push(n); setTimeout(function () { n(ws()); }, 10); return function () {}; },
      set: function (d) { var copy = JSON.parse(JSON.stringify(d)); return new Promise(function (res) { setTimeout(function () { store.week = copy; notifyWeek(); res(); }, LAT); }); }
    }; }
  };
  window.claude = { use: function (n) { return Promise.resolve(n === 'db' ? db : null); } };
})();`;
}

const runningAnims = (page) => page.evaluate(() => document.getAnimations()
  .filter(a => a instanceof CSSAnimation && a.playState === 'running' && !/bump|toast|spin|checkPop|ring|alarm/.test(a.animationName))
  .map(a => a.animationName + '@' + (a.effect.target.className || a.effect.target.id)));

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });

  console.log('\n=== 1. Add, plan, shop (this device) ===');
  let ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  let page = await ctx.newPage();
  let errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(FILE_PATH);
  await page.waitForTimeout(300);
  assert(/Saved on this device/.test(await page.textContent('#statusText')), 'Falls back to this device without a database');
  await page.click('#newRecipeBtn');
  await page.fill('#rfName', 'Pancakes');
  await page.fill('#rfServings', '2');
  const rows = await page.$$('#rfIngredients .ingredient-row');
  await rows[0].$eval('.ing-amount', el => el.value = '1');
  await rows[0].$eval('.ing-unit', el => el.value = 'cup');
  await rows[0].$eval('.ing-name', el => el.value = 'flour');
  await rows[1].$eval('.ing-amount', el => el.value = '2');
  await rows[1].$eval('.ing-unit', el => el.value = '');
  await rows[1].$eval('.ing-name', el => el.value = 'eggs');
  await page.fill('#rfInstructions', 'Whisk.\nFry 3 minutes a side.');
  await page.click('[data-action="save-recipe"]');
  await page.waitForTimeout(300);
  assert(/2 servings · 2 ingredients · 2 steps/.test(await page.textContent('.recipe-card .recipe-meta')), 'Saved recipe shows on the card');
  await page.click('.recipe-card .plan-toggle input');
  await page.click('.recipe-card [data-delta="1"]');
  await page.click('.recipe-card [data-delta="1"]');
  await page.waitForTimeout(200);
  await page.click('.tab-btn[data-tab="shop"]');
  await page.waitForTimeout(900);
  const amts = await page.$$eval('#shoppingByRecipe .shop-item .shop-amount', els => els.map(e => e.textContent));
  assert(amts.join('|') === '4|2 cups', 'Servings scale the list (4 servings of a 2-serving recipe)', amts);
  // ticking items must not replay any entrance animation
  await page.waitForTimeout(900);
  let replays = [];
  for (const sel of ['#shoppingByRecipe .shop-item:nth-child(1) label', '#shoppingByRecipe .shop-item:nth-child(2) label']) {
    await page.click(sel);
    await page.waitForTimeout(60);
    replays = replays.concat(await runningAnims(page));
    await page.waitForTimeout(1000);
  }
  await page.click('#viewToggle [data-view="combined"]');
  await page.waitForTimeout(900);
  await page.click('#shoppingCombined .shop-item label');
  await page.waitForTimeout(60);
  replays = replays.concat(await runningAnims(page));
  await page.click('.tab-btn[data-tab="recipes"]');
  await page.waitForTimeout(700);
  await page.click('.tab-btn[data-tab="shop"]');
  await page.waitForTimeout(60);
  replays = replays.concat(await runningAnims(page));
  assert(replays.length === 0, 'Ticking items and switching tabs never replays entrance animations', replays);
  await page.reload();
  await page.waitForTimeout(400);
  assert((await page.$$eval('#shoppingCombined .shop-item.is-checked', els => els.length)) === 1, 'Checks survive a reload');
  assert(errors.length === 0, 'No page errors', errors);
  await ctx.close();

  console.log('\n=== 1b. Same ingredient in two recipes ===');
  ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await ctx.addInitScript(() => {
    if (sessionStorage.getItem('s')) return; sessionStorage.setItem('s', '1');
    localStorage.clear();
    localStorage.setItem('larder_recipes', JSON.stringify({
      a: { name: 'Stir-Fry', baseServings: 4, ingredients: [{ amount: 2, unit: 'clove', name: 'garlic' }, { amount: 1, unit: 'lb', name: 'chicken' }] },
      b: { name: 'Pasta', baseServings: 2, ingredients: [{ amount: 4, unit: 'clove', name: 'garlic' }, { amount: 8, unit: 'oz', name: 'spaghetti' }] } }));
    localStorage.setItem('larder_week', JSON.stringify({ items: { a: 4, b: 2 }, checked: {} }));
    localStorage.setItem('sous_chef_tab', 'shop'); localStorage.setItem('sous_chef_shopping_view', 'recipe');
  });
  page = await ctx.newPage();
  errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(FILE_PATH);
  await page.waitForTimeout(400);
  const garlicStates = () => page.$$eval('#shoppingByRecipe .recipe-shop-group', gs => gs.map(g => {
    const r = Array.from(g.querySelectorAll('.shop-item')).find(x => x.querySelector('.shop-name-text').textContent === 'garlic');
    return g.querySelector('.recipe-shop-name').textContent + ':' + (r && r.querySelector('input').checked);
  }).join(' '));
  await page.click('#shoppingByRecipe .recipe-shop-group:has-text("Stir-Fry") .shop-item:has-text("garlic") label');
  await page.waitForTimeout(200);
  assert(await garlicStates() === 'Pasta:false Stir-Fry:true', 'Ticking garlic in one recipe leaves the other recipe’s garlic alone', await garlicStates());
  await page.click('#viewToggle [data-view="combined"]');
  await page.waitForTimeout(200);
  const combinedGarlic = () => page.evaluate(() => { const r = Array.from(document.querySelectorAll('#shoppingCombined .shop-item')).find(x => x.querySelector('.shop-name-text').textContent === 'garlic'); return r.querySelector('input').checked; });
  assert(!(await combinedGarlic()) && /6 cloves/.test(await page.textContent('#shoppingCombined')), 'Combined garlic (6 cloves) stays unticked until all of it is');
  await page.click('#viewToggle [data-view="recipe"]');
  await page.waitForTimeout(200);
  await page.click('#shoppingByRecipe .recipe-shop-group:has-text("Pasta") .shop-item:has-text("garlic") label');
  await page.waitForTimeout(200);
  await page.click('#viewToggle [data-view="combined"]');
  await page.waitForTimeout(200);
  assert(await combinedGarlic(), 'Once both recipes’ garlic is ticked, combined garlic is ticked');
  await page.click('#shoppingCombined .shop-item:has-text("garlic") label');
  await page.waitForTimeout(200);
  await page.click('#viewToggle [data-view="recipe"]');
  await page.waitForTimeout(200);
  assert(await garlicStates() === 'Pasta:false Stir-Fry:false', 'Unticking combined garlic unticks both', await garlicStates());
  assert(/0 of 3/.test(await page.textContent('#itemCount')), 'Count is per shopping item (3 to buy)', await page.textContent('#itemCount'));
  // A tick saved before this fix (one shared key) shows on both, and can then be split.
  await page.evaluate(() => { const w = JSON.parse(localStorage.getItem('larder_week')); w.checked = { 'garlic|clove': true }; localStorage.setItem('larder_week', JSON.stringify(w)); });
  await page.reload();
  await page.waitForTimeout(400);
  assert(await garlicStates() === 'Pasta:true Stir-Fry:true', 'An older saved tick still shows as ticked on both', await garlicStates());
  await page.click('#shoppingByRecipe .recipe-shop-group:has-text("Pasta") .shop-item:has-text("garlic") label');
  await page.waitForTimeout(200);
  assert(await garlicStates() === 'Pasta:false Stir-Fry:true', '…and unticking one keeps the other', await garlicStates());
  assert(errors.length === 0, 'No page errors', errors);
  await ctx.close();

  console.log('\n=== 2. Synced: fast ticks with a slow database ===');
  for (const lat of [150, 600]) {
    ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
    await ctx.addInitScript(latencyDb(lat));
    await ctx.addInitScript(() => { localStorage.setItem('sous_chef_tab', 'shop'); localStorage.setItem('sous_chef_shopping_view', 'recipe'); });
    page = await ctx.newPage();
    errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(FILE_PATH);
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      window.__flicker = [];
      const seen = new Set();
      window.__watch = setInterval(() => {
        document.querySelectorAll('#shoppingByRecipe .shop-item').forEach(r => {
          const name = r.querySelector('.shop-name').textContent;
          const on = r.querySelector('input').checked;
          if (on) seen.add(name); else if (seen.has(name)) { window.__flicker.push(name); seen.delete(name); }
        });
      }, 15);
    });
    for (const n of ['flour', 'milk', 'sugar', 'salt']) {
      await page.evaluate((name) => { const r = Array.from(document.querySelectorAll('#shoppingByRecipe .shop-item')).find(x => x.querySelector('.shop-name').textContent === name); r.querySelector('label').click(); }, n);
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(lat * 3 + 1200);
    const flick = await page.evaluate(() => window.__flicker);
    const server = await page.evaluate(() => Object.keys(window.__serverWeek().checked).length);
    const shown = await page.$$eval('#shoppingByRecipe .shop-item input:checked', els => els.length);
    assert(flick.length === 0, `No tick flickers off while saving (${lat} ms latency)`, flick);
    assert(server === 4 && shown === 4, `No tick is lost (${lat} ms latency)`, { server, shown });
    await page.evaluate(() => { const w = window.__serverWeek(); w.checked = {}; window.__remoteWrite(w); });
    await page.waitForTimeout(300);
    assert((await page.$$eval('#shoppingByRecipe .shop-item input:checked', els => els.length)) === 0, `A change from another device still applies (${lat} ms)`);
    assert(errors.length === 0, 'No page errors', errors);
    await ctx.close();
  }

  console.log('\n=== 3. Link import ===');
  ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await ctx.addInitScript(() => {
    window.__calls = [];
    var sample = function () { return Promise.resolve({ text: '' }); };
    sample.json = function () { return Promise.resolve({ name: 'Web Tacos', baseServings: 6, prepMinutes: 10, cookMinutes: 20, ingredients: [{ amount: 2, unit: 'cup', name: 'beef' }], instructions: ['Cook.'] }); };
    var mcp = { callTool: function (s, t, i) { window.__calls.push({ s: s, t: t, i: i }); return Promise.resolve({ payload: { results: [{ url: i.urls ? i.urls[0] : '', title: 'Tacos', excerpts: ['2 cups beef'] }] } }); } };
    window.claude = { use: function (n) { return Promise.resolve(n === 'sample' ? sample : n === 'mcp' ? mcp : null); } };
  });
  page = await ctx.newPage();
  errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(FILE_PATH);
  await page.waitForTimeout(300);
  await page.click('#newRecipeBtn');
  await page.click('[data-action="choose-paste"]');
  await page.fill('#pasteText', 'Great tacos https://www.justtherecipe.com/?url=https://example.com/tacos');
  await page.click('[data-action="do-parse"]');
  await page.waitForTimeout(400);
  const calls = await page.evaluate(() => window.__calls);
  assert(calls.length === 1 && calls[0].s === 'Parallel Search' && calls[0].t === 'web_fetch' && calls[0].i.urls[0] === 'https://www.justtherecipe.com/?url=https://example.com/tacos', 'A pasted share-sheet link is fetched through Parallel Search', calls);
  assert((await page.inputValue('#rfName')) === 'Web Tacos' && (await page.inputValue('#rfServings')) === '6' && (await page.inputValue('#rfPrep')) === '10', 'The form fills in from the page, times included');
  assert((await page.inputValue('#rfSource')) === 'https://www.justtherecipe.com/?url=https://example.com/tacos', 'The link is kept as the source');
  assert(errors.length === 0, 'No page errors', errors);
  await ctx.close();

  await browser.close();
  console.log('\nPASS: ' + pass + '  FAIL: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
