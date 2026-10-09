import assert from "node:assert/strict";
import test from "node:test";
import { createForumFixture } from "./forum-test-fixture";

test("HTTP forum requires authentication and validated tenant before raw parsing on every endpoint", async()=>{
  const f=await createForumFixture();
  try{
    for(const [path,method,body] of [["/posts","GET",undefined],["/posts/1","GET",undefined],["/posts","POST",{}],["/posts/1","PATCH",{}],["/posts/1","DELETE",undefined],["/posts/1/moderation","PATCH",{}],["/posts/1/replies","POST",{}],["/replies/1","PATCH",{}],["/replies/1","DELETE",undefined],["/attachments","POST",Buffer.from("upload")],["/attachments/11111111-1111-4111-8111-111111111111","GET",undefined],["/attachments/11111111-1111-4111-8111-111111111111/download","GET",undefined],["/attachments/11111111-1111-4111-8111-111111111111","DELETE",undefined]] as const){
      assert.equal((await f.request(path,0,method,body)).status,401); assert.equal((await f.request(path,2,method,body,{"x-test-tenant-invalid":"true"})).status,403);
    }
    assert.equal((await f.request("/attachments",0,"POST",Buffer.alloc(5242881))).status,401);
    assert.equal((await f.request("/posts",2)).status,200);
  }finally{await f.close();}
});

test("HTTP post, reply, attachment workflow derives actor from context and serves only safe bounded files",async()=>{
  const f=await createForumFixture();
  try{
    const bytes=Buffer.from("成员上传的配装内容");
    const upload=await f.request("/attachments",2,"POST",bytes,{"x-file-name":encodeURIComponent("甲的'舰船(资料).txt")}); assert.equal(upload.status,201); const {attachment}=await upload.json() as {attachment:{id:string;fileName:string}};
    assert.equal((await f.request(`/attachments/${attachment.id}`,3)).status,404); assert.equal((await f.request(`/attachments/${attachment.id}`,4)).status,404);
    const publish=await f.request("/posts",2,"POST",{title:"成员贴吧",body:"",attachmentIds:[attachment.id],authorUserId:1,corporationId:2002}); assert.equal(publish.status,201);const {post}=await publish.json() as {post:{id:number;author:{id:number;name:string};version:number}};
    assert.deepEqual(post.author,{id:2,name:"成员甲"});
    const file=await f.request(`/attachments/${attachment.id}`,3);assert.equal(file.status,200);assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes);assert.equal(file.headers.get("x-content-type-options"),"nosniff");assert.equal(file.headers.get("cache-control"),"private, no-store");assert.ok(file.headers.get("content-security-policy")?.includes("sandbox"));assert.ok(file.headers.get("content-disposition")?.startsWith("attachment;"));assert.ok(file.headers.get("content-disposition")?.includes("%27"));assert.ok(!file.headers.get("content-disposition")?.includes("filename=\"甲"));
    assert.equal((await f.request(`/posts/${post.id}`,3,"PATCH",{title:"x",body:"y"})).status,403);assert.equal((await f.request(`/posts/${post.id}/moderation`,5,"PATCH",{locked:true})).status,403);
    assert.equal((await f.request(`/posts/${post.id}/replies`,3,"POST",{body:"回应",authorUserId:1})).status,201);
    const detail=await(await f.request(`/posts/${post.id}`)).json() as {post:{replyCount:number};replies:{id:number;author:{id:number}}[];replyPage:number};assert.equal(detail.post.replyCount,1);assert.equal(detail.replies[0]!.author.id,3);assert.equal(detail.replyPage,1);
    assert.equal((await f.request(`/posts/${post.id}/moderation`,1,"PATCH",{locked:true,pinned:true,version:post.version})).status,200);assert.equal((await f.request(`/posts/${post.id}/replies`,2,"POST",{body:"锁定不能回"})).status,409);
    assert.equal((await f.request(`/posts/${post.id}`,2,"DELETE")).status,200);assert.equal((await f.request(`/attachments/${attachment.id}/download`,3)).status,404);assert.equal((await f.request(`/replies/${detail.replies[0]!.id}`,3,"PATCH",{body:"deleted parent"})).status,404);
  }finally{await f.close();}
});

test("HTTP image previews are inline but downloads always force attachment, including surrogate-boundary filenames",async()=>{
  const f=await createForumFixture();
  try{
    const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64");
    const response=await f.request("/attachments",2,"POST",png,{"content-type":"image/png","x-file-name":encodeURIComponent("截图.html")});assert.equal(response.status,201);const {attachment}=await response.json() as {attachment:{id:string}};
    const preview=await f.request(`/attachments/${attachment.id}`);assert.equal(preview.status,200);assert.ok(preview.headers.get("content-disposition")?.startsWith("inline;"));assert.equal(preview.headers.get("content-type"),"image/png");
    const download=await f.request(`/attachments/${attachment.id}/download`);assert.ok(download.headers.get("content-disposition")?.startsWith("attachment;"));
    const unicode=await f.request("/attachments",2,"POST",Buffer.from("a"),{"x-file-name":encodeURIComponent("a".repeat(175)+"😀.x")});assert.equal(unicode.status,201);const id=(await unicode.json() as {attachment:{id:string}}).attachment.id;assert.equal((await f.request(`/attachments/${id}`)).status,200);
  }finally{await f.close();}
});

test("HTTP invalid paths/body/encoding/oversized uploads produce safe JSON without stack or submitted data",async()=>{
  const f=await createForumFixture();
  try{
    for(const id of ["0","-1","1x","1.5","2147483648"]){assert.equal((await f.request(`/posts/${id}`)).status,400);assert.equal((await f.request(`/replies/${id}`,2,"DELETE")).status,400);}
    assert.equal((await f.request("/attachments/not-a-uuid")).status,400);
    const oversized=await f.request("/attachments",2,"POST",Buffer.alloc(5242881));assert.equal(oversized.status,413);assert.equal((await oversized.json() as {code:string}).code,"FORUM_PAYLOAD_LIMIT");
    const unsupported=await f.request("/attachments",3,"POST",Buffer.from("<html>DO_NOT_LEAK_UPLOAD_CONTENT</html>"),{"content-type":"text/html"});assert.equal(unsupported.status,415);assert.ok(!(await unsupported.text()).includes("DO_NOT_LEAK_UPLOAD_CONTENT"));
    const compressed=await f.request("/attachments",3,"POST",Buffer.from("not_gzip"),{"content-encoding":"gzip"});assert.equal(compressed.status,415);
    const malformed=await fetch(`${f.origin}/api/forum/posts`,{method:"POST",headers:{"x-test-user":"2","content-type":"application/json"},body:'{"title":"DO_NOT_LEAK_JSON_BODY",'});assert.equal(malformed.status,400);const error=await malformed.text();assert.ok(error.includes("FORUM_INVALID_INPUT"));assert.ok(!error.includes("DO_NOT_LEAK_JSON_BODY"));assert.ok(!error.includes("SyntaxError"));
    assert.equal((await f.request("/posts",3,"POST",{title:"x",body:"x".repeat(110000)})).status,413);
  }finally{await f.close();}
});

test("HTTP read/write/upload rate windows are separately scoped and return Retry-After",async()=>{
  const f=await createForumFixture();
  try{
    for(let index=0;index<120;index++)assert.equal((await f.request("/posts")).status,200);
    const throttled=await f.request("/posts");assert.equal(throttled.status,429);assert.equal(throttled.headers.get("retry-after"),"60");assert.equal((await f.request("/posts",3)).status,200);
    for(let index=0;index<30;index++)assert.equal((await f.request("/posts",2,"POST",{title:`测试${index}`,body:"内容"})).status,201);assert.equal((await f.request("/posts",2,"POST",{title:"上限",body:"内容"})).status,429);
    for(let index=0;index<12;index++)assert.equal((await f.request("/attachments",2,"POST",Buffer.from("a"))).status,201);assert.equal((await f.request("/attachments",2,"POST",Buffer.from("a"))).status,429);assert.equal((await f.request("/attachments",3,"POST",Buffer.from("a"))).status,201);
  }finally{await f.close();}
});

test("unexpected database failures remain generic and never expose SQL or connection details",async()=>{
  const f=await createForumFixture();
  try{
    await f.pg.exec("DROP TABLE forum_replies"); const response=await f.request("/posts",2,"POST",{title:"test",body:"x"});assert.equal(response.status,503);const body=await response.text();assert.deepEqual(JSON.parse(body),{error:"贴吧暂时不可用，请稍后重试。",code:"FORUM_UNAVAILABLE"});assert.ok(!body.includes("forum_replies"));
  }finally{await f.close();}
});
