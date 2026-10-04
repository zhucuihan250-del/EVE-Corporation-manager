import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeFittingEngine } from "./fitting-engine";
import { createFittingWorkbenchFixture } from "./fitting-workbench-test-fixture";

after(closeFittingEngine);
type CatalogResponse = { items: Array<{ typeId: number; capabilities: { rigSize: number } }> };
const catalogBody = (response: Response) => response.json() as Promise<CatalogResponse>;

test("HTTP catalog validates bounded hull/subsystem/charge context and preserves exact lookup", async () => {
  const fixture = await createFittingWorkbenchFixture();
  const { url, server } = await fixture.listen();
  const request = (query: string, user = 2) => fetch(`${url}/api/fitting/catalog?language=en&${query}`, { headers: { "x-test-user": String(user) } });
  try {
    const valid = await request("category=module&slot=rig&shipTypeId=593&subsystemTypeIds=&limit=100");
    assert.equal(valid.status, 200);
    const filtered = await catalogBody(valid);
    assert.equal(filtered.items.length, 100);
    assert.ok(filtered.items.every((item: { capabilities: { rigSize: number } }) => item.capabilities.rigSize === 1));
    const charge = await request("category=charge&shipTypeId=638&chargeForTypeId=501&q=Scourge%20Heavy%20Missile");
    assert.equal(charge.status, 200);
    assert.ok((await catalogBody(charge)).items.some(item => item.typeId === 209));
    const t3 = await request("category=module&shipTypeId=29984&subsystemTypeIds=45601&q=Heavy%20Missile%20Launcher%20I");
    assert.equal(t3.status, 200);
    assert.ok((await catalogBody(t3)).items.some(item => item.typeId === 501));
    for (const query of [
      "shipTypeId=34", "shipTypeId=999999999", "shipTypeId=1e3", "shipTypeId=-1", "shipTypeId=2147483648", "shipTypeId=593&shipTypeId=638",
      "chargeForTypeId=34", "chargeForTypeId=999999999", "chargeForTypeId=1.5", "chargeForTypeId[]=501",
      "subsystemTypeIds=", "shipTypeId=593&subsystemTypeIds=45601", "shipTypeId=29984&subsystemTypeIds=45601,45603", "shipTypeId=29984&subsystemTypeIds=45601,45601",
      "shipTypeId=29984&subsystemTypeIds=1,2,3,4,5,6", "shipTypeId=29984&subsystemTypeIds=45601,", "shipTypeId=29984&subsystemTypeIds[]=45601",
    ]) {
      const result = await request(query);
      assert.equal(result.status, 400, query);
      const body = await result.json() as { code: string };
      assert.match(body.code, /^FITTING_INVALID_/u, query);
      assert.equal(JSON.stringify(body).includes("fixture-access"), false);
    }
    const exact = await request("typeIds=20703,31528,501&shipTypeId=34&subsystemTypeIds=not-a-valid-list");
    assert.equal(exact.status, 200);
    assert.deepEqual((await catalogBody(exact)).items.map(item => item.typeId), [20703, 31528, 501]);
    const legacy = await request("q=Capital%20Shield%20Booster%20I&category=module");
    assert.equal(legacy.status, 200);
    assert.ok((await catalogBody(legacy)).items.some(item => item.typeId === 20703));
    assert.equal((await request("shipTypeId=593", 0)).status, 401);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fixture.close();
  }
});

test("new catalog context keeps the existing fitting feature gate", async () => {
  const fixture = await createFittingWorkbenchFixture({ fleetEnabled: false });
  const { url, server } = await fixture.listen();
  try {
    const result = await fetch(`${url}/api/fitting/catalog?shipTypeId=593&category=module`, { headers: { "x-test-user": "2" } });
    assert.equal(result.status, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fixture.close();
  }
});
