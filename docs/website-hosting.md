# Pigry website

The public product website is served at https://d-osc.github.io/pigry/.

Edit the static HTML, CSS, JavaScript and assets in `docs/site/`. The Pages workflow deploys this directory after changes reach `main`, and can also be run manually from GitHub Actions. No build or dependencies are required.

The initial content was copied from the separately hosted Sites checkout in `website/dist/`. The GitHub Pages deployment uses only the files tracked under `docs/site/`; it does not depend on that local checkout or its hosting credentials.

Installer links point directly to the published GitHub release. When updating the release, update both language variants in `index.html` and `app.js`, the version, download URL, size and `downloads/SHA256SUMS.txt` together. The checksum is the SHA-256 digest of the corresponding release asset.

## Search and social previews

The English page content, title, description, canonical URL and JSON-LD are included in the HTML so crawlers do not need JavaScript to discover them. The Thai toggle still remembers the visitor's choice. Both languages share one URL; do not add `hreflang` until there are separate crawlable language URLs.

`sitemap.xml` lists the canonical homepage. Submit `https://d-osc.github.io/pigry/sitemap.xml` in Google Search Console after verifying the URL-prefix property `https://d-osc.github.io/pigry/`. Verification requires the owner's Search Console account; no verification token is included in this repository.

GitHub project Pages cannot control the origin-level `https://d-osc.github.io/robots.txt`. A file at `/pigry/robots.txt` would not control crawling, so this site uses page-level robots metadata instead. Avoid claiming that a project-level robots file configures Googlebot.

Open Graph and Twitter cards use the committed 1200×630 PNG at `assets/social-preview.png`. The SoftwareApplication JSON-LD describes real features and supported release platforms; keep its version and download URL in sync with releases. No ratings or reviews are invented, and markup does not guarantee a rich result or ranking.
