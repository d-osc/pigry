# Pigry website

The public product website is served at https://d-osc.github.io/pigry/.

Edit the static HTML, CSS, JavaScript and assets in `docs/site/`. The Pages workflow deploys this directory after changes reach `main`, and can also be run manually from GitHub Actions. No build or dependencies are required.

The initial content was copied from the separately hosted Sites checkout in `website/dist/`. The GitHub Pages deployment uses only the files tracked under `docs/site/`; it does not depend on that local checkout or its hosting credentials.

Installer links point directly to the published GitHub release. When updating the release, update both language variants in `index.html` and `app.js`, the version, download URL, size and `downloads/SHA256SUMS.txt` together. The checksum is the SHA-256 digest of the corresponding release asset.
