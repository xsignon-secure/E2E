# Token benchmark: diagnosing one drifted locator

Run 2026-11-01 with playwright-e2e-mcp 0.9.0 and Playwright 1.64.1 (`playwright mcp`). Reproduce with `npm run build && node bench/token-benchmark.mjs`.

Scenario: a storefront page (navigation, search, 24 product cards, cart, footer) renamed its checkout button test id from `checkout-button` to `checkout-btn`; the spec still uses the old one. Tokens are estimated as characters ÷ 4 for both routes.

The `core` column loads only the 7 tools in `PW_MCP_TOOLS=core` (or `--tools=core`); the all-tools column loads all 19. Tool definitions are sent with every request, so load only the profiles you use.

| Step | playwright-e2e-mcp (`core` tools) | playwright-e2e-mcp (all tools) | Playwright MCP + shell |
| --- | ---: | ---: | ---: |
| Tool definitions the model reads (every request) | 2,266 | 11,480 | 4,558 |
| Run the failing test | 257 | 257 | 323 |
| Find the element / propose the fix | 232 | 232 | 2,286 |
| Apply + verify (re-run) | 230 | 230 | 34 |
| **Total for one fix** | 2,985 | 12,199 | 7,201 |

Full `tools/list` on the wire, output schemas and annotations included: 4,788 (`core`), 15,898 (all tools), 5,225 (Playwright MCP).

Fixed and verified by playwright-e2e-mcp without an edit by the agent: **yes**.

Route B is a lower bound: it assumes the agent reads one snapshot, writes the right locator first time and re-runs once. It also leaves the reasoning (matching `checkout-button` to "Proceed to checkout" among ~150 elements) to the model, which route A does in the server.

## Looking at a page

Writing a new test starts with reading the page. The locator map lists verified locators and shows repeated blocks (here, 24 product cards) once.

| Looking at the storefront page | Tokens |
| --- | ---: |
| playwright-e2e-mcp `inspect-page` (default: locator map) | 571 |
| playwright-e2e-mcp `inspect-page` `view: 'aria'` | 2,797 |
| Playwright MCP `browser_navigate` + `browser_snapshot` | 2,286 |

<details><summary>playwright-e2e-mcp: inspect-page (default view)</summary>

```markdown
## 🔎 "Northwind Outfitters"

**URL:** http://127.0.0.1:32795/  
**Elements:** 140  |  **Viewport:** 1280×720  |  **Took:** 2411ms

### Locator map (80 of 140 visible interactive elements, locators verified unique)

1. `getByRole('link', { name: 'Northwind Outfitters' })` — link "Northwind Outfitters"
2. `getByRole('navigation')` — navigation
3. `getByRole('link', { name: 'New' })` — link "New"
4. `getByRole('link', { name: 'Men', exact: true })` — link "Men"
5. `getByRole('link', { name: 'Women' })` — link "Women"
6. `getByRole('link', { name: 'Sale' })` — link "Sale"
7. `getByRole('link', { name: 'Help' })` — link "Help"
8. `getByRole('searchbox', { name: 'Search' })` — searchbox "Search" · also `getByLabel('Search')`
9. `getByRole('button', { name: 'Search' })` — button "Search"
10. `getByRole('link', { name: 'Account' })` — link "Account"
11. `getByRole('main')` — main
12. `getByRole('heading', { name: 'All products' })` — heading "All products"
13. `getByRole('checkbox', { name: 'In stock' })` — checkbox "In stock" · also `getByLabel('In stock')`
14. `getByRole('checkbox', { name: 'On sale' })` — checkbox "On sale" · also `getByLabel('On sale')`
15. `getByRole('combobox', { name: 'Sort' })` — combobox "Sort"
16. `getByTestId('product-1')` — article
17. `getByRole('img', { name: 'Trail Runner 1' })` — img "Trail Runner 1"
18. `getByRole('heading', { name: 'Trail Runner 1' })` — heading "Trail Runner 1"
19. `locator('article:nth-of-type(1) > label > input')` — spinbutton "Qty"
20. `getByTestId('add-to-cart-1')` — button "Add to cart"
21–60. ↳ 8 more blocks like 16–20: same locators with the item's own name or number: "City Sneaker 1", "Rain Shell 1", "Wool Beanie 1", "Canvas Tote 1", "Steel Bottle 1", "Trail Runner 2", "City Sneaker 2", "Rain Shell 2". Pass `selector` to list one in full.
61. `article:nth-of-type(10)` — article
62. `article:nth-of-type(10) > img` — img "Wool Beanie 2"
63. `article:nth-of-type(10) > h3` — heading "Wool Beanie 2"
64. `article:nth-of-type(10) > label > input` — spinbutton "Qty"
65. `article:nth-of-type(10) > button` — button "Add to cart"
66–80. ↳ 3 more blocks like 61–65: same locators with the item's own name or number: "Canvas Tote 2", "Steel Bottle 2", "Trail Runner 3". Pass `selector` to list one in full.
```

</details>

## What each route returned for the diagnosis step

<details><summary>playwright-e2e-mcp: suggest-fix</summary>

```markdown
## 🩹 Fix for failure 1 of 1 — checkout.spec.ts › cart proceeds to checkout

**File:** `tests/checkout.spec.ts:3`  |  **Kind:** `timeout`

### Proposed locator fix — confidence **high**

`getByTestId('checkout-button')` no longer matches anything. In the DOM snapshot at failure (Playwright trace), the button "Proceed to checkout" matches "checkout", and `getByRole('button', { name: 'Proceed to checkout' })` is proven to resolve to exactly that element.

```diff
--- a/tests/checkout.spec.ts
+++ b/tests/checkout.spec.ts
@@ -4,5 +4,5 @@
   await page.goto('/');
   await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible();
-  await page.getByTestId('checkout-button').click({ timeout: 3000 });
+  await page.getByRole('button', { name: 'Proceed to checkout' }).click({ timeout: 3000 });
 });
```

> Next: call **suggest-fix** again with `apply: true` to write this change and re-run the test to verify it.
```

</details>

<details><summary>Playwright MCP: browser_snapshot (2,231 tokens, first 40 lines)</summary>

```markdown
### Page
- Page URL: http://127.0.0.1:32795/
- Page Title: Northwind Outfitters
### Snapshot
```yaml
- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - link "Northwind Outfitters" [ref=e3] [cursor=pointer]:
      - /url: /
    - navigation [ref=e4]:
      - link "New" [ref=e5] [cursor=pointer]:
        - /url: /new
      - link "Men" [ref=e6] [cursor=pointer]:
        - /url: /men
      - link "Women" [ref=e7] [cursor=pointer]:
        - /url: /women
      - link "Sale" [ref=e8] [cursor=pointer]:
        - /url: /sale
      - link "Help" [ref=e9] [cursor=pointer]:
        - /url: /help
    - search [ref=e10]:
      - text: Search
      - searchbox "Search" [ref=e11]
      - button "Search" [ref=e12]
    - link "Account" [ref=e13] [cursor=pointer]:
      - /url: /account
  - main [ref=e14]:
    - heading "All products" [level=1] [ref=e15]
    - region "Filters" [ref=e16]:
      - generic [ref=e17]:
        - checkbox "In stock" [ref=e18]
        - text: In stock
      - generic [ref=e19]:
        - checkbox "On sale" [ref=e20]
        - text: On sale
      - combobox "Sort" [ref=e21]:
        - option "Featured" [selected]
        - 'option "Price: low to high"'
        - 'option "Price: high to low"'
    - generic [ref=e22]:
```

</details>
