/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Tell Puppeteer exactly where to download/find Chrome on Render
  cacheDirectory: '/opt/render/.cache/puppeteer',
};
