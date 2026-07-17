import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const portfolioUrl = "https://chrisj.uk/portfolio";
const previewPath = "assets/portfolio-preview.png";
const sourceSha = process.env.PORTFOLIO_SOURCE_SHA || "manual";
const cacheKey = process.env.PORTFOLIO_CACHE_KEY || sourceSha.slice(0, 12);

await mkdir("assets", { recursive: true });

const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 680 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();

  const response = await page.goto(portfolioUrl, {
    waitUntil: "load",
    timeout: 60_000,
  });

  if (!response || !response.ok()) {
    throw new Error(`Portfolio returned ${response?.status() ?? "no response"}.`);
  }

  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });

  await page.evaluate(() => {
    Array.from(document.querySelectorAll(".track img"))
      .slice(0, 3)
      .forEach((image) => { image.loading = "eager"; });
  });

  await page.waitForFunction(
    () => {
      const previewImages = Array.from(document.querySelectorAll(".track img")).slice(0, 3);
      return previewImages.length === 3
        && previewImages.every((image) => image.complete && image.naturalWidth > 0);
    },
    undefined,
    { timeout: 30_000 },
  );

  await page.addStyleTag({
    content: `
      html, body {
        overflow: hidden !important;
        scrollbar-width: none !important;
      }
      ::-webkit-scrollbar {
        display: none !important;
      }
    `,
  });

  await page.evaluate(() => {
    window.scrollTo(0, 0);

    const frame = document.createElement("div");
    Object.assign(frame.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483646",
      border: "1px solid rgba(26, 25, 23, 0.16)",
      boxSizing: "border-box",
      pointerEvents: "none",
    });

    const cue = document.createElement("div");
    cue.setAttribute("aria-hidden", "true");
    cue.innerHTML = `
      <span style="width:5px;height:5px;border-radius:50%;background:#b85f43;display:block"></span>
      <span>Open live portfolio</span>
      <span style="font-size:17px;line-height:0.8">↗</span>
    `;
    Object.assign(cue.style, {
      position: "fixed",
      right: "24px",
      top: "24px",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      gap: "9px",
      padding: "12px 15px",
      color: "#1a1917",
      background: "rgba(252, 251, 248, 0.94)",
      border: "1px solid rgba(26, 25, 23, 0.22)",
      borderRadius: "999px",
      boxShadow: "0 8px 28px rgba(26, 25, 23, 0.13)",
      backdropFilter: "blur(10px)",
      fontFamily: `Georgia, "Times New Roman", serif`,
      fontSize: "15px",
      lineHeight: "1",
      letterSpacing: "0.015em",
      whiteSpace: "nowrap",
      pointerEvents: "none",
    });

    document.body.append(frame, cue);
  });

  await page.screenshot({
    path: previewPath,
    type: "png",
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });

  const readme = await readFile("README.md", "utf8");
  const updatedReadme = readme.replace(
    /(portfolio-preview\.png\?v=)[^"')\s]+/g,
    `$1${cacheKey}`,
  );

  if (updatedReadme !== readme) {
    await writeFile("README.md", updatedReadme, "utf8");
  }
} finally {
  await browser.close();
}
