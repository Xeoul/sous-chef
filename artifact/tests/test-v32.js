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

const RECIPES = {
  r1: { name: 'Curry', baseServings: 4, ingredients: [
    { amount: 1.5, unit: 'lb', name: 'chicken thighs' }, { amount: 0.333, unit: 'cup', name: 'sugar' },
    { amount: 0.5, unit: 'cup', name: 'cream' }, { amount: 0.42, unit: 'cup', name: 'water' },
    { amount: 1.5, unit: 'can', name: 'coconut milk' }, { amount: 3, unit: 'clove', name: 'garlic' },
    { amount: 250, unit: 'g', name: 'rice' }, { amount: 2.5, unit: 'each', name: 'eggs' }],
    instructions: ['Fry garlic 2 minutes.', 'Simmer 20 minutes.'], notes: 'Spicy!', sourceUrl: 'https://example.com/curry' },
  r2: { name: 'Toast', baseServings: 2, ingredients: [{ amount: 2, unit: 'slice', name: 'bread' }], instructions: ['Toast it.'] }
};

// window.claude mocks: sample (nutrition + prices), downloads, clipboard. db/assets only when asked.
function mockScript(opts) {
  return `
window.__saved = []; window.__prompts = []; window.__uploads = []; window.__deleted = [];
(function () {
  var sample = function () { return Promise.resolve({ text: '' }); };
  sample.json = function (p) {
    window.__prompts.push(p);
    if (/nutrition PER SERVING/.test(p)) {
      var ids = (p.match(/id: (\\w+)/g) || []).map(function (s) { return s.slice(4); });
      return Promise.resolve({ recipes: ids.map(function (id, i) { return { id: id, calories: 500 + i * 100, protein: 30, carbs: 40, fat: 20 }; }) });
    }
    if (/grocery item/.test(p)) {
      var n = (p.match(/^\\d+\\. /gm) || []).length;
      var items = []; for (var i = 1; i <= n; i++) items.push({ n: i, price: 2.5 });
      return Promise.resolve({ items: items });
    }
    return Promise.resolve({});
  };
  var downloads = { save: function (r) { window.__saved.push({ filename: r.filename, data: String(r.data) }); return Promise.resolve({ status: 'saved' }); } };
  ${opts.db ? `
  var store = { recipes: JSON.parse(JSON.stringify(${JSON.stringify(opts.dbRecipes || {})})), week: { items: {}, checked: {} } }, rl = [], wl = [];
  function rs() { return { docs: Object.keys(store.recipes).map(function (id) { return { id: id, exists: true, data: function () { return JSON.parse(JSON.stringify(store.recipes[id])); } }; }) }; }
  var db = {
    collection: function () { return { onSnapshot: function (n) { rl.push(n); n(rs()); return function () {}; },
      doc: function (id) { return { set: function (d) { store.recipes[id] = JSON.parse(JSON.stringify(d)); setTimeout(function () { rl.forEach(function (f) { f(rs()); }); }, 5); return Promise.resolve(); },
        delete: function () { delete store.recipes[id]; setTimeout(function () { rl.forEach(function (f) { f(rs()); }); }, 5); return Promise.resolve(); } }; } }; },
    doc: function () { return { onSnapshot: function (n) { wl.push(n); n({ exists: true, data: function () { return store.week; } }); return function () {}; }, set: function (d) { store.week = d; return Promise.resolve(); } }; }
  };
  window.__store = store;` : 'var db = null;'}
  var assets = ${opts.assets ? `{
    upload: function (blob, o) { var id = (Math.random().toString(16).slice(2) + '00000000000000000000000000000000').slice(0, 32); window.__uploads.push({ id: id, type: (o && o.type) || blob.type, size: blob.size }); return Promise.resolve({ id: id, url: '/_blob/' + id, sizeBytes: blob.size, contentType: 'image/jpeg' }); },
    delete: function (ref) { window.__deleted.push(ref); return Promise.resolve({ deleted: true }); },
    list: function () { return Promise.resolve({ assets: [], usage: {} }); } }` : 'null'};
  window.claude = { use: function (n) { return Promise.resolve(n === 'sample' ? sample : n === 'downloads' ? downloads : n === 'db' ? db : n === 'assets' ? assets : null); } };
})();
window.__clip = null;
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function (t) { window.__clip = t; return Promise.resolve(); } } });`;
}

async function open(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await ctx.addInitScript(mockScript(opts));
  if (!opts.db) {
    await ctx.addInitScript(({ recipes, week, tab }) => {
      if (sessionStorage.getItem('__seeded')) return;
      sessionStorage.setItem('__seeded', '1');
      localStorage.clear();
      localStorage.setItem('larder_recipes', JSON.stringify(recipes));
      localStorage.setItem('larder_week', JSON.stringify(week));
      localStorage.setItem('sous_chef_tab', tab);
      localStorage.setItem('sous_chef_shopping_view', 'recipe');
    }, { recipes: opts.recipes || RECIPES, week: opts.week || { items: { r1: 4 }, checked: {} }, tab: opts.tab || 'recipes' });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(opts.http ? BASE : FILE_PATH);
  await page.waitForTimeout(450);
  return { ctx, page, errors };
}
const stored = (page, key) => page.evaluate(k => JSON.parse(localStorage.getItem(k)), key);
const toast = (page) => page.evaluate(() => { const t = document.querySelector('#toastHost .toast:not(.leaving) .toast-msg'); return t ? t.textContent : ''; });

const http = require('http');
const fs = require('fs');
let server, BASE;
function startServer(jpeg) {
  return new Promise(res => {
    server = http.createServer((req, resp) => {
      if (req.url.startsWith('/_blob/')) { resp.writeHead(200, { 'content-type': 'image/png' }); resp.end(jpeg); return; }
      resp.writeHead(200, { 'content-type': 'text/html' }); resp.end(fs.readFileSync(path.resolve(__dirname, '..', 'sous-chef.html')));
    }).listen(0, () => { BASE = 'http://127.0.0.1:' + server.address().port + '/'; res(); });
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  // a real JPEG to "pick"
  const tmp = await browser.newPage();
  const photoB64 = await tmp.evaluate(() => { const c = document.createElement('canvas'); c.width = 1600; c.height = 1200; const g = c.getContext('2d'); g.fillStyle = '#c84'; g.fillRect(0, 0, 1600, 1200); g.fillStyle = '#284'; g.fillRect(400, 300, 800, 600); return c.toDataURL('image/png').split(',')[1]; });
  await tmp.close();
  const photoFile = { name: 'dinner.png', mimeType: 'image/png', buffer: Buffer.from(photoB64, 'base64') };
  await startServer(photoFile.buffer);

  console.log('\n=== 1. Friendlier amounts ===');
  let { ctx, page, errors } = await open(browser, { tab: 'cook' });
  const cookAmts = await page.$$eval('#cookContent .cook-ingredients li', els => els.map(e => Array.from(e.children).map(c => c.textContent.trim()).filter(Boolean).join(' ')));
  const has = (s) => cookAmts.some(t => t.startsWith(s));
  assert(has('1½ lb chicken'), '1.5 lb reads as 1½ lb', cookAmts);
  assert(has('⅓ cup sugar'), '0.333 cup reads as ⅓ cup (singular)', cookAmts);
  assert(has('½ cup cream'), '0.5 cup reads as ½ cup', cookAmts);
  assert(has('0.42 cup water'), 'An amount not near a kitchen fraction keeps its decimal', cookAmts);
  assert(has('1½ cans coconut'), 'Count units get plurals (1½ cans)', cookAmts);
  assert(has('3 cloves garlic'), '3 clove reads as 3 cloves', cookAmts);
  assert(has('8.82 oz rice'), 'Grams show as ounces in US units, with a decimal', cookAmts);
  assert(has('2½ eggs'), '"each" is dropped: 2½ eggs', cookAmts);
  await page.click('.tab-btn[data-tab="shop"]');
  await page.waitForTimeout(200);
  const row = async (name) => page.$eval(`#shoppingByRecipe .shop-item:has(.shop-name-text)`, () => null).catch(() => null) || page.evaluate((n) => { const r = Array.from(document.querySelectorAll('#shoppingByRecipe .shop-item')).find(x => x.querySelector('.shop-name-text').textContent === n); return r ? r.querySelector('.shop-amount, .descriptor-tag').textContent : null; }, name);
  const coco = await page.evaluate(() => { const r = Array.from(document.querySelectorAll('#shoppingByRecipe .shop-item')).find(x => x.querySelector('.shop-name-text').textContent === 'coconut milk'); return r.querySelector('.shop-amount').textContent; });
  assert(coco === '2 cans1½ needed', 'Shopping rounds whole items up to buy, noting what’s needed', coco);
  const eggs = await page.evaluate(() => { const r = Array.from(document.querySelectorAll('#shoppingByRecipe .shop-item')).find(x => x.querySelector('.shop-name-text').textContent === 'eggs'); return r.querySelector('.shop-amount').textContent; });
  assert(eggs === '32½ needed', '2.5 eggs → buy 3', eggs);
  const sugar = await page.evaluate(() => { const r = Array.from(document.querySelectorAll('#shoppingByRecipe .shop-item')).find(x => x.querySelector('.shop-name-text').textContent === 'sugar'); return r.querySelector('.shop-amount').textContent; });
  assert(sugar === '⅓ cup', 'Measured amounts aren’t rounded up', sugar);
  await page.click('#shopMoreBtn');
  await page.click('#unitToggle [data-system="metric"]');
  await page.waitForTimeout(150);
  const sugarMl = await page.evaluate(() => { const r = Array.from(document.querySelectorAll('#shoppingByRecipe .shop-item')).find(x => x.querySelector('.shop-name-text').textContent === 'sugar'); return r.querySelector('.shop-amount').textContent; });
  assert(sugarMl === '79 ml', 'Metric shows decimals, not fractions', sugarMl);
  await page.click('#unitToggle [data-system="us"]');
  await page.keyboard.press('Escape');

  console.log('\n=== 2. Every-week items ===');
  await page.fill('#addItemInput', 'coffee, paper towels');
  await page.press('#addItemInput', 'Enter');
  await page.waitForTimeout(150);
  await page.click('#shoppingByRecipe .shop-item:has-text("coffee") .repeat-btn');
  await page.waitForTimeout(150);
  assert(await page.getAttribute('#shoppingByRecipe .shop-item:has-text("coffee") .repeat-btn', 'aria-pressed') === 'true', 'Repeat button marks an item as every week');
  assert(/every week/.test(await toast(page)), 'Toast confirms it', await toast(page));
  let wk = await stored(page, 'larder_week');
  assert(wk.extras.find(x => x.name === 'coffee').every === true, 'Saved as every-week');
  await page.click('#shoppingByRecipe .shop-item:has-text("coffee") label');
  await page.waitForTimeout(200);
  await page.click('.tab-btn[data-tab="recipes"]');
  await page.click('#recipesMoreBtn'); await page.click('#newWeekBtn');
  await page.waitForTimeout(200);
  wk = await stored(page, 'larder_week');
  assert(wk.extras.length === 1 && wk.extras[0].name === 'coffee' && !Object.keys(wk.checked).length, 'New week keeps every-week items, unticked, and drops the rest', wk);
  assert(/kept 1 every-week item/.test(await toast(page)), 'New-week toast says what it kept', await toast(page));
  await page.click('#toastHost .toast-undo');
  await page.waitForTimeout(200);
  wk = await stored(page, 'larder_week');
  assert(wk.extras.length === 2 && wk.items.r1 === 4, 'Undo brings the old week back', wk);
  assert(errors.length === 0, 'No page errors (amounts)', errors);
  await ctx.close();

  console.log('\n=== 3. Share, print & save a recipe ===');
  ({ ctx, page, errors } = await open(browser, { tab: 'cook', week: { items: { r1: 2 }, checked: {} } }));
  await page.click('#cookContent [data-share-recipe="r1"]');
  await page.waitForTimeout(250);
  const txt = await page.inputValue('#shareText');
  assert(/^Curry\nServes 2/.test(txt) && /• 12 oz chicken thighs/.test(txt) && /• 1¼ eggs/.test(txt) && /1\. Fry garlic 2 minutes\./.test(txt) && /Notes\nSpicy!/.test(txt) && /Source: https:\/\/example\.com\/curry/.test(txt), 'Recipe text is scaled to the planned servings, with steps, notes and source', txt);
  assert(/for 2 servings, as planned/.test(await page.textContent('#modalBody .paste-tip')), 'Says which servings the amounts are for');
  await page.click('[data-action="copy-share"]');
  await page.waitForTimeout(150);
  assert(/Recipe copied/.test(await toast(page)), 'Copy works and says so', await toast(page));
  await page.click('#cookContent [data-share-recipe="r1"]');
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; window.__printHtml = document.getElementById('printCard').innerHTML; window.__printClass = document.documentElement.classList.contains('printing'); }; });
  await page.click('[data-action="print-recipe"]');
  const printed = await page.evaluate(() => ({ n: window.__printed, html: window.__printHtml, cls: window.__printClass }));
  assert(printed.n === 1 && printed.cls && /<h1>Curry<\/h1>/.test(printed.html) && /<ol><li>Fry garlic/.test(printed.html), 'Print lays out a clean recipe card', printed);
  await page.click('[data-action="save-recipe-file"]');
  await page.waitForTimeout(150);
  let saved = await page.evaluate(() => window.__saved);
  assert(saved.length === 1 && saved[0].filename === 'curry.html' && /<!doctype html>/.test(saved[0].data) && /<title>Curry<\/title>/.test(saved[0].data), 'Save as file offers a standalone .html recipe card', saved.map(s => s.filename));
  await page.click('#modalCloseBtn');
  assert(errors.length === 0, 'No page errors (share)', errors);
  await ctx.close();

  console.log('\n=== 4. Back up & restore ===');
  ({ ctx, page, errors } = await open(browser));
  await page.click('#recipesMoreBtn'); await page.click('#backupBtn');
  await page.waitForTimeout(200);
  assert(/Your 2 recipes/.test(await page.textContent('#modalBody')), 'Backup dialog counts your recipes');
  await page.click('[data-action="copy-backup"]');
  await page.waitForTimeout(150);
  const backup = await page.evaluate(() => window.__clip);
  const parsed = JSON.parse(backup);
  assert(parsed.app === 'Sous Chef' && Object.keys(parsed.recipes).join() === 'r1,r2', 'Copy backup puts every recipe on the clipboard', Object.keys(parsed.recipes || {}));
  await page.click('[data-action="save-backup"]');
  await page.waitForTimeout(150);
  saved = await page.evaluate(() => window.__saved);
  assert(saved.length === 1 && /^sous-chef-recipes-\d{4}-\d\d-\d\d\.json$/.test(saved[0].filename) && JSON.parse(saved[0].data).recipes.r2.name === 'Toast', 'Save as file offers a dated .json backup', saved[0] && saved[0].filename);
  await ctx.close();
  // restore into an empty box
  ({ ctx, page, errors } = await open(browser, { recipes: {}, week: { items: {}, checked: {} } }));
  await page.click('#recipesMoreBtn'); await page.click('#backupBtn');
  await page.waitForTimeout(200);
  await page.fill('#restoreText', 'not json');
  await page.click('[data-action="do-restore"]');
  assert(/isn’t a Sous Chef backup/.test(await page.textContent('#restoreError')), 'Garbage gets a clear error');
  const evil = JSON.parse(backup);
  evil.recipes.bad = { name: '<img src=x onerror="window.__pwned=1">Bad', baseServings: 2, sourceUrl: 'javascript:alert(1)', ingredients: [{ amount: 1, unit: 'cup', name: 'x' }], rating: 99, tags: ['ok', 7] };
  evil.recipes['../../etc'] = { name: 'Weird id', ingredients: [{ amount: 1, unit: '', name: 'y' }] };
  evil.recipes.empty = { name: 'No ingredients', ingredients: [] };
  await page.fill('#restoreText', JSON.stringify(evil));
  await page.click('[data-action="do-restore"]');
  await page.waitForTimeout(300);
  assert(/Restored — added 4 recipes/.test(await toast(page)), 'Restore adds the valid recipes and says how many', await toast(page));
  const box = await stored(page, 'larder_recipes');
  const bad = box.bad;
  assert(bad && bad.sourceUrl === '' && bad.rating === 0 && JSON.stringify(bad.tags) === '["ok"]', 'Restored data is cleaned (no javascript: link, bad rating, bad tags)', bad);
  assert(!('../../etc' in box) && Object.values(box).some(r => r.name === 'Weird id') && !Object.values(box).some(r => r.name === 'No ingredients'), 'Odd ids get new ones; recipes with no ingredients are skipped');
  assert(!(await page.evaluate(() => window.__pwned)) && /<img/.test(await page.textContent('#recipeList')), 'Names are shown as text, never run');
  await page.click('#toastHost .toast-undo');
  await page.waitForTimeout(250);
  assert(Object.keys(await stored(page, 'larder_recipes')).length === 0, 'Undo removes what the restore added');
  await page.click('#recipesMoreBtn'); await page.click('#backupBtn');
  await page.waitForTimeout(150);
  await page.setInputFiles('#restoreFile', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await page.waitForTimeout(400);
  assert(Object.keys(await stored(page, 'larder_recipes')).join() === 'r1,r2', 'Restoring from a chosen file works');
  assert(errors.length === 0, 'No page errors (backup)', errors);
  await ctx.close();

  console.log('\n=== 5. Photos on this device ===');
  ({ ctx, page, errors } = await open(browser));
  await page.click('#recipeList .recipe-card:has-text("Toast") [data-action="edit"]');
  await page.waitForTimeout(200);
  assert((await page.textContent('#rfPhotoPick')) === 'Add photo', 'Form offers "Add photo"');
  await page.setInputFiles('#rfPhotoFile', photoFile);
  await page.waitForTimeout(500);
  const prevSrc = await page.getAttribute('#rfPhotoPreview img', 'src');
  assert(/^data:image\/jpeg;base64,/.test(prevSrc) && prevSrc.length < 60000, 'Photo is shrunk to a small JPEG and previewed', prevSrc && prevSrc.length);
  await page.click('[data-action="save-recipe"]');
  await page.waitForTimeout(250);
  let toastRec = (await stored(page, 'larder_recipes')).r2;
  assert(/^data:image\/jpeg/.test(toastRec.photo), 'Photo saved with the recipe');
  assert(await page.locator('#recipeList .recipe-card:has-text("Toast") .tile.has-photo img.tile-photo').count() === 1, 'Recipe card tile shows the photo');
  const dims = await page.evaluate(() => { const i = document.querySelector('.tile-photo'); return [i.naturalWidth, i.naturalHeight]; });
  assert(dims[0] === 480 && dims[1] === 360, 'Shrunk to 480px on the long side', dims);
  await page.click('#recipeList .recipe-card:has-text("Toast") .plan-toggle input');
  await page.click('.tab-btn[data-tab="cook"]');
  await page.waitForTimeout(300);
  assert(await page.locator('.cook-recipe-group[data-rkey="r2"] > img.cook-hero').count() === 1, 'Cook view shows a big photo');
  await page.click('.tab-btn[data-tab="recipes"]');
  await page.click('#recipeList .recipe-card:has-text("Toast") [data-action="edit"]');
  await page.waitForTimeout(200);
  await page.click('[data-action="remove-photo"]');
  await page.click('[data-action="save-recipe"]');
  await page.waitForTimeout(250);
  toastRec = (await stored(page, 'larder_recipes')).r2;
  assert(!toastRec.photo && await page.locator('#recipeList .tile-photo').count() === 0, 'Remove takes the photo off');
  assert(errors.length === 0, 'No page errors (local photos)', errors);
  await ctx.close();

  console.log('\n=== 6. Photos in synced mode (file store) ===');
  ({ ctx, page, errors } = await open(browser, { db: true, assets: true, dbRecipes: RECIPES, http: true }));
  await page.click('#recipeList .recipe-card:has-text("Toast") [data-action="edit"]');
  await page.waitForTimeout(200);
  await page.setInputFiles('#rfPhotoFile', photoFile);
  await page.waitForTimeout(600);
  let ups = await page.evaluate(() => window.__uploads);
  assert(ups.length === 1 && ups[0].type === 'image/jpeg' && ups[0].size > 0, 'Photo uploads to the file store as a JPEG', ups);
  await page.click('#modalCloseBtn');
  await page.waitForTimeout(200);
  let dels = await page.evaluate(() => window.__deleted);
  assert(dels.length === 1 && dels[0] === ups[0].id, 'Closing without saving deletes the unused upload', dels);
  await page.click('#recipeList .recipe-card:has-text("Toast") [data-action="edit"]');
  await page.waitForTimeout(200);
  await page.setInputFiles('#rfPhotoFile', photoFile);
  await page.waitForTimeout(600);
  await page.click('[data-action="save-recipe"]');
  await page.waitForTimeout(300);
  ups = await page.evaluate(() => window.__uploads);
  const firstId = ups[1].id;
  const storedPhoto = await page.evaluate(() => window.__store.recipes.r2.photo);
  assert(storedPhoto === firstId, 'Saved recipe keeps the asset id (not a URL)', storedPhoto);
  assert((await page.getAttribute('#recipeList .recipe-card:has-text("Toast") .tile-photo', 'src')) === '/_blob/' + firstId, 'Tile shows it from /_blob/<id>');
  await page.click('#recipeList .recipe-card:has-text("Toast") [data-action="edit"]');
  await page.waitForTimeout(200);
  await page.setInputFiles('#rfPhotoFile', photoFile);
  await page.waitForTimeout(600);
  await page.click('[data-action="save-recipe"]');
  await page.waitForTimeout(300);
  dels = await page.evaluate(() => window.__deleted);
  assert(dels.includes(firstId), 'Replacing a photo deletes the old one', dels);
  const secondId = await page.evaluate(() => window.__store.recipes.r2.photo);
  await page.click('#recipeList .recipe-card:has-text("Toast") [data-action="edit"]');
  await page.click('#modalBody [data-action="delete"]');
  await page.click('#modalBody [data-action="confirm-delete"]');
  await page.waitForTimeout(1000);
  assert(!(await page.evaluate(() => window.__deleted)).includes(secondId), 'Deleting a recipe keeps its photo during the Undo window');
  await page.waitForTimeout(9000);
  assert((await page.evaluate(() => window.__deleted)).includes(secondId), '…then removes it');
  assert(errors.length === 0, 'No page errors (synced photos)', errors);
  await ctx.close();
  ({ ctx, page, errors } = await open(browser, { db: true, assets: false, dbRecipes: RECIPES }));
  await page.click('#recipeList .recipe-card:has-text("Toast") [data-action="edit"]');
  await page.waitForTimeout(200);
  assert(await page.locator('#rfPhotoPick').count() === 0, 'Without file-store access (read-only viewer) there’s no photo picker');
  await ctx.close();

  console.log('\n=== 7. Nutrition & cost ===');
  ({ ctx, page, errors } = await open(browser, { week: { items: { r1: 4, r2: 2 }, checked: {}, extras: [{ id: 'e1', name: 'coffee' }] } }));
  await page.click('#recipesMoreBtn'); await page.click('#nutritionBtn');
  await page.waitForTimeout(200);
  assert(/Not estimated yet/.test(await page.textContent('#modalBody')), 'Unestimated recipes are marked');
  await page.click('[data-action="estimate-nutrition"]');
  await page.waitForTimeout(400);
  const nutText = await page.textContent('#modalBody');
  assert(/500 kcal · 30 g protein/.test(nutText) && /600 kcal/.test(nutText), 'Per-serving estimates listed per recipe', nutText.slice(0, 300));
  assert(/533/.test(await page.textContent('#modalBody .nut-total')) && /3,200 kcal for the whole plan/.test(nutText), 'Week average and whole-plan total (servings-weighted)', await page.textContent('#modalBody .nut-total'));
  let r1 = (await stored(page, 'larder_recipes')).r1;
  assert(r1.nutrition && r1.nutrition.calories === 500 && r1.nutrition.sig, 'Estimate saved on the recipe', r1.nutrition);
  await page.click('[data-action="estimate-cost"]');
  await page.waitForTimeout(400);
  assert(/≈ \$25\.00/.test(await page.textContent('#modalBody .cost-big')), 'Cost estimate totals the list', await page.textContent('#modalBody .cost-big'));
  const costPrompt = await page.evaluate(() => window.__prompts[window.__prompts.length - 1]);
  assert(/2 cans coconut milk/.test(costPrompt) && /coffee/.test(costPrompt), 'Priced as bought (whole cans) and includes your own items', costPrompt.slice(0, 200));
  await page.click('#modalCloseBtn');
  await page.waitForTimeout(250);
  assert(/500 kcal/.test(await page.textContent('#recipeList .recipe-card:has-text("Curry") .recipe-extra')), 'Recipe card shows kcal');
  await page.click('.tab-btn[data-tab="shop"]');
  await page.waitForTimeout(200);
  assert((await page.textContent('#costChip')) === '≈ $25.00', 'Shopping list shows the estimated total', await page.textContent('#costChip'));
  await page.fill('#addItemInput', 'tea');
  await page.press('#addItemInput', 'Enter');
  await page.waitForTimeout(200);
  assert((await page.textContent('#costChip')) === '≈ $25.00+', 'A new unpriced item marks the total with +', await page.textContent('#costChip'));
  await page.click('.recipe-shop-group:has-text("Curry") .stepper[data-delta="1"]').catch(() => {});
  await page.click('.tab-btn[data-tab="recipes"]');
  await page.click('#recipeList .recipe-card:has-text("Curry") [data-delta="1"]');
  await page.click('.tab-btn[data-tab="shop"]');
  await page.waitForTimeout(200);
  const chipAfter = await page.textContent('#costChip');
  assert(chipAfter !== '≈ $25.00+' && /\+$/.test(chipAfter), 'Total follows servings changes', chipAfter);
  // editing ingredients retires the stale estimate
  await page.click('.tab-btn[data-tab="recipes"]');
  await page.click('#recipeList .recipe-card:has-text("Curry") [data-action="edit"]');
  await page.waitForTimeout(200);
  await page.fill('#rfServings', '6');
  await page.click('[data-action="save-recipe"]');
  await page.waitForTimeout(200);
  assert(!/kcal/.test(await page.textContent('#recipeList .recipe-card:has-text("Curry") .recipe-extra')), 'Changing the recipe hides the old (now wrong) estimate');
  assert(errors.length === 0, 'No page errors (nutrition)', errors);
  await ctx.close();

  await browser.close();
  server.close();
  console.log('\nPASS: ' + pass + '  FAIL: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
