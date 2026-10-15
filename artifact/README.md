# Sous Chef (Claude artifact)

`sous-chef.html` is the source of the Sous Chef artifact published on claude.ai — plan a
week of recipes, get a shopping list grouped by aisle, and cook along step by step.

It is a single page with no build step. Inside claude.ai it uses the artifact's runtime
capabilities when they're granted (a shared database, AI parsing and estimates, Parallel
Search for recipe links, file storage for photos, file saving); opened anywhere else it falls
back to saving on the device.

## GitHub Pages

The site at https://xeoul.github.io/sous-chef/ is built from this file. After changing it, run
`python3 build-pages.py` from the repo root to regenerate `index.html`, and commit both.

## Tests

Browser tests drive the page with Playwright and mock the capabilities:

```sh
cd artifact/tests
node test-core.js      # add/plan/shop, animation replays, synced-save races, link import
node test-features.js  # aisles, pantry, sharing, timers, recipe box, imports
node test-week.js      # day planner, cook-along, AI helpers, tags
node test-v32.js       # fractions, every-week items, share/print/backup, photos, nutrition & cost
```
