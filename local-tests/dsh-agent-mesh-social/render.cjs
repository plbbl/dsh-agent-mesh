const path = require('node:path');
const fs = require('node:fs');

function loadChromium() {
  const candidates = [process.env.DSH_PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean);
  let lastError;
  for (const candidate of candidates) {
    try {
      return require(candidate).chromium;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    'Playwright is required to render the cards. Install it or set DSH_PLAYWRIGHT_MODULE to its module path.',
    { cause: lastError },
  );
}

const chromium = loadChromium();

const taskDir = __dirname;
const htmlPath = path.join(taskDir, 'index.html');
const outputDir = path.join(taskDir, 'output');
fs.mkdirSync(outputDir, { recursive: true });

const targets = [
  ['#xhs-01', 'xhs-01.png'],
  ['#xhs-02', 'xhs-02.png'],
  ['#xhs-03', 'xhs-03.png'],
  ['#xhs-04', 'xhs-04.png'],
  ['#xhs-05', 'xhs-05.png'],
  ['#xhs-06', 'xhs-06.png'],
];

(async () => {
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1700 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  for (const [selector, name] of targets) {
    await page.locator(selector).screenshot({ path: path.join(outputDir, name) });
  }
  await browser.close();
  console.log(`rendered ${targets.length} cards to ${outputDir}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
