# WikiDrift

WikiDrift shows how Wikipedia articles change over time and how different language editions cover the same topic. It runs on Cloudflare Workers with Workers AI and stores each reader’s library in their browser.

[Try the public demo](https://wikidrift.demo.mooseaillc.com/).

## Explore

- **Revision history** lists edits by date, with author names, edit summaries and links to the original Wikipedia revisions. Select an edit to compare it with its parent. Pick two revisions to compare a longer range and list the contributors between them.
- **Language editions** offers Wikipedia’s linked editions of the same article. Compare original passages side by side, or ask Workers AI to translate the selected comparison passage and show a word diff. Each edition links to its current revision and full contributor history.
- **AI analysis** reviews bounded excerpts for differences in tone, framing, coverage and attribution. Findings cite passages and link to their sections. **Scan 5 edits** examines the first five edits in the current timeline that have a parent and flags individual edits with supporting evidence.
- **Library** keeps article and author favorites, tags and the last 100 viewed articles in local storage. Open an author menu beside an edit to filter the timeline to that author’s edits on the current article. Named author accounts are scoped to each Wikipedia edition. Anonymous edits link to the original revision.

Both comparisons use readable article prose. A linked Wikipedia diff supplies the underlying wikitext, citations and formatting. AI findings reflect the passages examined and do not establish an editor’s beliefs or intent. Translated word diffs may reflect translation choices.

## Run locally

Use Node.js 22 or later with npm.

```sh
npm ci
npm run dev -- --local --var AI_DISABLED:true
```

Open the URL printed by Wrangler to browse public Wikipedia data. To try live AI, sign in to Cloudflare and run Wrangler with its remote AI binding enabled.

```sh
npx wrangler login
npm run dev
```

AI calls during development use your Cloudflare account’s Workers AI allowance. The app keeps Cloudflare credentials in Wrangler and uses the `AI` binding on the Worker.

## Deploy a public demo

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fchiesennegs%2FWikiDrift)

1. Create or select your Cloudflare account and keep it on Workers Free.
2. In [wrangler.jsonc](wrangler.jsonc), set a unique Worker name if needed. Set `WIKIMEDIA_CONTACT` in `vars` to the published repository URL or a public maintainer contact. Give `AI_LIMIT.namespace_id` a unique value per deployment within the same Cloudflare account.
3. Run `npm run deploy` from the checkout. For Git-based deployments, connect the repository to [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) and deploy with `npx wrangler deploy`. Wrangler builds the browser bundle from the checked-in source.
4. Open the deployed URL and verify article search, both comparisons and an AI request. Share the public URL from the repository once the demo has been verified.

Workers Free includes 10,000 Workers AI Neurons per day, with a daily reset at 00:00 UTC. The demo uses the Free-compatible GLM-4.7-Flash model, runs AI on demand, rate-limits inference by IP, and caches repeated analysis of the same excerpts at the edge. All AI calls in the same account share its daily allowance. Public access can consume that allowance. Set `AI_DISABLED` to `"true"` to pause AI without taking the demo offline. Wikipedia browsing, source diffs and the library remain available when AI is unavailable. [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)

To increase the allowance, upgrade the account to Workers Paid. The same code and binding work on Paid, where inference above the included allowance incurs usage charges. You can also set `AI_MODEL` in Wrangler to change the model. Choose one that supports the chat and structured output used here. [Workers AI model catalog](https://developers.cloudflare.com/workers-ai/models/)

## Deploy a private instance

1. Copy `wrangler.jsonc` to `wrangler.private.jsonc` in the same checkout. This filename is ignored by Git. Give the Worker a distinct name and rate-limit namespace ID. Set `workers_dev` and `preview_urls` to `false`.
2. Enable Zero Trust and [One-time PIN login](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/). Create a [Cloudflare Access application for the custom hostname](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) and configure an Allow policy with the email addresses that should be able to sign in. Protect the entire hostname, including `/api/*`.
3. Add a route in the private config using `"routes": [{ "pattern": "wiki.example.com", "custom_domain": true }]` with your own hostname. Deploy with `npm run deploy -- --config wrangler.private.jsonc`.
4. Open the private URL in a signed-out browser and verify that both the site and a direct `/api/languages` request prompt for login. Then verify a permitted address can access the site.

A separate Cloudflare account gives the private instance a separate Workers AI allowance. Each hostname has its own browser-local library.

## Checks

```sh
npm test
npm run build
```

## License

WikiDrift’s original code is available under the [MIT License](LICENSE). Wikipedia text and the app’s translated adaptations are attributed through links to the source revisions and article histories and are available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), subject to the [Wikimedia reuse terms](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#7._Licensing_of_Content).
