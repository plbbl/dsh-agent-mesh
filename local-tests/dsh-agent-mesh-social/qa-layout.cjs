const path = require('node:path');

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
    'Playwright is required for layout QA. Install it or set DSH_PLAYWRIGHT_MODULE to its module path.',
    { cause: lastError },
  );
}

const chromium = loadChromium();

const htmlPath = path.join(__dirname, 'index.html');
const textSelectors = [
  '.soviet-kicker', '.soviet-title', '.soviet-lead', '.soviet-note',
  '.soviet-meta', '.problem-index', '.problem-title', '.problem-copy',
  '.action-index', '.action-title', '.action-copy', '.system-label',
  '.evidence-callout', '.closing-number',
];
const blockSelectors = ['.platform', '.support', '.link', '.worker', '.evidence-frame', '.soviet-foot'];

(async () => {
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1700 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const report = await page.evaluate(({ textSelectors, blockSelectors }) => {
    const rect = (node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const overlap = (a, b) => {
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return { width, height };
    };
    const visible = (node) => {
      const cs = getComputedStyle(node);
      const r = node.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 2 && r.height > 2;
    };
    const label = (node) => `${node.className ? `.${String(node.className).split(/\\s+/).join('.')}` : node.tagName.toLowerCase()} "${node.textContent.trim().replace(/\\s+/g, ' ').slice(0, 34)}"`;
    const issues = [];
    for (const section of document.querySelectorAll('section.poster')) {
      const sr = section.getBoundingClientRect();
      const nodes = [];
      for (const selector of textSelectors) {
        for (const node of section.querySelectorAll(selector)) {
          if (visible(node) && node.textContent.trim()) nodes.push({ node, rect: rect(node), kind: 'text' });
        }
      }
      for (const selector of blockSelectors) {
        for (const node of section.querySelectorAll(selector)) {
          if (visible(node)) nodes.push({ node, rect: rect(node), kind: 'block' });
        }
      }
      const unique = [...new Map(nodes.map((item) => [item.node, item])).values()];
      for (const item of unique) {
        const r = item.rect;
        if (r.top < sr.top - 1 || r.left < sr.left - 1 || r.right > sr.right + 1 || r.bottom > sr.bottom + 1) {
          issues.push({ id: section.id, rule: 'bounds', node: label(item.node) });
        }
      }
      for (let i = 0; i < unique.length; i += 1) {
        for (let j = i + 1; j < unique.length; j += 1) {
          const a = unique[i];
          const b = unique[j];
          // Platform/support/link/worker intersections are the intended
          // construction geometry. Only text-vs-text and text-vs-block
          // collisions are actionable here.
          if (a.kind === 'block' && b.kind === 'block') continue;
          if (a.node.contains(b.node) || b.node.contains(a.node)) continue;
          const hit = overlap(a.rect, b.rect);
          if (hit.width > 4 && hit.height > 4) {
            issues.push({ id: section.id, rule: 'overlap', a: label(a.node), b: label(b.node), hit: { width: Math.round(hit.width), height: Math.round(hit.height) } });
          }
        }
      }
    }
    return issues;
  }, { textSelectors, blockSelectors });
  if (report.length) {
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } else {
    console.log('custom overlap/bounds QA: PASS (no text/block intersections or out-of-board elements)');
  }
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
