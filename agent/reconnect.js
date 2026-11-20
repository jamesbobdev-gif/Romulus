/* An AI whose key expired (or whose sign-in ran out) puts a to-do on his Human list saying to reconnect it.
   One per AI: the renderer skips it while that one is still open, and checks it off once the AI answers again. */
'use strict';
const { NAMES } = require('./providers');

// the Human-list title for this AI: "Reconnect Gemini: …". The renderer finds it again by that prefix
// name: an extra account's own name (Claude 2), which signs in again from its card in Settings
function reconnectTitle(id, why, name) {
  const extra = !!name && name !== NAMES[id];
  name = name || NAMES[id] || id;
  const how = extra && !/key/i.test(why || '') ? 'its sign-in expired: press Sign in on it in Settings → AI connections'
    : id === 'claude' ? 'its sign-in expired: run claude /login in a terminal'
    : id === 'openai' ? 'its ChatGPT sign-in expired: press Sign in with ChatGPT in Settings → AI connections'
    : /key/i.test(why || '') ? 'its API key expired or stopped working: paste a new one in Settings → AI connections'
    : 'it needs signing in again in Settings → AI connections';
  return 'Reconnect ' + name + ': ' + how;
}
// Claude Code's own words when its login is gone (not just any "auth" in an answer: "author" isn't one)
const CLAUDE_AUTH_RE = /\/login|not logged in|log ?in again|invalid api key|oauth token|token (?:has )?expired|authentication_error|\b401\b/i;

module.exports = { reconnectTitle, CLAUDE_AUTH_RE };
