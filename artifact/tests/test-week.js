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

const TODAY = (new Date().getDay() + 6) % 7;
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const OTHER = (TODAY + 2) % 7;

const RECIPES = {
  r1: { name: 'Green Curry', baseServings: 4, ingredients: [
      { amount: 1, unit: 'lb', name: 'chicken thighs' }, { amount: 2, unit: 'can', name: 'coconut milk' },
      { amount: 2, unit: 'cup', name: 'rice' }, { amount: 0, unit: 'to taste', name: 'salt' }],
    instructions: ['Brown the chicken for 5 minutes.', 'Add coconut milk and simmer 10 minutes.', 'Serve over rice.'], notes: 'Thai basil is best.' },
  r2: { name: 'Apple Pie', baseServings: 8, ingredients: [{ amount: 6, unit: 'each', name: 'apples' }, { amount: 2, unit: 'cup', name: 'flour' }, { amount: 1, unit: 'cup', name: 'butter' }], instructions: ['Bake.'] },
  r3: { name: 'Banana Bread', baseServings: 8, ingredients: [{ amount: 3, unit: 'each', name: 'banana' }, { amount: 2, unit: 'cup', name: 'flour' }], instructions: [] },
  r4: { name: 'Zucchini Soup', baseServings: 4, ingredients: [{ amount: 2, unit: 'each', name: 'zucchini' }, { amount: 4, unit: 'cup', name: 'chicken stock' }], instructions: ['Simmer.'] }
};

const AI_MOCK = `
window.__prompts = [];
(function () {
  var sample = function () { return Promise.resolve({ text: '' }); };
  sample.json = function (p) {
    window.__prompts.push(p);
    if (/substitutes/.test(p)) return Promise.resolve({ swaps: [{ name: 'Greek yogurt', amount: '1 cup', note: 'Tangier and a little thinner.' }, { name: 'Cashew cream', amount: '1 cup', note: 'Rich, keeps it dairy-free.' }] });
    if (/dinner ideas/.test(p)) return Promise.resolve({ ideas: [{ name: 'Chicken Fried Rice', why: 'Uses your rice and chicken.', uses: ['rice', 'chicken'], alsoNeed: ['soy sauce'] }, { name: '<b>Spinach</b> Frittata', why: 'Quick and light.', uses: ['spinach'], alsoNeed: ['eggs'] }] });
    if (/Write a complete home-cooking recipe/.test(p)) return Promise.resolve({ name: 'Chicken Fried Rice', baseServings: 4, prepMinutes: 10, cookMinutes: 15, ingredients: [{ amount: 3, unit: 'cup', name: 'cooked rice' }, { amount: 0.5, unit: 'lb', name: 'chicken' }], instructions: ['Fry the rice.', 'Add chicken.'] });
    return Promise.resolve({ name: 'X', baseServings: 4, ingredients: [{ amount: 1, unit: 'cup', name: 'x' }], instructions: [] });
  };
  window.claude = { use: function (n) { return Promise.resolve(n === 'sample' ? sample : null); } };
})();`;

async function open(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  if (opts.ai) await ctx.addInitScript(AI_MOCK);
  await ctx.addInitScript(({ recipes, week, tab }) => {
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    localStorage.clear();
    localStorage.setItem('larder_recipes', JSON.stringify(recipes));
    localStorage.setItem('larder_week', JSON.stringify(week));
    localStorage.setItem('sous_chef_tab', tab);
    localStorage.setItem('sous_chef_shopping_view', 'recipe');
  }, { recipes: opts.recipes || RECIPES, week: opts.week || { items: {}, checked: {} }, tab: opts.tab || 'recipes' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(FILE_PATH);
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}
const card = (page, name) => page.locator('#recipeList .recipe-card', { hasText: name });
// Saved data is read with a short retry, so a read that lands mid-navigation doesn't see nothing.
const stored = async (page, key) => {
  for (let i = 0; i < 10; i++) {
    const v = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), key).catch(() => null);
    if (v !== null) return v;
    await page.waitForTimeout(100);
  }
  return null;
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });

  // ===================== Tags & details =====================
  console.log('\n=== 1. Tags, time, rating ===');
  let { ctx, page, errors } = await open(browser);
  await card(page, 'Banana Bread').locator('[data-action="edit"]').click();
  await page.waitForTimeout(200);
  await page.click('#rfTags .tag-option[data-tag="Quick"]');
  await page.click('#rfTags .tag-option[data-tag="Breakfast"]');
  await page.click('#rfTags .tag-option[data-tag="Breakfast"]'); // toggled back off
  await page.fill('#rfTagNew', 'Kid favorite');
  await page.press('#rfTagNew', 'Enter');
  assert(await page.getAttribute('#rfTags .tag-option[data-tag="Kid favorite"]', 'aria-pressed') === 'true', 'Typing a new tag + Enter adds it, selected');
  await page.fill('#rfPrep', '15');
  await page.fill('#rfCook', '60');
  await page.click('#rfRating [data-rating="4"]');
  await page.click('#rfRating [data-rating="5"]');
  await page.click('#rfRating [data-rating="5"]'); // tap current rating again clears it
  assert(await page.getAttribute('#rfRating', 'data-value') === '0', 'Tapping the current rating again clears it');
  await page.click('#rfRating [data-rating="4"]');
  await page.click('[data-action="save-recipe"]');
  await page.waitForTimeout(250);
  let bb = (await stored(page, 'larder_recipes')).r3;
  assert(JSON.stringify(bb.tags) === JSON.stringify(['Quick', 'Kid favorite']) && bb.prepMin === 15 && bb.cookMin === 60 && bb.rating === 4, 'Tags, prep/cook minutes and rating saved', bb);
  const extra = await card(page, 'Banana Bread').locator('.recipe-extra').textContent();
  assert(/4/.test(extra) && /1 hr 15 min/.test(extra) && /Quick/.test(extra) && /Kid favorite/.test(extra), 'Card shows rating, total time and tags', extra);
  assert(await page.isVisible('#tagFilters') && (await page.$$eval('#tagFilters .filter-chip', els => els.map(e => e.textContent))).join() === 'Kid favorite,Quick', 'Tag filter chips list tags in use', await page.$$eval('#tagFilters .filter-chip', els => els.map(e => e.textContent)));
  await page.click('#tagFilters [data-tag-filter="Quick"]');
  await page.waitForTimeout(150);
  let names = await page.$$eval('#recipeList .recipe-name', els => els.map(e => e.textContent));
  assert(names.join() === 'Banana Bread', 'Tag filter narrows the list', names);
  await page.click('#tagFilters [data-tag-filter="Quick"]');
  await page.fill('#recipeSearch', 'kid fav');
  await page.waitForTimeout(150);
  names = await page.$$eval('#recipeList .recipe-name', els => els.map(e => e.textContent));
  assert(names.join() === 'Banana Bread', 'Search matches tags', names);
  await page.fill('#recipeSearch', '');
  // The new tag is offered on other recipes
  await card(page, 'Apple Pie').locator('[data-action="edit"]').click();
  await page.waitForTimeout(200);
  assert(await page.locator('#rfTags .tag-option[data-tag="Kid favorite"]').count() === 1, 'Tags in use are offered when editing another recipe');
  await page.click('#modalCloseBtn');
  await page.waitForTimeout(300);
  // Bad data from elsewhere is tolerated
  await page.evaluate(() => {
    const r = JSON.parse(localStorage.getItem('larder_recipes'));
    r.r4.tags = 'not-a-list'; r.r4.rating = 99; r.r4.prepMin = -5; r.r4.lastCooked = 'yesterday';
    localStorage.setItem('larder_recipes', JSON.stringify(r));
  });
  await page.reload();
  await page.waitForTimeout(300);
  assert((await card(page, 'Zucchini Soup').locator('.recipe-extra').innerHTML()) === '', 'Malformed tags/rating/time/lastCooked are ignored, not shown');
  assert(errors.length === 0, 'No page errors (details)', errors);
  await ctx.close();

  // ===================== Day planner =====================
  console.log('\n=== 2. Day-by-day planner ===');
  ({ ctx, page, errors } = await open(browser, { week: { items: { r1: 4, r2: 8 }, checked: {} } }));
  assert(await page.isVisible('#weekStrip') && /Pick a day/.test(await page.textContent('#weekStrip .strip-note')), 'Week strip shows once recipes are planned, with a hint');
  assert(await page.locator('#weekStrip .day-cell.is-today').count() === 1, 'Today is highlighted in the strip');
  await card(page, 'Green Curry').locator('select[data-day-for]').selectOption(String(TODAY));
  await page.waitForTimeout(150);
  assert((await card(page, 'Green Curry').locator('.day-pick .pill-text').textContent()) === DAY_SHORT[TODAY], 'Day pill shows the chosen day');
  let todayTiles = await page.$$eval('#weekStrip .day-cell.is-today .mini-tile', els => els.map(e => e.textContent));
  assert(todayTiles.join() === 'G', 'Recipe appears on its day in the strip', todayTiles);
  assert(await card(page, 'Green Curry').locator('.leftover-pick').isVisible(), 'Leftovers picker appears once a day is set');
  assert(await card(page, 'Green Curry').locator(`select[data-leftover-for] option[value="${TODAY}"]`).evaluate(o => o.disabled), 'Leftovers can’t be the same day');
  await card(page, 'Green Curry').locator('select[data-leftover-for]').selectOption(String(OTHER));
  await card(page, 'Apple Pie').locator('select[data-day-for]').selectOption(String(OTHER));
  await page.waitForTimeout(150);
  let wk = await stored(page, 'larder_week');
  assert(wk.days.r1 === TODAY && wk.leftovers.r1 === OTHER && wk.days.r2 === OTHER, 'Days and leftovers saved', wk);
  assert(await page.evaluate(() => document.querySelector('#weekStrip .day-cell').classList.contains('is-today')), 'Strip starts at today');
  const otherCell = await page.$$eval('#weekStrip .day-cell', (els, i) => Array.from(els[i].querySelectorAll('.mini-tile')).map(t => t.textContent + (t.classList.contains('is-leftover') ? '(L)' : '')), 2);
  assert(otherCell.join() === 'A,G(L)', 'Strip shows cooking and leftovers (dashed) on a day', otherCell);
  // Shopping groups in day order with the day
  await page.click('.tab-btn[data-tab="shop"]');
  await page.waitForTimeout(200);
  const groupMeta = await page.$$eval('#shoppingByRecipe .recipe-shop-group:not(.shop-section) .recipe-shop-meta', els => els.map(e => e.textContent));
  const expectFirst = DAY_SHORT[TODAY] + ' · 4 servings'; // days run forward from today
  assert(groupMeta[0] === expectFirst && groupMeta.length === 2, 'By-recipe list is in day order and labelled with the day', groupMeta);
  // Cook opens on today
  await page.click('.tab-btn[data-tab="cook"]');
  await page.waitForTimeout(200);
  assert(await page.isVisible('#todayCard') && /Green Curry/.test(await page.textContent('#todayCard .today-list')), 'Cook tab shows today’s recipe up top');
  const activePills = await page.$$eval('.recipe-pill.active', els => els.map(e => e.getAttribute('data-recipe')));
  assert(activePills.join() === 'r1', 'Cook tab opens on today’s recipe only', activePills);
  assert(/G?reen Curry/.test(await page.textContent('.recipe-pill[data-recipe="r1"]')) && (await page.textContent('.recipe-pill[data-recipe="r1"] .pill-day')) === DAY_SHORT[TODAY], 'Pills show their day');
  // Tapping a day in the strip
  await page.click('.tab-btn[data-tab="recipes"]');
  await page.waitForTimeout(150);
  await page.click(`#weekStrip .day-cell[data-day="${OTHER}"]`);
  await page.waitForTimeout(250);
  assert(await page.isVisible('#panelCook') && (await page.$$eval('.recipe-pill.active', els => els.map(e => e.getAttribute('data-recipe')))).join() === 'r2', 'Tapping a day opens Cook on that day’s recipe');
  // Unplanning clears its day; delete + undo restores it
  await page.click('.tab-btn[data-tab="recipes"]');
  await page.waitForTimeout(150);
  await card(page, 'Apple Pie').locator('.plan-toggle input').click();
  await page.waitForTimeout(150);
  wk = await stored(page, 'larder_week');
  assert(!('r2' in wk.days), 'Unplanning a recipe clears its day', wk.days);
  await card(page, 'Green Curry').locator('[data-action="edit"]').click();
  await page.click('#modalBody [data-action="delete"]');
  await page.click('#modalBody [data-action="confirm-delete"]');
  await page.waitForTimeout(200);
  wk = await stored(page, 'larder_week');
  assert(!('r1' in wk.days) && !('r1' in wk.leftovers), 'Deleting a recipe clears its day and leftovers');
  await page.click('#toastHost .toast-undo');
  await page.waitForTimeout(200);
  wk = await stored(page, 'larder_week');
  assert(wk.days.r1 === TODAY && wk.leftovers.r1 === OTHER, 'Undo delete restores its day and leftovers', wk);
  // Invalid stored days are dropped
  await page.evaluate(() => localStorage.setItem('larder_week', JSON.stringify({ items: { r1: 4 }, days: { r1: 9, r2: 1, r3: 'x' }, leftovers: { r1: 2 } })));
  await page.reload();
  await page.waitForTimeout(300);
  wk = await page.evaluate(() => document.querySelectorAll('#weekStrip .mini-tile').length);
  assert(wk === 0, 'Out-of-range days, days for unplanned recipes and orphan leftovers are ignored', wk);
  assert(errors.length === 0, 'No page errors (days)', errors);
  await ctx.close();

  // ===================== Cook-along =====================
  console.log('\n=== 3. Cook-along ===');
  ({ ctx, page, errors } = await open(browser, { week: { items: { r1: 2 }, checked: {} }, tab: 'cook' }));
  await page.click('#cookContent [data-along="r1"]');
  await page.waitForTimeout(500);
  assert(await page.isVisible('#along') && (await page.textContent('#alongKicker')) === 'Get ready', 'Cook-along opens on the prep page');
  assert(await page.evaluate(() => getComputedStyle(document.body).overflow) === 'hidden', 'Page behind doesn’t scroll while open');
  const prepNames = await page.$$eval('#alongStage .prep-item .shop-name', els => els.map(e => e.textContent));
  assert(prepNames.join() === 'chicken thighs,coconut milk,rice,salt', 'Prep page lists every ingredient', prepNames);
  assert(/8 oz/.test(await page.textContent('#alongStage .prep-item[data-prep="0"]')), 'Prep amounts are scaled to the planned servings (2 of 4: 1 lb -> 8 oz)', await page.textContent('#alongStage .prep-item[data-prep="0"]'));
  assert(/Thai basil/.test(await page.textContent('#alongStage')), 'Recipe notes shown on prep page');
  await page.click('#alongStage .prep-item[data-prep="1"] label');
  await page.waitForTimeout(150);
  assert(/1 of 4 ready/.test(await page.textContent('#alongStage .prep-count')) && await page.evaluate(() => document.querySelector('.prep-item[data-prep="1"]').classList.contains('is-checked')), 'Ticking an ingredient counts it as ready');
  assert((await page.textContent('#alongNext')) === 'Start cooking' && await page.isHidden('#alongPrev'), 'Prep page offers "Start cooking", no Back');
  await page.click('#alongNext');
  await page.waitForTimeout(500);
  assert((await page.textContent('#alongKicker')) === 'Step 1 of 3', 'Next goes to step 1', await page.textContent('#alongKicker'));
  assert(await page.locator('#alongStage .timer-chip').count() === 1, 'Step shows its timer chip');
  const uses = await page.$$eval('#alongStage .use-list li', els => els.map(e => e.textContent));
  assert(uses.length === 1 && /chicken thighs/.test(uses[0]), '"For this step" lists the ingredients it mentions', uses);
  await page.click('#alongStage .timer-chip');
  await page.waitForTimeout(300);
  assert(await page.locator('#timerTray .timer-card').count() === 1 && await page.isVisible('#timerTray .timer-card'), 'Timer from cook-along runs in the tray, visible over it');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(450);
  assert((await page.textContent('#alongKicker')) === 'Step 2 of 3', 'Right arrow moves on');
  let done = await stored(page, 'sous_chef_cook_done');
  assert(done.r1 && done.r1['0'] && !done.r1['1'], 'Moving past a step marks it done', done);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(450);
  assert((await page.textContent('#alongKicker')) === 'Step 1 of 3', 'Left arrow goes back');
  // swipe left
  const box = await page.locator('#alongStage').boundingBox();
  await page.evaluate(({ x, y }) => {
    const st = document.getElementById('alongStage');
    st.dispatchEvent(new PointerEvent('pointerdown', { clientX: x + 250, clientY: y + 100, isPrimary: true, bubbles: true }));
    st.dispatchEvent(new PointerEvent('pointerup', { clientX: x + 60, clientY: y + 110, isPrimary: true, bubbles: true }));
  }, { x: box.x, y: box.y });
  await page.waitForTimeout(450);
  assert((await page.textContent('#alongKicker')) === 'Step 2 of 3', 'Swiping left moves on');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  assert(await page.isHidden('#along'), 'Escape closes cook-along');
  assert(/1 of 3 steps done/.test(await page.textContent('#cookContent .cook-sub')), 'Cook view reflects steps done in cook-along');
  await page.click('#cookContent [data-along="r1"]');
  await page.waitForTimeout(450);
  assert((await page.textContent('#alongKicker')) === 'Step 2 of 3', 'Reopening resumes at the first step not done');
  await page.click('#alongNext');
  await page.waitForTimeout(400);
  assert((await page.textContent('#alongNext')) === 'Finish', 'Last step offers Finish');
  await page.click('#alongNext');
  await page.waitForTimeout(500);
  assert((await page.textContent('#alongKicker')) === 'Finished' && /All done/.test(await page.textContent('#alongStage')), 'Finish page shows');
  let rec = (await stored(page, 'larder_recipes')).r1;
  assert(rec.lastCooked > Date.now() - 60000, 'Finishing marks the recipe as cooked today', rec.lastCooked);
  await page.click('#alongStage [data-along-rate="5"]');
  await page.waitForTimeout(200);
  rec = (await stored(page, 'larder_recipes')).r1;
  assert(rec.rating === 5 && await page.evaluate(() => document.querySelectorAll('#alongStage .star-btn.is-on').length) === 5, 'Rating from the finish page is saved', rec.rating);
  await page.click('#alongNext');
  await page.waitForTimeout(250);
  assert(await page.isHidden('#along'), 'Done closes cook-along');
  await page.click('.tab-btn[data-tab="recipes"]');
  await page.waitForTimeout(150);
  assert(/Cooked today/.test(await card(page, 'Green Curry').locator('.recipe-extra').textContent()), 'Recipe card shows "Cooked today"');
  await page.reload();
  await page.waitForTimeout(300);
  await page.click('.tab-btn[data-tab="cook"]');
  await page.waitForTimeout(200);
  // Read aloud (mocked)
  await page.evaluate(() => {
    window.__spoken = [];
    window.speechSynthesis.speak = (u) => window.__spoken.push(u.text);
    window.speechSynthesis.cancel = () => {};
  });
  assert(JSON.stringify((await stored(page, 'sous_chef_prep_done')).r1) === '{"1":true}', 'Prep ticks persist across reload');
  await page.click('#cookContent [data-reset-steps]');
  assert(!(await stored(page, 'sous_chef_prep_done')).r1, 'Reset steps clears prep ticks too');
  await page.click('#cookContent [data-along="r1"]');
  await page.waitForTimeout(400);
  await page.click('#alongSpeak');
  await page.click('#alongNext');
  await page.waitForTimeout(300);
  const spoken = await page.evaluate(() => window.__spoken);
  assert(spoken.length === 2 && /^Get everything ready/.test(spoken[0]) && spoken[1] === 'Step 1. Brown the chicken for 5 minutes.', 'Read-aloud speaks the page when switched on and each new step', spoken);
  await page.click('#alongClose');
  assert(errors.length === 0, 'No page errors (cook-along)', errors);
  await ctx.close();

  // ===================== Helpers =====================
  console.log('\n=== 4. Plan for me ===');
  ({ ctx, page, errors } = await open(browser, { recipes: Object.assign({}, RECIPES, { r4: Object.assign({}, RECIPES.r4, { lastCooked: Date.now() }) }) }));
  await page.click('#recipesMoreBtn'); assert(await page.isVisible('#planForMeBtn'), '"Plan for me" shown');
  await page.click('#planForMeBtn');
  await page.waitForTimeout(250);
  wk = await stored(page, 'larder_week');
  const picked = Object.keys(wk.items);
  assert(picked.length === 3, 'Plans three recipes into an empty week', picked);
  const pickedDays = picked.map(id => wk.days[id]).sort((a, b) => ((a - TODAY + 7) % 7) - ((b - TODAY + 7) % 7));
  assert(pickedDays.join() === [0, 1, 2].map(k => (TODAY + k) % 7).join(), 'Gives them the next open days, starting today', pickedDays);
  assert(/Planned 3 recipes/.test(await page.textContent('#toastHost')), 'Toast names what was planned');
  await page.click('#toastHost .toast-undo');
  await page.waitForTimeout(200);
  wk = await stored(page, 'larder_week');
  assert(!Object.keys(wk.items).length && !Object.keys(wk.days).length, 'Undo takes the picks back out', wk);
  // Recently cooked recipes are rarely picked
  let zCount = 0;
  for (let i = 0; i < 30; i++) {
    const got = await page.evaluate(() => {
      document.getElementById('planForMeBtn').click();
      const w = JSON.parse(localStorage.getItem('larder_week'));
      const z = 'r4' in w.items;
      document.querySelector('#toastHost .toast-undo').click();
      return z;
    });
    if (got) zCount++;
  }
  assert(zCount <= 22, 'A recipe cooked today is picked less often (' + zCount + '/30 vs ~22.5 if uniform)', zCount);
  await ctx.close();

  console.log('\n=== 5. What can I make? (no AI) ===');
  ({ ctx, page, errors } = await open(browser, { week: { items: {}, checked: {}, pantry: { flour: true } } }));
  await page.click('#recipesMoreBtn'); await page.click('#ideasBtn');
  await page.waitForTimeout(250);
  assert((await page.inputValue('#haveText')) === 'flour', 'Pantry items are filled in');
  await page.fill('#haveText', 'flour, 3 bananas');
  await page.click('[data-action="find-ideas"]');
  await page.waitForTimeout(200);
  let rows = await page.$$eval('#modalBody .idea-row .idea-name', els => els.map(e => e.textContent));
  assert(rows[0] === 'Banana Bread' && rows.includes('Apple Pie') && !rows.includes('Green Curry'), 'Ranks your recipes by how much you have', rows);
  assert(/You have everything/.test(await page.textContent('#modalBody .idea-row:first-child')), 'Says when you have everything');
  assert(await page.locator('#modalBody .ideas-head', { hasText: 'New ideas' }).count() === 0, 'No AI section without AI');
  await page.click('#modalBody .idea-row:first-child [data-action="plan-idea"]');
  await page.waitForTimeout(200);
  assert('r3' in (await stored(page, 'larder_week')).items && /Planned/.test(await page.textContent('#modalBody .idea-row:first-child')), '"Plan it" adds it to the week');
  assert(errors.length === 0, 'No page errors (ideas)', errors);
  await ctx.close();

  console.log('\n=== 6. AI ideas and swaps (mocked) ===');
  ({ ctx, page, errors } = await open(browser, { ai: true, week: { items: { r1: 4 }, checked: {} } }));
  await page.click('#recipesMoreBtn'); await page.click('#ideasBtn');
  await page.fill('#haveText', 'chicken, rice, spinach');
  await page.click('[data-action="find-ideas"]');
  await page.waitForTimeout(300);
  const ideaNames = await page.$$eval('#modalBody .idea-new .idea-name', els => els.map(e => e.textContent));
  assert(ideaNames.join() === 'Chicken Fried Rice,<b>Spinach</b> Frittata', 'AI ideas listed (and their text is escaped)', ideaNames);
  const lastPrompt = await page.evaluate(() => window.__prompts[window.__prompts.length - 1]);
  assert(/chicken, rice, spinach/.test(lastPrompt) && /Green Curry/.test(lastPrompt), 'Prompt includes what you have and the recipes you already know');
  await page.click('#modalBody .idea-new:first-child [data-action="create-idea"]');
  await page.waitForTimeout(300);
  assert((await page.inputValue('#rfName')) === 'Chicken Fried Rice' && (await page.inputValue('#rfPrep')) === '10' && (await page.inputValue('#rfCook')) === '15', '"Get recipe" opens a filled-in form, times included');
  await page.click('[data-action="save-recipe"]');
  await page.waitForTimeout(200);
  assert(await card(page, 'Chicken Fried Rice').count() === 1, 'AI recipe saves into the box');
  await page.click('.tab-btn[data-tab="cook"]');
  await page.waitForTimeout(200);
  assert(await page.locator('#cookContent .swap-btn').count() === 4, 'Swap buttons on each cook ingredient when AI is available');
  await page.click('#cookContent .cook-ingredients li:nth-child(2) .swap-btn');
  await page.waitForTimeout(300);
  assert(/coconut milk/.test(await page.textContent('#modalBody .swap-for')) && (await page.$$eval('#modalBody .idea-row', els => els.length)) === 2, 'Swap dialog lists substitutes for that ingredient');
  const swapPrompt = await page.evaluate(() => window.__prompts[window.__prompts.length - 1]);
  assert(/Green Curry/.test(swapPrompt) && /2 cans coconut milk/.test(swapPrompt), 'Swap prompt names the recipe and the scaled amount', swapPrompt.slice(0, 120));
  await page.click('#modalBody .idea-row:first-child [data-action="add-swap"]');
  await page.waitForTimeout(200);
  assert((await stored(page, 'larder_week')).extras.some(x => x.name === 'Greek yogurt'), '"Add to list" puts the swap on the shopping list');
  await page.click('#modalCloseBtn');
  await page.waitForTimeout(300);
  await page.click('#cookContent [data-along="r1"]');
  await page.waitForTimeout(400);
  await page.click('#alongStage .prep-item[data-prep="2"] .swap-btn');
  await page.waitForTimeout(300);
  assert(await page.isVisible('#modalBackdrop') && /rice/.test(await page.textContent('#modalBody .swap-for')), 'Swaps also work from the cook-along prep list, above it');
  assert(!(await page.evaluate(() => document.querySelector('.prep-item[data-prep="2"]').classList.contains('is-checked'))), 'Tapping swap doesn’t tick the ingredient');
  assert(errors.length === 0, 'No page errors (AI)', errors);
  await ctx.close();

  console.log('\n=== 7. Synced: a day set on another device shows up ===');
  const ctx3 = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await ctx3.addInitScript(() => {
    var store = { recipes: { a: { name: 'Alpha', baseServings: 2, ingredients: [{ amount: 1, unit: 'cup', name: 'rice' }], instructions: [] } }, week: { items: { a: 2 }, checked: {} } };
    var wl = [];
    function ws() { var w = JSON.parse(JSON.stringify(store.week)); return { exists: true, data: function () { return w; } }; }
    window.__remoteWrite = function (w) { store.week = w; wl.forEach(function (f) { f(ws()); }); };
    var db = {
      collection: function () { return { onSnapshot: function (n) { n({ docs: [{ id: 'a', exists: true, data: function () { return store.recipes.a; } }] }); return function () {}; }, doc: function () { return { set: function () { return Promise.resolve(); }, delete: function () { return Promise.resolve(); } }; } }; },
      doc: function () { return { onSnapshot: function (n) { wl.push(n); n(ws()); return function () {}; }, set: function (d) { store.week = JSON.parse(JSON.stringify(d)); return Promise.resolve(); } }; }
    };
    window.claude = { use: function (n) { return Promise.resolve(n === 'db' ? db : null); } };
  });
  const p3 = await ctx3.newPage();
  await p3.goto(FILE_PATH);
  await p3.waitForTimeout(400);
  await p3.evaluate((d) => window.__remoteWrite({ items: { a: 2 }, checked: {}, days: { a: d } }), OTHER);
  await p3.waitForTimeout(200);
  const synced = await p3.$$eval('#weekStrip .day-cell', (els, i) => els[i].querySelectorAll('.mini-tile').length, 2);
  assert(synced === 1, 'A day-only change from another device is applied', synced);
  await ctx3.close();

  await browser.close();
  console.log('\nPASS: ' + pass + '  FAIL: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
