import assert from "node:assert/strict";
import test from "node:test";
import { createFittingAdvicePriceService, FITTING_ADVICE_PRICE_LIMITS } from "./fitting-advice-prices";
import type { CanonicalFit } from "./fitting-engine-types";

const STATION = 60003760;
const fit = (shipTypeId = 1, overrides: Partial<CanonicalFit> = {}): CanonicalFit => ({ schemaVersion: 2, shipTypeId, name: "Price-only test", slots: [], drones: [], cargo: [], skillProfile: { mode: "all5" }, damageProfile: { em: .25, thermal: .25, kinetic: .25, explosive: .25 }, ...overrides });
const order = (id: number, price = 10, extra: Record<string, unknown> = {}) => ({ type_id: id, location_id: STATION, is_buy_order: false, price, volume_remain: 1000, ...extra });
const response = (orders: unknown, pages: string | number = 1) => new Response(JSON.stringify(orders), { status: 200, headers: { "Content-Type": "application/json", "X-Pages": String(pages) } });
const details = (url: Parameters<typeof fetch>[0]) => { const parsed = new URL(String(url)); return { id: Number(parsed.searchParams.get("type_id")), page: Number(parsed.searchParams.get("page")) }; };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function mockFetch(handler: (id: number, page: number, signal: AbortSignal) => Promise<Response> | Response): typeof fetch {
  return (async (url, init) => { const { id,page } = details(url); assert.equal(new URL(String(url)).origin, "https://esi.evetech.net"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal); return handler(id,page,init.signal as AbortSignal); }) as typeof fetch;
}
const missing = (value: Awaited<ReturnType<ReturnType<typeof createFittingAdvicePriceService>["quoteFits"]>>[number]) => { assert.equal(value.estimatedTotalIsk,null); assert.equal(value.complete,false); assert.equal(value.basis,"jita_sell"); assert.ok(value.note.includes("无法确认")); };

test("shared batch counts hull, every module, loaded charges, all carried drones/cargo and implants/boosters", async () => {
  const calls: number[] = [], prices = [0,100,10,2,3,4,5,6];
  const service = createFittingAdvicePriceService({ now: () => 1_000, fetch: mockFetch(id => {
    calls.push(id);
    return response([order(id,prices[id]!),order(id,1,{location_id:60000001}),order(id,.01,{is_buy_order:true}),order(id,.01,{volume_remain:0})]);
  }) });
  const full = fit(1,{ slots:[{rack:"high",index:0,typeId:2,state:"active",chargeTypeId:3,chargeQuantity:4},{rack:"high",index:1,typeId:2,state:"offline",chargeTypeId:3}], drones:[{typeId:4,quantity:6,activeQuantity:1}], cargo:[{typeId:5,quantity:2}], implants:[{typeId:6}], boosters:[{typeId:7}] });
  const quotes = await service.quoteFits([full,{...full,name:"Suggestion"}]);
  assert.deepEqual(calls.sort((a,b)=>a-b),[1,2,3,4,5,6,7]);
  for(const quote of quotes){assert.equal(quote.estimatedTotalIsk,167);assert.equal(quote.complete,true);assert.deepEqual(quote.missingTypeIds,[]);assert.ok(quote.note.includes("1 发"));assert.ok(quote.note.includes("额外补给"));assert.ok(quote.note.includes("不是市场深度"));assert.ok(quote.note.includes("植入体/增效剂"));}
  assert.equal(quotes[0]!.checkedAt,quotes[1]!.checkedAt);
});

test("baseline and two suggestions use identical per-type snapshot rather than re-querying prices", async () => {
  let calls = 0, clock = 1000;
  const service = createFittingAdvicePriceService({ now:()=>clock, fetch:mockFetch(id=>{calls++;return response([order(id,calls*10)]);}) });
  const result=await service.quoteFits([fit(1),fit(1),fit(1)]);
  assert.equal(calls,1);assert.deepEqual(result.map(item=>item.estimatedTotalIsk),[10,10,10]);
  clock+=1000;
  const cached=await service.quoteFits([fit(1)]);
  assert.equal(calls,1);assert.equal(cached[0]!.checkedAt,result[0]!.checkedAt);
});

test("all pages participate in lowest Jita sell, including final page 30", async () => {
  let calls=0;
  const service=createFittingAdvicePriceService({fetch:mockFetch((id,page)=>{calls++;return response([order(id,31-page),order(id,.01,{location_id:60000001})],30);})});
  const result=await service.quoteFits([fit()]);
  assert.equal(calls,30);assert.equal(result[0]!.estimatedTotalIsk,1);assert.equal(result[0]!.complete,true);
});

test("changed, missing, excessive or incomplete pagination never adopts partial cheap pages", async () => {
  for(const kind of ["changed","missing-header","too-many","empty-page","failed-page","bad-shape","bad-order"]){
    let calls=0;
    const service=createFittingAdvicePriceService({fetch:mockFetch((id,page)=>{
      calls++;
      if(kind==="missing-header")return new Response(JSON.stringify([order(id,1)]));
      if(kind==="too-many")return response([order(id,1)],31);
      if(kind==="bad-shape")return response({private_token:"do-not-expose"});
      if(kind==="bad-order")return response([order(id,1),order(id,NaN)]);
      if(page===1)return response([order(id,1)],2);
      if(kind==="failed-page")return new Response("provider-secret-token",{status:503});
      if(kind==="empty-page")return response([],2);
      return response([order(id,100)],3);
    })});
    const result=await service.quoteFits([fit()]);missing(result[0]!);assert.deepEqual(result[0]!.missingTypeIds,[1]);assert.ok(calls<=2);assert.ok(!JSON.stringify(result).includes("provider-secret-token"));assert.ok(!JSON.stringify(result).includes("do-not-expose"));
  }
});

test("missing sell orders, HTTP failure, malformed JSON and too-large bodies are unknown, not zero", async () => {
  for(const make of [
    (id:number)=>response([order(id,100,{is_buy_order:true}),order(id,1,{location_id:60000001})]),
    ()=>new Response("access-token-upstream-private",{status:429}),
    ()=>new Response("private-token <html>",{headers:{"X-Pages":"1"}}),
    ()=>new Response("[]",{headers:{"X-Pages":"1","Content-Length":String(FITTING_ADVICE_PRICE_LIMITS.pageBytes+1)}}),
    ()=>response([]),
  ]){
    const service=createFittingAdvicePriceService({fetch:mockFetch(make)});
    const result=await service.quoteFits([fit()]);missing(result[0]!);assert.deepEqual(result[0]!.missingTypeIds,[1]);assert.ok(!JSON.stringify(result).includes("private-token"));assert.ok(!JSON.stringify(result).includes("access-token"));
  }
});

test("80-type limit applies to the union and oversized batches issue no fetch", async () => {
  let calls=0;
  const service=createFittingAdvicePriceService({fetch:mockFetch(id=>{calls++;return response([order(id)]);})});
  const a=fit(1,{cargo:Array.from({length:40},(_,index)=>({typeId:index+2,quantity:1}))});
  const b=fit(1,{cargo:Array.from({length:40},(_,index)=>({typeId:index+42,quantity:1}))});
  const result=await service.quoteFits([a,b]);assert.equal(calls,0);result.forEach(missing);assert.ok(result[0]!.note.includes("80"));
  await assert.rejects(service.quoteFits([fit(),fit(),fit(),fit()]));assert.equal(calls,0);
});

test("negative, zero, fractional, NaN and infinite quantities cannot become a cheap completed fit", async () => {
  const service=createFittingAdvicePriceService({fetch:mockFetch(id=>response([order(id)]))});
  for(const quantity of [-1,0,.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
    const result=await service.quoteFits([fit(1,{cargo:[{typeId:2,quantity}]})]);missing(result[0]!);assert.ok(result[0]!.missingTypeIds.includes(2));
  }
  const charge=await service.quoteFits([fit(1,{slots:[{rack:"high",index:0,typeId:2,state:"active",chargeTypeId:3,chargeQuantity:NaN}]})]);missing(charge[0]!);assert.ok(charge[0]!.missingTypeIds.includes(3));
});

test("quantity aggregation and monetary multiplication/sum overflow fail safely", async () => {
  const service=createFittingAdvicePriceService({fetch:mockFetch(id=>response([order(id,id===1?1:1e13)]))});
  for(const cargo of [
    [{typeId:2,quantity:Number.MAX_SAFE_INTEGER},{typeId:2,quantity:1}],
    [{typeId:2,quantity:100}],
    [{typeId:2,quantity:6},{typeId:3,quantity:6}],
  ]){
    const result=await service.quoteFits([fit(1,{cargo})]);missing(result[0]!);assert.ok(result[0]!.missingTypeIds.length>0);assert.ok(!JSON.stringify(result).includes("Infinity"));
  }
});

test("cache has five-minute expiry and a bounded LRU entry count", async () => {
  let clock=1000;const calls:number[]=[];
  const service=createFittingAdvicePriceService({now:()=>clock,cacheEntries:2,fetch:mockFetch(id=>{calls.push(id);return response([order(id)]);})});
  for(const id of [1,2,1,3,1,2])await service.quoteFits([fit(id)]);
  assert.deepEqual(calls,[1,2,3,2]);
  clock+=FITTING_ADVICE_PRICE_LIMITS.cacheMs;
  await service.quoteFits([fit(2)]);assert.deepEqual(calls,[1,2,3,2,2]);
});

test("global concurrency is four even across separately injected service instances", async () => {
  let active=0,maximum=0,calls=0;
  const request=mockFetch(async id=>{active++;maximum=Math.max(active,maximum);calls++;await pause(4);active--;return response([order(id)]);});
  const a=createFittingAdvicePriceService({fetch:request}),b=createFittingAdvicePriceService({fetch:request});
  const dense=(start:number)=>fit(start,{cargo:Array.from({length:7},(_,index)=>({typeId:start+index+1,quantity:1}))});
  const [one,two]=await Promise.all([a.quoteFits([dense(1)]),b.quoteFits([dense(20)])]);
  assert.equal(maximum,4);assert.equal(calls,16);assert.equal(one[0]!.complete,true);assert.equal(two[0]!.complete,true);
});

test("whole-batch deadline aborts active requests and does not start remaining types", async () => {
  let calls=0,aborts=0;
  const service=createFittingAdvicePriceService({deadlineMs:20,fetch:mockFetch((_id,_page,signal)=>new Promise((_resolve,reject)=>{calls++;signal.addEventListener("abort",()=>{aborts++;reject(new Error("secret-token-in-abort"));},{once:true});}))});
  const started=Date.now();
  const result=await service.quoteFits([fit(1,{cargo:Array.from({length:20},(_,index)=>({typeId:index+2,quantity:1}))})]);
  assert.ok(Date.now()-started<500);assert.equal(calls,4);assert.equal(aborts,4);missing(result[0]!);assert.equal(result[0]!.missingTypeIds.length,21);assert.ok(!JSON.stringify(result).includes("secret-token"));
  await pause(30);assert.equal(calls,4);
});

test("ESI 420/429 aborts the batch before dispatching the remaining type queue", async () => {
  for(const status of [420,429]){
    let calls=0;
    const service=createFittingAdvicePriceService({fetch:mockFetch(()=>{calls++;return new Response("private-market-rate-limit-body",{status,headers:{"Retry-After":"60"}});})});
    const result=await service.quoteFits([fit(1,{cargo:Array.from({length:79},(_,index)=>({typeId:index+2,quantity:1}))})]);
    missing(result[0]!);assert.equal(result[0]!.missingTypeIds.length,80);assert.ok(calls<=4);assert.ok(!JSON.stringify(result).includes("private-market-rate-limit-body"));await pause(10);assert.ok(calls<=4);
  }
});

test("cancelled queued batches promptly leave the global queue and never fetch later", async () => {
  const releases:Array<()=>void>=[],calls:number[]=[];
  const blocking=createFittingAdvicePriceService({fetch:mockFetch(id=>new Promise(resolve=>{calls.push(id);releases.push(()=>resolve(response([order(id)])));}))});
  const first=blocking.quoteFits([fit(1,{cargo:[{typeId:2,quantity:1},{typeId:3,quantity:1},{typeId:4,quantity:1}]})]);
  while(releases.length<4)await pause(1);
  const controller=new AbortController();
  const queued=createFittingAdvicePriceService({fetch:mockFetch(id=>{calls.push(id);return response([order(id)]);})});
  const second=queued.quoteFits([fit(99)],{signal:controller.signal});controller.abort();
  const result=await second;missing(result[0]!);assert.ok(!calls.includes(99));
  releases.forEach(release=>release());assert.equal((await first)[0]!.complete,true);
  await pause(20);assert.ok(!calls.includes(99));
});

test("deadline covers queued waiting and body streams, not only fetch headers", async () => {
  let cancelledBody=0;
  const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode("["));},cancel(){cancelledBody++;}});
  const service=createFittingAdvicePriceService({deadlineMs:15,fetch:mockFetch(()=>new Response(body,{headers:{"X-Pages":"1"}}))});
  const started=Date.now(),result=await service.quoteFits([fit()]);
  assert.ok(Date.now()-started<500);missing(result[0]!);assert.equal(cancelledBody,1);
  const releases:Array<()=>void>=[],seen:number[]=[];
  const blockers=createFittingAdvicePriceService({fetch:mockFetch(id=>new Promise(resolve=>{releases.push(()=>resolve(response([order(id)])));}))});
  const running=blockers.quoteFits([fit(1,{cargo:[{typeId:2,quantity:1},{typeId:3,quantity:1},{typeId:4,quantity:1}]})]);
  while(releases.length<4)await pause(1);
  const queued=createFittingAdvicePriceService({deadlineMs:15,fetch:mockFetch(id=>{seen.push(id);return response([order(id)]);})});
  missing((await queued.quoteFits([fit(99)]))[0]!);assert.deepEqual(seen,[]);
  releases.forEach(release=>release());await running;await pause(20);assert.deepEqual(seen,[]);
});

test("pre-aborted callers do no I/O and failed pagination is not cached as a partial quote", async () => {
  let calls=0,fail=true;
  const service=createFittingAdvicePriceService({fetch:mockFetch((id,page)=>{calls++;if(fail&&page===2)return new Response("private-secret",{status:503});return response([order(id,page===1?1:5)],fail?2:1);})});
  const controller=new AbortController();controller.abort();missing((await service.quoteFits([fit()],{signal:controller.signal}))[0]!);assert.equal(calls,0);
  missing((await service.quoteFits([fit()]))[0]!);assert.equal(calls,2);
  fail=false;const result=await service.quoteFits([fit()]);assert.equal(calls,3);assert.equal(result[0]!.complete,true);assert.equal(result[0]!.estimatedTotalIsk,1);
});

test("an injected fetch that ignores abort cannot extend the quote deadline or populate cache later", async () => {
  let calls=0;
  const service=createFittingAdvicePriceService({deadlineMs:10,fetch:mockFetch(async id=>{calls++;await pause(30);return response([order(id,calls===1?1:2)]);})});
  const first=await service.quoteFits([fit()]);missing(first[0]!);await pause(35);
  missing((await service.quoteFits([fit()]))[0]!);assert.equal(calls,2);
});
