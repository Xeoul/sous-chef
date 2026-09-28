# Sous Chef

A weekly meal planner that turns the recipes you pick into one shopping list.

**Live demo:** https://xeoul.github.io/sous-chef/

- **Plan the week:** tap recipes to plan them and set how many servings of each you're cooking.
- **One shopping list:** ingredients are scaled to your servings and merged across recipes. View them combined or grouped by recipe, check them off as you shop, and switch between US and metric units.
- **Cook view:** each planned recipe's scaled ingredients and step-by-step directions.
- **AI recipe import** (when run inside Claude): search the web, paste a link, or paste an ingredient list, and the recipe is sorted into fields for you.

## How it runs

It's a single self-contained page (`index.html`): plain HTML, CSS and JavaScript with no build step and no dependencies.

- **Inside Claude:** recipes and the week's plan sync through Claude's artifact database. Recipe import uses AI parsing and web search.
- **Anywhere else** (including the demo): everything is saved in your browser's localStorage. The AI import isn't available there, but typing a recipe in works the same.

`demo-seed.js` fills in a few sample recipes the first time the demo opens with nothing saved, so there's something to try. It never touches recipes you've added.

## Run it locally

Serve the folder with any static file server, for example:

```sh
python3 -m http.server 8080
```

Then open http://localhost:8080.

## Deploy

`.github/workflows/pages.yml` publishes the page to the `gh-pages` branch on every push to `main`. One-time setup, if the demo doesn't appear after the first run: Settings → Pages → Build and deployment → Source: *Deploy from a branch* → `gh-pages` / `(root)`.
