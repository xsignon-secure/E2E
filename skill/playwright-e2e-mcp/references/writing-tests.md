# Writing Playwright tests that stay green

Use this when you write a new test, extend one, or review one. It applies with or
without the MCP server; where a tool helps, it is named.

## 1. Locators

Pick the first that works, and check it with `validate-selector` (exactly 1 match)
or take it from `inspect-page` with `view: "locators"`:

1. `page.getByRole('button', { name: 'Place order' })`: what a user and a screen
   reader see. Add `exact: true` when the name is a prefix of another.
2. `page.getByLabel('Email')`, `page.getByPlaceholder('Search')` for form fields.
3. `page.getByText('Order confirmed')` for non-interactive content.
4. `page.getByTestId('checkout')` when the app has test ids (set a custom
   attribute with `testIdAttribute` in the config).
5. A short CSS selector on a stable attribute, as a last resort.

Narrow instead of indexing: `page.getByRole('listitem').filter({ hasText: 'Milk' })`,
`row.getByRole('button', { name: 'Delete' })`. Avoid `nth()`, `:nth-child`,
XPath, generated class names (`.css-1x2y3z`) and long descendant chains. Locators
are strict: an action on a locator that matches several elements throws, which
is a feature. Fix the locator rather than adding `.first()`.

## 2. Waiting and assertions

- Use web-first assertions, which retry until the timeout:
  `await expect(page.getByRole('alert')).toHaveText('Saved')`, `toBeVisible()`,
  `toHaveURL(/\/orders\/\d+/)`, `toHaveCount(3)`, `toBeEnabled()`.
- Never `expect(await locator.isVisible()).toBe(true)` or
  `expect(await locator.textContent())`: they read once and do not wait.
- Never `page.waitForTimeout(…)`. Wait for the thing you need: an assertion, a
  response, or a URL.
- Actions already wait for the element to be visible, enabled and stable; do
  not add `waitForSelector` before `click`.
- For a value that is not in the DOM, poll: `await expect.poll(() => api.count()).toBe(3)`.
- Wait for a request triggered by an action by starting the wait first:

  ```ts
  const saved = page.waitForResponse((r) => r.url().includes('/api/orders') && r.ok());
  await page.getByRole('button', { name: 'Save' }).click();
  await saved;
  ```
- `waitForLoadState('networkidle')` is discouraged: apps with polling or
  analytics never go idle. Assert on the content you need instead.
- Use `expect.soft` only when later checks still make sense after a failure.

## 3. Signing in

Log in once, not in every test. Use a setup project that saves the session and
make the other projects depend on it:

```ts
// tests/auth.setup.ts
import { test as setup, expect } from '@playwright/test';
setup('sign in', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.E2E_USER!);
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.context().storageState({ path: 'playwright/.auth/user.json' });
});
```

```ts
// playwright.config.ts
projects: [
  { name: 'setup', testMatch: /.*\.setup\.ts/ },
  { name: 'chromium', use: { ...devices['Desktop Chrome'], storageState: 'playwright/.auth/user.json' }, dependencies: ['setup'] },
],
```

Keep `playwright/.auth/` in `.gitignore`. Use one file per role (admin, member).
Credentials come from environment variables, never from the spec. Pass the same
file as `storageState` to `inspect-page`, `validate-selector` and
`audit-accessibility` to look at signed-in pages.

## 4. Test data and isolation

Every test must pass alone, in any order, and in parallel:

- Create the data a test needs in the test or a fixture, ideally through the API
  (`request.post('/api/products', { data })`), not through the UI and not by
  relying on a test that ran earlier.
- Make it unique per worker and run:
  `` `user-${testInfo.workerIndex}-${Date.now()}@example.com` ``.
- Clean up what you created, or create it in a namespace that is reset.
- Do not share mutable module or `globalThis` state between tests.

Check it: `diagnose-flaky` with `isolate: true` finds tests that only fail in
parallel; `order: true` finds tests that depend on another test running first.

## 5. Network and time

- Mock third parties (payments, maps, analytics) with `page.route`, and mock your
  own API only for states that are hard to reach (errors, empty lists):

  ```ts
  await page.route('**/api/orders', (route) => route.fulfill({ status: 500, json: { error: 'down' } }));
  ```
- Replay a recorded session with `page.routeFromHAR` when the backend is slow or
  unstable.
- Mocks are frozen copies of the API. Run `check-mocks` against the dev or staging
  server (and `playwright-e2e-mcp mocks --base-url …` in CI) so a renamed field
  fails a check instead of hiding behind a green suite.
- Server-rendered apps (Next.js, Nuxt, Remix, Astro, SvelteKit) are clickable
  before they hydrate. Wait for the app once, in a fixture or `beforeEach`, not
  per click:

  ```ts
  // app: useEffect(() => { document.documentElement.dataset.hydrated = 'true' }, []) in the root layout
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html[data-hydrated]')).toBeAttached();
  });
  ```

  For Astro: `await expect(page.locator('astro-island[ssr]')).toHaveCount(0)`.
  `inspect-page` shows how long the gap is on a given page.
- Control time with `page.clock` (`install`, `setFixedTime`, `fastForward`)
  instead of waiting for timers, and pin `timezoneId` and `locale` in the config
  when dates are on screen.

## 6. Structure

- One user journey per test, named for the behavior: `places an order with a saved card`.
- Group steps with `await test.step('pay', async () => { … })` so traces and
  reports read like the journey.
- Prefer fixtures for setup and shared helpers; use a page object only for a
  page several specs drive. Keep assertions in the test, not in page objects.
- Tag suites (`test('…', { tag: '@smoke' }, …)`) and run them with `--grep @smoke`.

## 7. Config that prevents trouble

```ts
export default defineConfig({
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: 'http://localhost:3000', trace: 'on-first-retry' },
  webServer: { command: 'npm run start', url: 'http://localhost:3000', reuseExistingServer: !process.env.CI },
});
```

`webServer` starts the app so runs never fail with "connection refused". Traces
on retry are what `get-failure` reads.

## 8. Flake patterns

| Symptom | Usual cause | Fix |
| --- | --- | --- |
| Passes locally, times out in CI | Fixed sleeps, slow CI machine, no `webServer` | Web-first assertions; `webServer`; wait for the response |
| "strict mode violation" | Locator matches several elements | Filter or scope the locator |
| Element "detached from the DOM" | List re-renders after data loads | Assert the loaded state first, then act |
| Fails only with other tests | Shared user or data | Unique data per test or worker (`isolate: true` confirms) |
| Fails only after certain tests | Order dependence | Own setup per test (`order: true` names the test) |
| Wrong date or number format | Time zone or locale | Set `timezoneId`, `locale`, `page.clock` |
| Click does nothing | Overlay, animation, or element not ready | Assert the overlay is gone; assert enabled |
| Chat answer text differs or is cut off | Asserting mid-stream, or on live model wording | Mock the stream; wait for the done signal (§10) |

Never fix flakiness with retries, longer timeouts or `waitForTimeout` alone.

## 9. Accessibility and structure checks

- Run `audit-accessibility` on new pages, then keep them clean with
  `@axe-core/playwright`:

  ```ts
  import AxeBuilder from '@axe-core/playwright';
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
  ```
- Lock the structure of a component with
  `await expect(page.getByRole('navigation')).toMatchAriaSnapshot(…)`.
- For visual checks, `compare-visual-state` locally or `toHaveScreenshot()` in
  the suite, with animations disabled and dynamic content masked.

## 10. AI chat and streaming UIs

Model output changes from run to run and arrives in pieces, so tests that
assert on exact wording or on text mid-stream are flaky by design.

- **Mock the model in most tests.** Fulfil the chat endpoint with a fixed
  stream, so the UI code (rendering, markdown, tool calls, errors) is what is
  tested:

  ```ts
  const sse = ['Hello', ', world', '!'].map((t) => `data: ${JSON.stringify({ delta: t })}\n\n`).join('') + 'data: [DONE]\n\n';
  await page.route('**/api/chat', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse }),
  );
  ```

  For a socket transport use `page.routeWebSocket('**/ws', (ws) => …)` and
  send the chunks with `ws.send()`. Run `check-mocks` so a mocked response
  shape that drifted from the real API is caught.
- **Wait for the end of the stream, not for text.** Assert on the signal the
  UI gives when it is done: the stop button is gone, the send button is
  enabled again, `aria-busy="false"`, or a `data-state="done"` marker you add
  for tests:

  ```ts
  const answer = page.getByTestId('message').last();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
  await expect(answer).toHaveAttribute('aria-busy', 'false');
  await expect(answer).toHaveText('Hello, world!');
  ```

  Never assert on a partial answer (`toContainText('Hel')`) and never
  `waitForTimeout` until it "should" be done.
- **Against a live model, assert on shape and meaning, not wording.** Check
  that an answer appeared, is not an error, cites a source, renders a table,
  or matches a loose regex (`/refund/i`). Keep live-model tests few, tag them
  (`@live`) and run them apart from the main suite.
- **Test the unhappy paths with mocks:** a 429 or 500 from the endpoint, a
  stream cut off half-way (`body` without `[DONE]`), a very long answer, the
  user pressing Stop, and sending a second message while the first streams.
- **Give streaming its own timeout** on the final assertion
  (`{ timeout: 30_000 }`) instead of raising the global one.
- Auto-scroll, typing indicators and cursor blink make screenshots unstable;
  mask them, or prefer `toMatchAriaSnapshot()` for the message list.

## 11. Review checklist

- [ ] Every locator is role, label, text or test id based, and unique.
- [ ] No `waitForTimeout`, no assertions on one-off reads.
- [ ] The test creates its own data and passes alone and in any order.
- [ ] Sign-in comes from a saved session, credentials from the environment.
- [ ] Third-party calls are mocked; time-dependent output is pinned.
- [ ] Streaming or AI answers are asserted after the done signal, not mid-stream.
- [ ] The test name describes the behavior; steps are grouped.
- [ ] It ran green with `run-test`, and three times in a row with
      `diagnose-flaky` (`runs: 3`) before you call it done.
