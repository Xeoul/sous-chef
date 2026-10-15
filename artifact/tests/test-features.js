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
  r1: { name: 'Green Curry', baseServings: 4, favorite: false, notes: 'Use Thai basil if you can find it.', sourceUrl: 'https://example.com/curry',
    ingredients: [
      { amount: 2, unit: 'can', name: 'coconut milk' }, { amount: 1, unit: 'tsp', name: 'black pepper' },
      { amount: 1, unit: 'each', name: 'eggplant' }, { amount: 2, unit: 'cup', name: 'rice' },
      { amount: 1, unit: 'lb', name: 'chicken thighs' }, { amount: 0, unit: 'to taste', name: 'salt' }],
    instructions: ['Simmer for 10 minutes.', 'Rest 1 hr 30 min before serving.', 'Serve.'] },
  r2: { name: 'Apple Pie', baseServings: 8, favorite: false, ingredients: [{ amount: 6, unit: 'each', name: 'apple' }, { amount: 2, unit: 'cup', name: 'flour' }], instructions: ['Bake.'] },
  r3: { name: 'Banana Bread', baseServings: 8, favorite: false, ingredients: [{ amount: 3, unit: 'each', name: 'banana' }, { amount: 2, unit: 'cup', name: 'flour' }], instructions: [] },
  r4: { name: 'Zucchini Soup', baseServings: 4, favorite: false, ingredients: [{ amount: 2, unit: 'each', name: 'zucchini' }, { amount: 4, unit: 'cup', name: 'chicken stock' }], instructions: [] }
};

async function openLocal(browser, opts) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await ctx.addInitScript(({ recipes, week, tab, view }) => {
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    localStorage.setItem('larder_recipes', JSON.stringify(recipes));
    localStorage.setItem('larder_week', JSON.stringify(week));
    localStorage.setItem('sous_chef_tab', tab);
    localStorage.setItem('sous_chef_shopping_view', view);
  }, Object.assign({ recipes: RECIPES, week: { items: { r1: 4 }, checked: {}, extras: [], pantry: {} }, tab: 'shop', view: 'combined' }, opts || {}));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(FILE_PATH);
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}

const toastText = (page) => page.evaluate(() => { const t = document.querySelector('#toastHost .toast:not(.leaving) .toast-msg'); return t ? t.textContent : ''; });
const clickUndo = (page) => page.click('#toastHost .toast:not(.leaving) .toast-undo');
const sectionOf = (page, name) => page.evaluate((n) => {
  const row = Array.from(document.querySelectorAll('#shoppingCombined .shop-item')).find(r => r.querySelector('.shop-name').textContent.trim() === n);
  return row ? row.closest('.shop-section').querySelector('.section-name').textContent : null;
}, name);
const row = (page, name, scope) => page.locator((scope || '#shoppingCombined') + ' .shop-item').filter({ has: page.locator('.shop-name', { hasText: new RegExp('^' + name + '$') }) });
const combinedNames = (page) => page.$$eval('#shoppingCombined .shop-item .shop-name', els => els.map(e => e.textContent.trim()));

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });

  // ================= Shopping =================
  console.log('\n=== 1. Aisle sections ===');
  let { ctx, page, errors } = await openLocal(browser);
  assert(await sectionOf(page, 'coconut milk') === 'Pantry', 'coconut milk filed under Pantry, not Dairy', await sectionOf(page, 'coconut milk'));
  assert(/^Spices/.test(await sectionOf(page, 'black pepper')), 'black pepper filed under Spices, not Produce', await sectionOf(page, 'black pepper'));
  assert(await sectionOf(page, 'eggplant') === 'Produce', 'eggplant filed under Produce, not Dairy', await sectionOf(page, 'eggplant'));
  assert(/Meat/.test(await sectionOf(page, 'chicken thighs') || ''), 'chicken thighs filed under Meat', await sectionOf(page, 'chicken thighs'));
  const spiceNames = await page.$$eval('#shoppingCombined .shop-section', secs => {
    const s = secs.find(x => /^Spices/.test(x.querySelector('.section-name').textContent));
    return s ? Array.from(s.querySelectorAll('.shop-name')).map(e => e.textContent.trim()) : [];
  });
  assert(spiceNames.join() === 'black pepper,salt', 'Measured items listed before "to taste" ones', spiceNames);

  console.log('\n=== 2. Your own items ===');
  await page.fill('#addItemInput', 'paper towels, coffee, Paper Towels');
  await page.press('#addItemInput', 'Enter');
  await page.waitForTimeout(150);
  let extras = await page.$$eval('#shoppingCombined .shop-section', secs => {
    const s = secs.find(x => x.querySelector('.section-name').textContent === 'Your items');
    return s ? Array.from(s.querySelectorAll('.shop-name')).map(e => e.textContent.trim()) : [];
  });
  assert(extras.join() === 'paper towels,coffee', 'Comma list adds each item once (dupes ignored)', extras);
  assert((await page.inputValue('#addItemInput')) === '', 'Add box clears after adding');
  const totalBefore = await page.textContent('#itemCount');
  await page.click('#shoppingCombined [data-remove-extra]');
  await page.waitForTimeout(150);
  assert(/Removed/.test(await toastText(page)), 'Removing an item shows a toast', await toastText(page));
  assert(!(await combinedNames(page)).includes('paper towels'), 'Removed item disappears');
  await clickUndo(page);
  await page.waitForTimeout(150);
  const afterUndo = await combinedNames(page);
  assert(afterUndo.includes('paper towels') && afterUndo.indexOf('paper towels') < afterUndo.indexOf('coffee'), 'Undo restores the item in its old place', afterUndo);

  console.log('\n=== 3. Checked items sink ===');
  const pantryOrder0 = await page.$$eval('#shoppingCombined .shop-section', secs => {
    const s = secs.find(x => x.querySelector('.section-name').textContent === 'Pantry');
    return Array.from(s.querySelectorAll('.shop-name')).map(e => e.textContent.trim());
  });
  const firstPantry = pantryOrder0[0];
  await row(page, firstPantry).locator('label').click();
  await page.waitForTimeout(250);
  let order = await page.$$eval('#shoppingCombined .shop-section', secs => {
    const s = secs.find(x => x.querySelector('.section-name').textContent === 'Pantry');
    return Array.from(s.querySelectorAll('.shop-name')).map(e => e.textContent.trim());
  });
  assert(order[0] === firstPantry, 'Checked row holds its place briefly', order);
  await page.waitForTimeout(1000);
  order = await page.$$eval('#shoppingCombined .shop-section', secs => {
    const s = secs.find(x => x.querySelector('.section-name').textContent === 'Pantry');
    return Array.from(s.querySelectorAll('.shop-name')).map(e => e.textContent.trim());
  });
  assert(order[order.length - 1] === firstPantry, 'Then sinks below unchecked rows', order);
  assert(await page.evaluate(() => { const s = Array.from(document.querySelectorAll('.shop-section')).find(x => x.querySelector('.section-name').textContent === 'Pantry'); return s.querySelector('.section-meta').textContent; }) === '1 left', 'Section header counts what is left');

  console.log('\n=== 4. Pantry ===');
  await row(page, 'salt').locator('[data-pantry]').click();
  await page.waitForTimeout(150);
  assert(/moved to your pantry/.test(await toastText(page)), 'Moving to pantry shows toast', await toastText(page));
  assert(!(await combinedNames(page)).includes('salt'), 'Pantry item leaves the list');
  assert(await page.isVisible('#pantrySection') && /· 1/.test(await page.textContent('#pantrySummary')), 'Pantry section shows the count');
  await clickUndo(page);
  await page.waitForTimeout(150);
  assert((await combinedNames(page)).includes('salt') && !(await page.isVisible('#pantrySection')), 'Undo puts it back on the list');
  await row(page, 'salt').locator('[data-pantry]').click();
  await page.waitForTimeout(100);
  await page.click('#pantrySection summary');
  await page.click('[data-unpantry="salt"]');
  await page.waitForTimeout(150);
  assert((await combinedNames(page)).includes('salt'), '"Need it" brings a pantry item back');
  await row(page, 'salt').locator('[data-pantry]').click();
  await page.waitForTimeout(100);
  await page.click('#viewToggle [data-view="recipe"]');
  await page.waitForTimeout(200);
  const byRecipe = await page.$$eval('#shoppingByRecipe .shop-name', els => els.map(e => e.textContent.trim()));
  assert(!byRecipe.includes('salt') && byRecipe.includes('coffee'), 'By-recipe view also hides pantry items and shows your items', byRecipe);

  console.log('\n=== 5. Share text ===');
  await page.evaluate(() => {
    window.__shared = null;
    Object.defineProperty(navigator, 'share', { configurable: true, value: (d) => { window.__shared = d.text; return Promise.resolve(); } });
  });
  await page.click('#shareListBtn');
  await page.waitForTimeout(100);
  const shared = await page.evaluate(() => window.__shared) || '';
  assert(/^Shopping list/.test(shared) && /Your items\n• paper towels\n• coffee/.test(shared), 'Share text leads with your items', shared);
  assert(/Green Curry/.test(shared) && /• 2 cups rice/.test(shared), 'Share text lists recipe items with amounts', shared);
  assert(!/salt/.test(shared) && !new RegExp('• .*' + firstPantry).test(shared), 'Share text leaves out pantry and checked items', shared);
  await page.evaluate(() => { delete navigator.share; Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
  await page.click('#shareListBtn');
  await page.waitForTimeout(200);
  assert(await page.isVisible('#shareText') && /Shopping list/.test(await page.inputValue('#shareText')), 'Falls back to a copyable sheet when share/clipboard are blocked');
  await page.click('#modalCloseBtn');
  await page.waitForTimeout(300);

  console.log('\n=== 6. Start new week ===');
  await page.click('.tab-btn[data-tab="recipes"]');
  await page.waitForTimeout(200);
  await page.click('#recipesMoreBtn'); assert(await page.isVisible('#newWeekBtn'), '"Start new week" shown when something is planned');
  await page.click('#newWeekBtn');
  await page.waitForTimeout(200);
  let wk = await page.evaluate(() => JSON.parse(localStorage.getItem('larder_week')));
  assert(!Object.keys(wk.items).length && !wk.extras.length && !Object.keys(wk.checked).length && wk.pantry.salt, 'New week clears plan/items/checks but keeps the pantry', wk);
  await clickUndo(page);
  await page.waitForTimeout(200);
  wk = await page.evaluate(() => JSON.parse(localStorage.getItem('larder_week')));
  assert(wk.items.r1 === 4 && wk.extras.length === 2 && Object.keys(wk.checked).length === 1, 'Undo restores the week', wk);
  assert(errors.length === 0, 'No page errors (shopping)', errors);
  await ctx.close();

  // ================= Cook =================
  console.log('\n=== 7. Cook mode ===');
  ({ ctx, page, errors } = await openLocal(browser, { tab: 'cook' }));
  const chips = await page.$$eval('#cookContent .timer-chip', els => els.map(e => [e.getAttribute('data-seconds'), e.textContent.trim()]));
  assert(chips.length === 2 && chips[0][0] === '600' && chips[1][0] === '5400', 'Durations in steps become timer chips (10 min, 1 hr 30 min)', chips);
  assert(/Thai basil/.test(await page.textContent('#cookContent .cook-notes')) && await page.isVisible('#cookContent .cook-notes'), 'Recipe notes shown in Cook');
  const src = await page.getAttribute('#cookContent .cook-sub a', 'href').catch(() => null);
  assert(src === 'https://example.com/curry', 'Source link shown in Cook', src);
  await page.click('#cookContent .cook-step >> nth=0 >> .step-num');
  await page.waitForTimeout(150);
  assert(await page.evaluate(() => document.querySelector('#cookContent .cook-step').classList.contains('is-done')), 'Tapping a step number marks it done');
  assert(/1 of 3 steps done/.test(await page.textContent('#cookContent .cook-sub')), 'Progress line counts done steps', await page.textContent('#cookContent .cook-sub'));
  await page.reload();
  await page.waitForTimeout(400);
  assert(await page.evaluate(() => document.querySelector('#cookContent .cook-step').classList.contains('is-done')), 'Step progress survives a reload');
  await page.click('#cookContent [data-reset-steps]');
  await page.waitForTimeout(150);
  assert(!(await page.evaluate(() => document.querySelector('#cookContent .cook-step.is-done'))), 'Reset steps clears progress');

  await page.click('#cookContent .timer-chip >> nth=0');
  await page.waitForTimeout(300);
  assert(await page.locator('#timerTray .timer-card').count() === 1, 'Tapping a chip starts a timer in the tray');
  const t1 = await page.textContent('#timerTray .timer-time, #timerTray .timer-card').catch(() => '');
  assert(/9:5\d|10:00/.test(t1), 'Timer counts down from 10:00', t1);
  await page.click('#timerTray [data-timer-act="add"]');
  await page.waitForTimeout(300);
  assert(/10:5\d|11:00/.test(await page.textContent('#timerTray .timer-card')), '+1 adds a minute', await page.textContent('#timerTray .timer-card'));
  await page.click('#timerTray [data-timer-act="pause"]');
  const p1 = await page.textContent('#timerTray .timer-card');
  await page.waitForTimeout(1300);
  assert(p1 === await page.textContent('#timerTray .timer-card'), 'Pause stops the countdown');
  await page.click('#timerTray [data-timer-act="dismiss"]');
  await page.waitForTimeout(500);
  assert(await page.locator('#timerTray .timer-card').count() === 0, 'Dismiss removes the timer');
  // A finished timer turns into an alarm.
  await page.evaluate(() => { const c = document.querySelector('#cookContent .timer-chip'); c.setAttribute('data-seconds', '1'); c.click(); });
  await page.waitForTimeout(1700);
  assert(await page.evaluate(() => !!document.querySelector('#timerTray .timer-card.is-done')), 'Finished timer shows as done');
  assert(errors.length === 0, 'No page errors (cook)', errors);
  await ctx.close();

  // ================= Recipe box =================
  console.log('\n=== 8. Search, favorites, sort ===');
  ({ ctx, page, errors } = await openLocal(browser, { tab: 'recipes' }));
  const names = () => page.$$eval('#recipeList .recipe-card .recipe-name', els => els.map(e => e.textContent.trim()));
  assert((await names()).join() === 'Apple Pie,Banana Bread,Green Curry,Zucchini Soup', 'Recipes listed A–Z', await names());
  assert(await page.isVisible('#recipeSearch'), 'Search shows with 4+ recipes');
  await page.fill('#recipeSearch', 'flour');
  await page.waitForTimeout(150);
  assert((await names()).join() === 'Apple Pie,Banana Bread', 'Search matches ingredients', await names());
  await page.fill('#recipeSearch', 'xyz');
  await page.waitForTimeout(150);
  assert(await page.isVisible('#recipeNoMatch') && /xyz/.test(await page.textContent('#recipeNoMatch')), 'No-match message names the query');
  await page.fill('#recipeSearch', '');
  await page.waitForTimeout(150);
  await page.click('#recipeList .recipe-card:has-text("Zucchini Soup") [data-action="favorite"]');
  await page.waitForTimeout(200);
  assert((await names())[0] === 'Zucchini Soup', 'Favorites sort to the top', await names());
  assert(await page.isVisible('#favFilterBtn'), 'Favorites filter appears once there is a favorite');
  await page.click('#favFilterBtn');
  await page.waitForTimeout(150);
  assert((await names()).join() === 'Zucchini Soup', 'Favorites filter shows only favorites', await names());
  await page.click('#favFilterBtn');
  await page.waitForTimeout(150);

  console.log('\n=== 9. Notes, source, duplicate ===');
  await page.click('#recipeList .recipe-card:has-text("Apple Pie") [data-action="edit"]');
  await page.waitForTimeout(200);
  await page.fill('#rfNotes', 'Grandma’s version.');
  await page.fill('#rfSource', 'javascript:alert(1)');
  await page.click('[data-action="save-recipe"]');
  await page.waitForTimeout(150);
  assert(await page.isVisible('#rfName') && /source link/.test(await page.textContent('#rfError')), 'javascript: source link is rejected', await page.textContent('#rfError').catch(() => ''));
  await page.fill('#rfSource', 'www.example.com/pie');
  await page.click('[data-action="save-recipe"]');
  await page.waitForTimeout(300);
  let stored = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('larder_recipes'))).find(r => r.name === 'Apple Pie'));
  assert(stored.notes === 'Grandma’s version.' && stored.sourceUrl === 'https://www.example.com/pie', 'Notes saved; bare link gets https://', stored);
  await page.click('#recipeList .recipe-card:has-text("Apple Pie") [data-action="edit"]');
  await page.waitForTimeout(200);
  await page.click('[data-action="duplicate"]');
  await page.waitForTimeout(300);
  assert((await page.inputValue('#rfName')) === 'Apple Pie (copy)', 'Duplicate opens the copy for editing', await page.inputValue('#rfName'));
  await page.fill('#rfName', 'Pear Pie');
  await page.click('[data-action="save-recipe"]');
  await page.waitForTimeout(300);
  const all = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('larder_recipes'))).map(r => r.name).sort());
  assert(all.join() === 'Apple Pie,Banana Bread,Green Curry,Pear Pie,Zucchini Soup', 'Copy saved separately; original kept', all);

  console.log('\n=== 10. Delete with Undo ===');
  await page.click('#recipeList .recipe-card:has-text("Green Curry") [data-action="edit"]');
  await page.waitForTimeout(200);
  await page.click('#modalBody [data-action="delete"]');
  await page.click('#modalBody [data-action="confirm-delete"]');
  await page.waitForTimeout(300);
  assert(!(await names()).includes('Green Curry'), 'Recipe deleted');
  await clickUndo(page);
  await page.waitForTimeout(300);
  assert((await names()).includes('Green Curry'), 'Undo brings the recipe back');
  wk = await page.evaluate(() => JSON.parse(localStorage.getItem('larder_week')));
  assert(wk.items.r1 === 4, 'Undo also restores it to the plan', wk);
  assert(errors.length === 0, 'No page errors (recipe box)', errors);
  await ctx.close();

  // ================= Smart link paste + synced recipes =================
  console.log('\n=== 11. Link paste (justtherecipe-style) & synced saves ===');
  const ctx2 = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await ctx2.addInitScript(() => {
    window.__calls = [];
    var store = { recipes: {}, week: null }, rl = [], wl = [];
    var LAT = 400;
    function rs(snap) { return { docs: Object.keys(snap).map(function (id) { return { id: id, exists: true, data: function () { return snap[id]; } }; }) }; }
    function notify() { var s = JSON.parse(JSON.stringify(store.recipes)); setTimeout(function () { rl.forEach(function (f) { f(rs(s)); }); }, LAT); }
    window.__staleSnapshot = function () { rl.forEach(function (f) { f(rs({})); }); };
    var db = {
      collection: function () { return {
        onSnapshot: function (n) { rl.push(n); n(rs({})); return function () {}; },
        doc: function (id) { return {
          set: function (d) { store.recipes[id] = d; notify(); return new Promise(function (r) { setTimeout(r, LAT); }); },
          delete: function () { delete store.recipes[id]; notify(); return new Promise(function (r) { setTimeout(r, LAT); }); } }; } }; },
      doc: function () { return {
        onSnapshot: function (n) { wl.push(n); n({ exists: false, data: function () { return null; } }); return function () {}; },
        set: function (d) { store.week = d; return Promise.resolve(); } }; }
    };
    var sample = function () { return Promise.resolve({ text: '' }); };
    sample.json = function (p) { return Promise.resolve({ name: 'Fetched Tacos', baseServings: 4, ingredients: [{ amount: 1, unit: 'lb', name: 'beef' }], instructions: ['Cook.'] }); };
    var mcp = { callTool: function (s, t, i) { window.__calls.push({ tool: t, input: i });
      if (t === 'web_fetch' && /ratelimited/.test(i.urls[0])) return Promise.reject({ code: 'tool_error', message: "You've hit the free-tier rate limit for Parallel Search MCP. Add your API key." });
      if (t === 'web_fetch' && /(blocked|walled)/.test(i.urls[0]) && (i.allow_live_fetch !== false || /walled/.test(i.urls[0])))
        return Promise.resolve({ payload: { results: [], errors: [{ url: i.urls[0], error_type: 'http_error', http_status_code: 402, content: null }] } });
      if (t === 'web_fetch') return Promise.resolve({ payload: { results: [{ url: i.urls[0], title: 'Tacos', excerpts: ['1 lb beef'] }] } });
      return Promise.resolve({ payload: { results: [] } }); } };
    window.claude = { use: function (n) { return Promise.resolve(n === 'db' ? db : n === 'sample' ? sample : n === 'mcp' ? mcp : null); } };
  });
  const p2 = await ctx2.newPage();
  const e2 = [];
  p2.on('pageerror', e => e2.push(e.message));
  await p2.goto(FILE_PATH);
  await p2.waitForTimeout(300);
  const fetchedUrl = async (how, text) => {
    await p2.evaluate(() => { window.__calls = []; });
    await p2.click('#newRecipeBtn');
    await p2.waitForTimeout(100);
    await p2.click('[data-action="choose-paste"]');
    await p2.waitForTimeout(100);
    if (how === 'search') { await p2.fill('#searchQuery', text); await p2.click('[data-action="do-search"]'); }
    else { await p2.fill('#pasteText', text); await p2.click('[data-action="do-parse"]'); }
    await p2.waitForTimeout(300);
    const calls = await p2.evaluate(() => window.__calls);
    return calls;
  };
  let calls = await fetchedUrl('paste', 'Best street tacos you will ever make https://www.justtherecipe.com/?url=https://example.com/tacos');
  assert(calls.length === 1 && calls[0].tool === 'web_fetch' && calls[0].input.urls[0] === 'https://www.justtherecipe.com/?url=https://example.com/tacos', 'Share-sheet paste (title + link) fetches the link', calls);
  assert((await p2.inputValue('#rfName')) === 'Fetched Tacos', 'Parsed recipe prefilled');
  assert((await p2.inputValue('#rfSource')) === 'https://www.justtherecipe.com/?url=https://example.com/tacos', 'Source link prefilled from the imported URL', await p2.inputValue('#rfSource'));
  await p2.click('[data-action="save-recipe"]');
  await p2.waitForTimeout(50);
  const shownNow = await p2.$$eval('#recipeList .recipe-name', els => els.map(e => e.textContent.trim()));
  assert(shownNow.includes('Fetched Tacos'), 'Synced save shows immediately (before the database confirms)', shownNow);
  await p2.evaluate(() => window.__staleSnapshot());
  await p2.waitForTimeout(50);
  const afterStale = await p2.$$eval('#recipeList .recipe-name', els => els.map(e => e.textContent.trim()));
  assert(afterStale.includes('Fetched Tacos'), 'A stale snapshot while saving does not make it vanish', afterStale);
  await p2.waitForTimeout(900);
  const settled = await p2.$$eval('#recipeList .recipe-name', els => els.map(e => e.textContent.trim()));
  assert(settled.join() === 'Fetched Tacos', 'Settles on the server copy', settled);

  calls = await fetchedUrl('search', 'example.com/recipes/pad-thai');
  assert(calls.length === 1 && calls[0].tool === 'web_fetch' && calls[0].input.urls[0] === 'https://example.com/recipes/pad-thai', 'Link without https:// in the search box imports directly', calls);
  await p2.click('#modalCloseBtn');
  await p2.waitForTimeout(300);
  calls = await fetchedUrl('search', 'pad thai');
  assert(calls.length === 1 && calls[0].tool === 'web_search', 'Plain words still run a web search', calls);
  await p2.click('#modalCloseBtn');
  await p2.waitForTimeout(300);
  calls = await fetchedUrl('paste', '2 cups flour\n1 tsp salt\nSee https://example.com for more\nMix well.');
  assert(calls.length === 0, 'An ingredient list that mentions a link is parsed as text, not fetched', calls);
  await p2.click('#modalCloseBtn');
  await p2.waitForTimeout(300);
  calls = await fetchedUrl('paste', 'https://blocked.example.com/pie');
  assert(calls.length === 2 && calls[0].input.allow_live_fetch === undefined && calls[1].input.allow_live_fetch === false, 'A site that blocks the live read is retried from the cached copy', calls.map(c => c.input.allow_live_fetch));
  assert(/directions/.test(calls[0].input.objective) && calls[0].input.objective.length <= 200, 'Fetch asks for the directions too (objective within 200 chars)', calls[0].input.objective);
  assert((await p2.inputValue('#rfName').catch(() => '')) === 'Fetched Tacos', 'Cached copy gets imported');
  await p2.click('#modalCloseBtn');
  await p2.waitForTimeout(300);
  calls = await fetchedUrl('paste', 'https://walled.example.com/pie');
  const walledMsg = await p2.textContent('#modalBody').catch(() => '');
  assert(calls.length === 2 && /doesn’t let pages be read automatically/.test(walledMsg), 'A site that blocks both explains what to do', walledMsg.slice(0, 200));
  await p2.click('#modalCloseBtn');
  await p2.waitForTimeout(300);
  calls = await fetchedUrl('paste', 'https://ratelimited.example.com/pie');
  const rlMsg = await p2.textContent('#modalBody').catch(() => '');
  assert(/busy right now/.test(rlMsg) && !/API key/.test(rlMsg), 'Rate limit shows a plain message, not the raw API text', rlMsg.slice(0, 200));
  assert(e2.length === 0, 'No page errors (import)', e2);
  await ctx2.close();

  await browser.close();
  console.log('\nPASS: ' + pass + '  FAIL: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
