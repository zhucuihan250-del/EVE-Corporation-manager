// Manual UI acceptance server. Never imported by the production app or build.
// Uses ephemeral PGlite data, synthetic login and read-only public EVE assets.
import { createFittingWorkbenchFixture } from "./fitting-workbench-test-fixture";
import { createFittingModelRouter } from "./fitting-model-router";

const port = Number(process.env.FITTING_QA_PORT ?? "4011");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("FITTING_QA_PORT must be 1024..65535");
const fixture = await createFittingWorkbenchFixture({ extraRouterFactory: createFittingModelRouter });
const { url, server } = await fixture.listen(port);
console.log(`Fitting QA API: ${url} (synthetic member; cookie fitting_test_user=5 selects FC)`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await fixture.close();
}
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
