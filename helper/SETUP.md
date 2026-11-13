# Link helper setup (about 10 minutes, free)

1. Sign in at dash.cloudflare.com (free account).
2. Workers & Pages, then Create, then Create Worker. Name it `roomdesign-helper`, tap Deploy.
3. Tap Edit code. Delete the sample code, paste in everything from `helper/worker.js`, tap Deploy.
4. Copy the worker's address, like `https://roomdesign-helper.yourname.workers.dev`.
5. In Room Designer: Menu, Link helper, paste the address.

Then in Add a piece, paste a product link and tap Fetch details. Check the numbers against the store page.

By default only https://jpathfit-ui.github.io can use the helper. To allow another address, add a Worker variable `ALLOW_ORIGIN` in Settings.

## Search fallback (optional key)

When a store blocks the helper, or its page has no sizes, the helper searches for the product name from the link and reads the sizes out of the results. It works without setup using DuckDuckGo, but that can be turned away. For steadier results, get a free key at brave.com/search/api and add it in Cloudflare as a Worker variable named `BRAVE_KEY` (type: Secret). Sizes found this way are estimates, so the app tells you to check them.
