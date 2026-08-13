/**
 * The social card, as markup.
 *
 * A link to this site posted anywhere - a chat, a timeline, a pull request
 * description - is rendered by whoever receives it from `og:image`, and without
 * one a `summary_large_image` card is a grey box with a URL in it. That is the
 * first impression the project makes in the place most people meet it.
 *
 * **Drawn in a browser rather than in a canvas library.** The card is the
 * landing page's palette and type at a different size, and keeping it as HTML
 * means it is the same CSS rather than a second description of the same design
 * that drifts. `buddy social:card` renders this in headless Chrome and writes
 * the PNG, which is committed - generation needs a browser, serving it does not.
 *
 * No web fonts. A generator that reaches the network renders differently
 * depending on whether it could, which is the one thing an image nobody looks
 * at again must not do. The stack below is what the machine has.
 */

export interface CardContent {
  /** The line somebody reads first, at the size they read it. */
  title: string
  /** One sentence under it. Two lines at most at this width. */
  subtitle: string
  /** The small line above the title. */
  eyebrow: string
  /** The domain, bottom right, so a screenshot of the card still says where it is from. */
  site: string
}

export const CARD_WIDTH = 1200
export const CARD_HEIGHT = 630

export const DEFAULT_CARD: CardContent = {
  eyebrow: 'Open source, self-hostable',
  title: 'A git forge built around review',
  subtitle: 'Stacked pull requests, review threads that survive a force-push, and a diff that stays fast at a hundred files.',
  site: 'reviewos.org',
}

/** The one place a value from outside becomes markup. */
function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The card at 1200x630, which is what every platform crops from.
 *
 * The dark theme rather than the light one: a card is seen against somebody
 * else's interface, and the dark one holds its edges on both.
 */
export function renderCard(content: CardContent = DEFAULT_CARD): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #0c1113;
    --surface: #121a1c;
    --line: #222e31;
    --text: #eef2f2;
    --muted: #9aa9ac;
    --accent: #4ec5c9;
    --accent-text: #7fd8db;
  }

  body {
    width: ${CARD_WIDTH}px;
    height: ${CARD_HEIGHT}px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 72px 80px;
    position: relative;
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
  }

  /* One glow, off the top right corner. Enough to keep a flat dark rectangle
     from reading as a failed load, and not enough to compete with the words. */
  body::before {
    content: '';
    position: absolute;
    top: -280px;
    right: -220px;
    width: 720px;
    height: 720px;
    border-radius: 50%;
    background: radial-gradient(circle, rgb(78 197 201 / 0.16), rgb(78 197 201 / 0) 68%);
  }

  .top { display: flex; align-items: center; gap: 14px; position: relative; }

  .mark {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    background: var(--accent);
  }

  .wordmark { font-size: 26px; font-weight: 700; letter-spacing: -0.01em; }

  .middle { position: relative; }

  .eyebrow {
    font-size: 20px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent-text);
    margin-bottom: 22px;
  }

  h1 {
    font-size: 68px;
    line-height: 1.05;
    font-weight: 700;
    letter-spacing: -0.025em;
    max-width: 15ch;
  }

  p {
    margin-top: 26px;
    font-size: 25px;
    line-height: 1.45;
    color: var(--muted);
    max-width: 44ch;
  }

  .bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: relative;
    border-top: 1px solid var(--line);
    padding-top: 26px;
  }

  .site { font-size: 22px; font-weight: 600; color: var(--muted); }

  .badges { display: flex; gap: 10px; }

  .badge {
    font-size: 18px;
    font-weight: 500;
    color: var(--muted);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 8px 16px;
  }
</style>
</head>
<body>
  <div class="top">
    <div class="mark"></div>
    <div class="wordmark">ReviewOS</div>
  </div>

  <div class="middle">
    <div class="eyebrow">${escapeHtml(content.eyebrow)}</div>
    <h1>${escapeHtml(content.title)}</h1>
    <p>${escapeHtml(content.subtitle)}</p>
  </div>

  <div class="bottom">
    <div class="site">${escapeHtml(content.site)}</div>
    <div class="badges">
      <div class="badge">Repositories</div>
      <div class="badge">Issues</div>
      <div class="badge">Pull requests</div>
      <div class="badge">Checks</div>
    </div>
  </div>
</body>
</html>`
}
