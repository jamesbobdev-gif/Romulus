/* Settings → Agent → "Use these on your phone" (renderer/js/phone-ai.js): the QR code that copies the API keys he
   picks to his phone, once. Not synced; the code's format and the phone's calls are in renderer/js/phone-ai.js.
   Only keys the phone can use straight: an Anthropic key for Claude (his Claude sign-in stays on this computer),
   Gemini's key (not the Gemini app's sign-in), an OpenAI key (not ChatGPT on his plan), OpenRouter's key. */
const providers = require('../agent/providers');
const phoneAi = require('../renderer/js/phone-ai');

// Claude Code's model names → the API's (as agent/overlay-ask.js does for a saved Anthropic key)
const CLAUDE_API_MODELS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };

let ctx = null; // { readConfig }
function init(c) { ctx = c; }

// config → [{id, name, can, why, step}] in his order
function choices(cfg) {
  const s = providers.settings(cfg), ai = (cfg || {}).ai || {};
  const anthropic = String(ai.anthropicKey || s.anthropicKey || '').trim();
  const all = {
    claude: anthropic ? { step: { id: 'claude', key: anthropic, model: CLAUDE_API_MODELS[s.claudeModel] || CLAUDE_API_MODELS.sonnet } } : { why: 'needs an Anthropic API key (your Claude sign-in only works here)' },
    gemini: s.geminiKey ? { step: { id: 'gemini', key: s.geminiKey, model: s.geminiModel || providers.GEMINI_DEFAULT_MODEL } } : { why: 'needs a Gemini API key' },
    openai: s.openaiKey && s.openaiVia !== 'chatgpt' ? { step: { id: 'openai', key: s.openaiKey, model: s.openaiModel || providers.OPENAI_DEFAULT_MODEL } } : { why: 'needs an OpenAI API key' },
    openrouter: s.openrouterKey ? { step: { id: 'openrouter', key: s.openrouterKey, model: s.openrouterModel, zdr: !!s.openrouterZdr } } : { why: 'needs an OpenRouter key' },
  };
  const order = (s.order || []).map((o) => o.id).filter((id) => all[id]);
  Object.keys(all).forEach((id) => { if (order.indexOf(id) < 0) order.push(id); });
  return order.map((id) => ({ id, name: (providers.NAMES || {})[id] || id, can: !!all[id].step, why: all[id].why || '', step: all[id].step || null }));
}

module.exports = {
  init, choices,
  handlers: {
    // → [{id, name, can, why}] (no keys)
    'ai:phoneChoices': () => choices(ctx.readConfig()).map((c) => ({ id: c.id, name: c.name, can: c.can, why: c.why })),
    // [ids] → {svg} or {why}
    'ai:phoneCode': async (_e, ids) => {
      const want = Array.isArray(ids) ? ids.map(String) : [];
      const steps = choices(ctx.readConfig()).filter((c) => c.can && want.indexOf(c.id) >= 0).map((c) => c.step);
      if (!steps.length) return { why: 'None of those have a key the phone can use.' };
      const svg = await require('qrcode').toString(phoneAi.phoneAiPack(steps), { type: 'svg', errorCorrectionLevel: 'L', margin: 2 });
      return { svg };
    },
  },
};
