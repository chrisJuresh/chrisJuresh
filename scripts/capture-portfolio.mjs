import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const portfolioUrl = "https://chrisj.uk/portfolio";
const sourceSha = process.env.PORTFOLIO_SOURCE_SHA || "manual";
const cacheKey = process.env.PORTFOLIO_CACHE_KEY || sourceSha.slice(0, 12);
const previewPaths = {
  light: `assets/portfolio-preview-${cacheKey}-light.png`,
  dark: `assets/portfolio-preview-${cacheKey}-dark.png`,
};

const layoutHeight = 1000;
const probeWidth = 1000;
const targetVisiblePhotos = 1.75;
const githubReadmeWidthAt1440p = 846;
const targetDisplayDensity = 3;

const themes = {
  light: {
    background: "#ffffff",
    backgroundRgb: "255, 255, 255",
    ink: "#1f2328",
    inkSoft: "#424a53",
    muted: "#59636e",
    rule: "#d1d9e0",
    linkLine: "#afb8c1",
    cueBackground: "#ffffff",
    cueBorder: "#d1d9e0",
    cueAccent: "#0969da",
  },
  dark: {
    background: "#0d1117",
    backgroundRgb: "13, 17, 23",
    ink: "#e6edf3",
    inkSoft: "#b1bac4",
    muted: "#8c959f",
    rule: "#30363d",
    linkLine: "#484f58",
    cueBackground: "#0d1117",
    cueBorder: "#30363d",
    cueAccent: "#58a6ff",
  },
};

await mkdir("assets", { recursive: true });

const currentPreviewPaths = new Set(Object.values(previewPaths));
for (const entry of await readdir("assets")) {
  const path = `assets/${entry}`;
  if (/^portfolio-preview(?:-.+)?\.png$/.test(entry) && !currentPreviewPaths.has(path)) {
    await rm(path);
  }
}

const browser = await chromium.launch({ headless: true });

async function capture(themeName) {
  const theme = themes[themeName];
  // GitHub renders this profile README at 846px on a 2560x1440 viewport.
  // Matching an exact 3:1 source-to-display ratio avoids fractional resampling
  // of the captured type while retaining ample density on smaller screens.
  const deviceScaleFactor = githubReadmeWidthAt1440p * targetDisplayDensity / 592;
  const context = await browser.newContext({
    viewport: { width: probeWidth, height: layoutHeight },
    deviceScaleFactor,
    colorScheme: themeName,
    reducedMotion: "reduce",
  });

  try {
    const page = await context.newPage();

    await page.addInitScript(() => {
      localStorage.removeItem("portfolio-theme");
    });

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
        :root {
          --ink: ${theme.ink} !important;
          --ink-soft: ${theme.inkSoft} !important;
          --muted: ${theme.muted} !important;
          --bg: ${theme.background} !important;
          --bg-rgb: ${theme.backgroundRgb} !important;
          --bg-0: rgba(${theme.backgroundRgb}, 0) !important;
          --rule-soft: ${theme.rule} !important;
          --link-line: ${theme.linkLine} !important;
        }
        html, body {
          background: ${theme.background} !important;
          scrollbar-width: none !important;
        }
        body {
          -webkit-font-smoothing: auto !important;
        }
        ::-webkit-scrollbar {
          display: none !important;
        }
      `,
    });

    const probe = await page.evaluate(() => {
      const column = document.querySelector(".col")?.getBoundingClientRect();
      const firstPhoto = document.querySelector(".slide")?.getBoundingClientRect();
      const track = document.querySelector(".track");
      const gap = track ? Number.parseFloat(getComputedStyle(track).columnGap) || 0 : 0;

      if (!column || !firstPhoto) {
        throw new Error("Could not measure the portfolio column and first photo.");
      }

      return {
        columnWidth: column.width,
        photoWidth: firstPhoto.width,
        gap,
      };
    });

    // The first photo begins at the centred column's left edge. The distance
    // from there to the screenshot's right edge is therefore (width + column)/2.
    // Set that span to one full photo, one gap, and three quarters of photo two.
    const captureWidth = Math.round(
      2 * (targetVisiblePhotos * probe.photoWidth + probe.gap) - probe.columnWidth,
    );

    if (captureWidth < probe.columnWidth || captureWidth > probeWidth) {
      throw new Error(`Calculated capture width ${captureWidth}px is outside the expected range.`);
    }

    await page.setViewportSize({ width: captureWidth, height: layoutHeight });
    await page.waitForTimeout(100);

    const crop = await page.evaluate(() => {
      window.scrollTo(0, 0);

      const pageElement = document.querySelector(".page");
      const workSection = Array.from(document.querySelectorAll(".listing"))
        .find((section) => section.querySelector("h2")?.textContent.trim() === "Work Experience");
      const workItems = workSection ? Array.from(workSection.querySelectorAll(".item")) : [];
      const thirdItem = workItems[2];
      const secondRole = workItems[1]?.querySelector(".sub");
      const firstPhoto = document.querySelector(".slide")?.getBoundingClientRect();
      const column = document.querySelector(".col")?.getBoundingClientRect();
      const track = document.querySelector(".track");
      const gap = track ? Number.parseFloat(getComputedStyle(track).columnGap) || 0 : 0;

      if (!pageElement || !thirdItem || !secondRole || !firstPhoto || !column) {
        throw new Error("Could not find the portfolio elements needed for the crop.");
      }

      const sideGutter = column.left;

      // Use the measured side gutter as the spacing unit on every edge. Hide
      // only the off-canvas third role so the enlarged lower gutter stays blank.
      pageElement.style.paddingTop = `${sideGutter}px`;
      thirdItem.style.visibility = "hidden";

      const adjustedColumn = document.querySelector(".col").getBoundingClientRect();
      const secondRoleBottom = secondRole.getBoundingClientRect().bottom;
      const cropHeight = Math.round(secondRoleBottom + sideGutter);
      const visiblePhotos = (window.innerWidth - firstPhoto.left - gap) / firstPhoto.width;

      return {
        cropHeight,
        secondRoleBottom,
        whitespaceAfterSecondRole: cropHeight - secondRoleBottom,
        topWhitespace: adjustedColumn.top,
        thirdItemText: thirdItem.textContent.trim(),
        visiblePhotos,
        leftGutter: adjustedColumn.left,
        rightGutter: window.innerWidth - adjustedColumn.right,
      };
    });

    if (!crop.thirdItemText.startsWith("Queen Mary University of London")) {
      throw new Error(`Unexpected third work item: ${crop.thirdItemText}`);
    }
    if (Math.abs(crop.visiblePhotos - targetVisiblePhotos) > 0.01) {
      throw new Error(`Expected ${targetVisiblePhotos} visible photos, measured ${crop.visiblePhotos}.`);
    }
    if (Math.abs(crop.leftGutter - crop.rightGutter) > 0.5) {
      throw new Error(`Capture gutters are not balanced: ${crop.leftGutter}px / ${crop.rightGutter}px.`);
    }
    if (Math.abs(crop.topWhitespace - crop.leftGutter) > 0.5) {
      throw new Error(`Top whitespace ${crop.topWhitespace}px does not match the ${crop.leftGutter}px side gutter.`);
    }
    if (Math.abs(crop.whitespaceAfterSecondRole - crop.leftGutter) > 0.5) {
      throw new Error(`Bottom whitespace ${crop.whitespaceAfterSecondRole}px does not match the ${crop.leftGutter}px side gutter.`);
    }

    await page.evaluate(({ cropHeight, theme }) => {
      const frame = document.createElement("div");
      Object.assign(frame.style, {
        position: "absolute",
        inset: `0 0 auto 0`,
        height: `${cropHeight}px`,
        zIndex: "2147483646",
        border: `1px solid ${theme.cueBorder}`,
        boxSizing: "border-box",
        pointerEvents: "none",
      });

      const cue = document.createElement("div");
      cue.setAttribute("aria-hidden", "true");
      cue.innerHTML = `
        <span>Open portfolio</span>
        <span style="color:${theme.cueAccent};font-size:16px;line-height:0.8">&#8599;</span>
      `;
      Object.assign(cue.style, {
        position: "fixed",
        right: "24px",
        top: "24px",
        zIndex: "2147483647",
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "10px 13px",
        color: theme.ink,
        background: theme.cueBackground,
        border: `1px solid ${theme.cueBorder}`,
        borderRadius: "999px",
        boxShadow: "none",
        fontFamily: `Georgia, "Times New Roman", serif`,
        fontSize: "14px",
        lineHeight: "1",
        letterSpacing: "0.01em",
        whiteSpace: "nowrap",
        pointerEvents: "none",
      });

      document.body.append(frame, cue);
    }, { cropHeight: crop.cropHeight, theme });

    await page.screenshot({
      path: previewPaths[themeName],
      type: "png",
      animations: "disabled",
      caret: "hide",
      clip: {
        x: 0,
        y: 0,
        width: captureWidth,
        height: crop.cropHeight,
      },
      scale: "device",
    });

    return {
      themeName,
      captureWidth,
      outputWidth: Math.round(captureWidth * deviceScaleFactor),
      deviceScaleFactor,
      ...crop,
    };
  } finally {
    await context.close();
  }
}

try {
  const captures = [];
  for (const themeName of Object.keys(themes)) {
    captures.push(await capture(themeName));
  }

  const readme = `<a href="${portfolioUrl}" title="Open portfolio">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./${previewPaths.dark}">
    <source media="(prefers-color-scheme: light)" srcset="./${previewPaths.light}">
    <img src="./${previewPaths.light}" alt="Preview of Christian Juresh's portfolio; click anywhere to open the website" width="100%">
  </picture>
</a>
`;

  await writeFile("README.md", readme, "utf8");
  console.log(JSON.stringify({
    sourceSha,
    githubReadmeWidthAt1440p,
    targetDisplayDensity,
    targetVisiblePhotos,
    captures,
  }, null, 2));
} finally {
  await browser.close();
}
