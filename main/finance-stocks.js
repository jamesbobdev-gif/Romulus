/* Live stocks for the Finance tab. What he owns (symbol, shares, what he paid) comes from SimpleFIN with his
   brokerage accounts; prices come from Yahoo Finance's public chart data (no account, no key): the price
   now, the day's prices every 5 minutes, and a daily close for the last year, so the chart (3 months, 6 months
   or a year) is filled in from the start. Only ticker symbols go to Yahoo: never shares, amounts or account names.
   It isn't an official API, so it can change or be slow; the tab then shows the brokerage's own values.
   The code itself is shared with the phone (renderer/js/finance-core.js); this file names the stock part.
   Nothing here gives advice: it shows what he owns and what it's worth. */
const core = require('../renderer/js/finance-core');

module.exports = {
  cleanHoldings: core.cleanHoldings, holdingsOf: core.holdingsOf, fetchQuotes: core.fetchQuotes, fetchSectors: core.fetchSectors, readChart: core.readChart,
  portfolio: core.portfolio, portfolioLine: core.portfolioLine, stocksView: core.stocksView, SYMBOL: core.SYMBOL,
};
