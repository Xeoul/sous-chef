// Sample recipes for the hosted demo (https://xeoul.github.io/sous-chef/).
//
// Outside Claude the app keeps everything in this browser's localStorage,
// and a first visit would open on an empty kitchen. This fills in a few
// recipes - two of them already planned for the week, so the Shopping and
// Cook tabs have something to show - but only once, and only when there's
// nothing saved yet: it never touches recipes someone has added, and
// deleting the samples doesn't bring them back. Inside Claude (where
// window.claude provides the synced database) it does nothing at all.
(function () {
  'use strict';
  if (window.claude) return;
  try {
    if (localStorage.getItem('larder_recipes') || localStorage.getItem('sous_chef_demo_seeded')) return;

    var recipes = {
      'demo-garlic-pasta': {
        name: 'Garlic Butter Pasta',
        baseServings: 2,
        ingredients: [
          { amount: 200, unit: 'g', name: 'spaghetti' },
          { amount: 3, unit: 'tbsp', name: 'butter' },
          { amount: 4, unit: 'clove', name: 'garlic' },
          { amount: 50, unit: 'g', name: 'parmesan' },
          { amount: 2, unit: 'tbsp', name: 'chopped parsley' },
          { amount: 0, unit: 'to taste', name: 'salt and pepper' }
        ],
        instructions: [
          'Cook the spaghetti in well-salted water until al dente, then save a cup of the pasta water before draining.',
          'Melt the butter over medium-low heat and cook the sliced garlic until just golden.',
          'Toss in the pasta with a splash of pasta water and the parmesan until glossy.',
          'Finish with parsley, salt and pepper.'
        ]
      },
      'demo-chicken-stir-fry': {
        name: 'Chicken Stir-Fry',
        baseServings: 4,
        ingredients: [
          { amount: 1, unit: 'lb', name: 'chicken breast' },
          { amount: 2, unit: 'cup', name: 'broccoli florets' },
          { amount: 1, unit: '', name: 'red bell pepper' },
          { amount: 3, unit: 'tbsp', name: 'soy sauce' },
          { amount: 1, unit: 'tbsp', name: 'honey' },
          { amount: 2, unit: 'clove', name: 'garlic' },
          { amount: 2, unit: 'cup', name: 'cooked rice' }
        ],
        instructions: [
          'Slice the chicken thin and sear it in a hot pan until browned; set aside.',
          'Stir-fry the broccoli and pepper for 3-4 minutes, adding the garlic for the last minute.',
          'Return the chicken with the soy sauce and honey and toss until glazed.',
          'Serve over rice.'
        ]
      },
      'demo-overnight-oats': {
        name: 'Overnight Oats',
        baseServings: 1,
        ingredients: [
          { amount: 0.5, unit: 'cup', name: 'rolled oats' },
          { amount: 0.5, unit: 'cup', name: 'milk' },
          { amount: 0.25, unit: 'cup', name: 'greek yogurt' },
          { amount: 1, unit: 'tbsp', name: 'honey' },
          { amount: 0.5, unit: 'cup', name: 'berries' }
        ],
        instructions: [
          'Stir the oats, milk, yogurt and honey together in a jar.',
          'Refrigerate overnight, then top with berries.'
        ]
      }
    };
    var week = { items: { 'demo-garlic-pasta': 2, 'demo-chicken-stir-fry': 4 }, checked: {} };

    localStorage.setItem('larder_recipes', JSON.stringify(recipes));
    localStorage.setItem('larder_week', JSON.stringify(week));
    localStorage.setItem('sous_chef_demo_seeded', '1');
  } catch (e) {
    // Storage blocked (e.g. some private modes) - the app just starts empty.
  }
})();
