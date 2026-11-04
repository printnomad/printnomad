# Report worker

Receives the reports testers send with **Send report** in the extension and files each one as
an issue in a private repository. No account or email is asked of the tester. The project file
is never sent: only the text shown in the panel, after the user clicks, plus an optional contact
email the user may add. **Keep the reports repository private**: its issues hold those emails.

## Deploy

1. Create the private repository named in `wrangler.toml` (`REPORTS_REPO`).
2. Create a fine-grained GitHub token limited to that repository, with **Issues: read and write**.
3. In this folder, with a Cloudflare account:

   ```sh
   npx wrangler login
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler deploy
   ```

4. Put the URL `wrangler deploy` prints in `extension/config.json` (`reportUrl`) and rebuild the
   extension. While it is empty, the extension only offers **Copy report**.
5. Once the Chrome Web Store id exists, set `ALLOWED_EXTENSION_IDS` and deploy again.

## Limits

- Report 32,000 characters, comment 2,000, contact 254; longer reports are cut by the extension.
- 5 reports per minute per address (Cloudflare's rate limit is approximate and per location).
- The origin check keeps other websites out, but a script can forge it: the limit and a private
  repository are the real protection. If spam appears, rotate the token or add a challenge.

## Tests

`npm test` in `extension/` also runs `test/`.
