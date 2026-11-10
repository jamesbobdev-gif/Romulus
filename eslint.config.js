// ESLint: catches undefined names, unreachable code and the like before a change lands (npm run lint; CI runs it).
// Style is left alone on purpose: the rules here are the ones that find real bugs.
const js = require('@eslint/js');
const globals = require('globals');

const bugsOnly = {
  ...js.configs.recommended.rules,
  // the codebase swallows errors on purpose in many places (catch (e) {}), and names things it doesn't always use
  'no-unused-vars': 'off',
  'no-empty': 'off',
  'no-useless-escape': 'off',
  'no-prototype-builtins': 'off',
  'no-cond-assign': 'off',
  'no-control-regex': 'off',
  'no-misleading-character-class': 'off',
  'no-async-promise-executor': 'off',
  'no-inner-declarations': 'off',
};

// inlined into the phone's page by mobile/prepare-www.js, so they share the renderer's globals (finance-phone.js calls ebtClean)
const PHONE_PAGE_SCRIPTS = ['mobile/cal-phone.js', 'mobile/finance-phone.js', 'mobile/update-phone.js'];

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'mobile/android/**', 'mobile/node_modules/**', 'mobile/www/**', 'site/**', 'supabase/functions/**', 'minipc/**', 'scripts/demo/build/**'] /* the demo build is a copy of renderer/ */ },
  // Electron main process, the Agent and the tests: CommonJS on Node
  {
    files: ['main.js', 'preload.js', 'main/**/*.js', 'agent/**/*.js', 'test/**/*.js', 'scripts/**/*.js', 'mobile/*.js', 'eslint.config.js'], ignores: PHONE_PAGE_SCRIPTS,
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser } },
    rules: bugsOnly,
  },
  // the renderer: plain scripts sharing one global scope, loaded in the order index.html lists them, so a name
  // declared in one file is used in the others and no-undef cannot know about it
  {
    files: ['renderer/**/*.js', ...PHONE_PAGE_SCRIPTS],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser } },
    rules: { ...bugsOnly, 'no-undef': 'off' },
  },
];
