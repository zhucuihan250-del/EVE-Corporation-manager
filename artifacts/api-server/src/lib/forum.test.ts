import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { forumAttachmentsTable, forumPostsTable, forumRepliesTable } from "@workspace/db/schema";
import { createForumFixture, forumActors } from "./forum-test-fixture";
import { FORUM_LIMITS, ForumError, forumStorageQuota, forumUpload } from "./forum-rules";

const actor = forumActors[2]!, peer = forumActors[3]!, admin = forumActors[1]!, foreign = forumActors[4]!;
const failure = (code: string) => (error: unknown) => error instanceof ForumError && error.code === code;
const postInput = { title: "舰队交流", body: "欢迎分享配装和截图", attachmentIds: [] };
const upload = (service: Awaited<ReturnType<typeof createForumFixture>>["service"], who = actor, text = "舰队装配笔记") => service.uploadAttachment(who, Buffer.from(text), "text/plain", encodeURIComponent("成员资料.txt"));

test("forum migration is additive, empty, rerunnable and preserves PAP/users and existing forum data", async () => {
  const f = await createForumFixture();
  try {
    assert.equal((await f.pg.query<{n:number}>("SELECT count(*)::integer n FROM forum_posts")).rows[0].n, 0);
    const post = (await f.service.createPost(actor, postInput)).post;
    await f.migrate(); await f.migrate();
    assert.equal((await f.service.getPost(actor, post.id)).post.body, postInput.body);
    assert.deepEqual((await f.pg.query<{redeemable_pap:number}>("SELECT id,redeemable_pap FROM users ORDER BY id")).rows.map(row => row.redeemable_pap), [7.5,7.5,7.5,7.5,7.5,7.5]);
  } finally { await f.close(); }
});

test("migration columns, nullability, indexes and checks match every Drizzle forum table", async () => {
  const f = await createForumFixture();
  try {
    for (const table of [forumPostsTable, forumRepliesTable, forumAttachmentsTable]) {
      const config = getTableConfig(table);
      const columns = (await f.pg.query<{ column_name: string; is_nullable: string }>("SELECT column_name,is_nullable FROM information_schema.columns WHERE table_name=$1 ORDER BY column_name", [config.name])).rows;
      assert.deepEqual(columns.map(row => [row.column_name,row.is_nullable]), config.columns.map(column => [column.name, column.notNull ? "NO" : "YES"]).sort((a,b) => a[0]!.localeCompare(b[0]!)));
      const indexes = (await f.pg.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename=$1", [config.name])).rows.map(row => row.indexname);
      for (const index of config.indexes) assert.ok(indexes.includes(index.config.name!));
      const checks = (await f.pg.query<{ conname: string }>("SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype='c'", [config.name])).rows.map(row => row.conname);
      for (const check of config.checks) assert.ok(checks.includes(check.name));
    }
    const post = (await f.service.createPost(actor, postInput)).post;
    await assert.rejects(f.pg.query("INSERT INTO forum_replies(corporation_id,post_id,author_name,body) VALUES(2002,$1,'x','cross-corporation')", [post.id]));
    await assert.rejects(f.pg.query("INSERT INTO forum_attachments(id,corporation_id,post_id,file_name,mime_type,size,data_base64) VALUES('11111111-1111-4111-8111-111111111111',2002,$1,'x.txt','text/plain',1,'eA==')", [post.id]));
  } finally { await f.close(); }
});

test("members publish text and attachment-only posts with immutable actor snapshots and bounded metadata", async () => {
  const f = await createForumFixture();
  try {
    const { attachment } = await upload(f.service);
    const { post } = await f.service.createPost(actor, { title: "截图资料", body: "", attachmentIds: [attachment.id], authorUserId: 1, authorName: "假管理员", corporationId: 2002, pinned: true });
    assert.deepEqual(post.author, { id: 2, name: "成员甲" }); assert.equal(post.pinned, false); assert.equal(post.locked, false);
    assert.equal(post.attachments[0]!.url, `/api/forum/attachments/${attachment.id}`);
    const json = JSON.stringify(post); assert.ok(!json.includes("dataBase64")); assert.ok(!json.includes(Buffer.from("舰队装配笔记").toString("base64")));
    await f.pg.query("DELETE FROM users WHERE id=2");
    const saved = (await f.service.getPost(peer, post.id)).post; assert.deepEqual(saved.author, { id: null, name: "成员甲" }); assert.equal(saved.canEdit, false);
    assert.equal((await f.service.getAttachment(peer, attachment.id)).bytes.toString(), "舰队装配笔记");
  } finally { await f.close(); }
});

test("post/reply ownership, role moderation, locks and stale versions are enforced in service", async () => {
  const f = await createForumFixture();
  try {
    const { post } = await f.service.createPost(actor, postInput), { reply } = await f.service.createReply(peer, post.id, { body: "回应" });
    for (const other of [peer, admin]) await assert.rejects(f.service.updatePost(other, post.id, postInput), failure("FORUM_FORBIDDEN"));
    for (const other of [actor, admin]) await assert.rejects(f.service.updateReply(other, reply.id, { body: "修改别人的回应" }), failure("FORUM_FORBIDDEN"));
    for (const other of [actor, forumActors[5]!]) await assert.rejects(f.service.moderatePost(other, post.id, { locked: true }), failure("FORUM_FORBIDDEN"));
    const revised = (await f.service.updatePost(actor, post.id, { ...postInput, version: 1 })).post; assert.equal(revised.version, 2);
    await assert.rejects(f.service.updatePost(actor, post.id, { ...postInput, version: 1 }), failure("FORUM_VERSION_CONFLICT"));
    await f.service.moderatePost(admin, post.id, { locked: true, pinned: true, version: 2 });
    await assert.rejects(f.service.updatePost(actor, post.id, postInput), failure("FORUM_POST_LOCKED"));
    await assert.rejects(f.service.createReply(admin, post.id, { body: "管理员也不能绕过锁帖" }), failure("FORUM_POST_LOCKED"));
    await assert.rejects(f.service.updateReply(peer, reply.id, { body: "锁定回应" }), failure("FORUM_POST_LOCKED"));
    const locked = await f.service.getPost(actor, post.id); assert.equal(locked.post.canEdit, false); assert.equal(locked.post.canDelete, true); assert.equal(locked.replies[0]!.canEdit, false);
    await f.service.deleteReply(peer, reply.id); assert.equal((await f.service.getPost(actor, post.id)).replyTotal, 0);
    await f.service.moderatePost(forumActors[6]!, post.id, { locked: false }); await f.service.updatePost(actor, post.id, postInput);
    await assert.rejects(f.service.deletePost(peer, post.id), failure("FORUM_FORBIDDEN")); await f.service.deletePost(admin, post.id);
    await assert.rejects(f.service.getPost(actor, post.id), failure("FORUM_NOT_FOUND"));
  } finally { await f.close(); }
});

test("all lookup/claim/update/delete surfaces isolate corporations and hide parent-deleted attachments/replies", async () => {
  const f = await createForumFixture();
  try {
    const { attachment } = await upload(f.service), { post } = await f.service.createPost(actor, { ...postInput, attachmentIds: [attachment.id] }), { reply } = await f.service.createReply(peer, post.id, { body: "回复" });
    assert.equal((await f.service.listPosts(foreign)).total, 0);
    for (const attempt of [() => f.service.getPost(foreign, post.id), () => f.service.getAttachment(foreign, attachment.id), () => f.service.updatePost(foreign, post.id, postInput), () => f.service.deletePost(foreign, post.id), () => f.service.moderatePost(foreign, post.id, { pinned: true }), () => f.service.createReply(foreign, post.id, { body: "入侵" }), () => f.service.updateReply(foreign, reply.id, { body: "入侵" }), () => f.service.deleteReply(foreign, reply.id)]) await assert.rejects(attempt(), failure("FORUM_NOT_FOUND"));
    await f.service.deletePost(actor, post.id);
    await assert.rejects(f.service.getAttachment(peer, attachment.id), failure("FORUM_NOT_FOUND")); await assert.rejects(f.service.updateReply(peer, reply.id, { body: "已删除帖子不能编辑" }), failure("FORUM_NOT_FOUND"));
    assert.equal((await f.service.listPosts(peer)).total, 0);
    const blob = (await f.pg.query<{data_base64:string|null;deleted_at:Date|null}>("SELECT data_base64,deleted_at FROM forum_attachments WHERE id=$1", [attachment.id])).rows[0]; assert.equal(blob.data_base64, null); assert.ok(blob.deleted_at);
  } finally { await f.close(); }
});

test("draft claim is atomic, rejects cross-owner/corporation, duplicate/reused/expired IDs and leaves no partial post", async () => {
  const f = await createForumFixture();
  try {
    const { attachment } = await upload(f.service), theirs = (await upload(f.service, peer)).attachment;
    for (const [who, ids, code] of [[actor,[attachment.id,theirs.id],"FORUM_ATTACHMENT_NOT_FOUND"],[peer,[attachment.id],"FORUM_ATTACHMENT_NOT_FOUND"],[foreign,[attachment.id],"FORUM_ATTACHMENT_NOT_FOUND"],[actor,[attachment.id,attachment.id],"FORUM_INVALID_ATTACHMENT"]] as const) await assert.rejects(f.service.createPost(who, { ...postInput, attachmentIds: ids }), failure(code));
    assert.equal((await f.service.listPosts(actor)).total, 0);
    await assert.rejects(f.service.getAttachment(peer, attachment.id), failure("FORUM_NOT_FOUND")); await assert.rejects(f.service.deleteDraftAttachment(peer, attachment.id), failure("FORUM_NOT_FOUND"));
    const { post } = await f.service.createPost(actor, { ...postInput, attachmentIds: [attachment.id] });
    await assert.rejects(f.service.createPost(actor, { ...postInput, attachmentIds: [attachment.id] }), failure("FORUM_ATTACHMENT_NOT_FOUND")); await assert.rejects(f.service.deleteDraftAttachment(actor, attachment.id), failure("FORUM_NOT_FOUND"));
    const expired = (await upload(f.service)).attachment; await f.pg.query("UPDATE forum_attachments SET created_at=now()-interval '25 hours' WHERE id=$1", [expired.id]);
    await assert.rejects(f.service.createPost(actor, { ...postInput, attachmentIds: [expired.id] }), failure("FORUM_ATTACHMENT_NOT_FOUND")); await assert.rejects(f.service.getAttachment(actor, expired.id), failure("FORUM_NOT_FOUND"));
    await upload(f.service); assert.equal((await f.pg.query<{data_base64:string|null}>("SELECT data_base64 FROM forum_attachments WHERE id=$1", [expired.id])).rows[0].data_base64, null);
    assert.equal((await f.service.getAttachment(peer, attachment.id)).bytes.toString(), "舰队装配笔记"); assert.equal((await f.service.getPost(peer, post.id)).post.attachments.length, 1);
    await f.service.deleteDraftAttachment(peer, theirs.id); await assert.rejects(f.service.getAttachment(peer, theirs.id), failure("FORUM_NOT_FOUND"));
  } finally { await f.close(); }
});

test("listing is pinned-first, search treats wildcard characters literally and pagination is bounded", async () => {
  const f = await createForumFixture();
  try {
    const special = (await f.service.createPost(actor, { ...postInput, title: "100%_胜率\\配装" })).post;
    for (let index = 0; index < 22; index++) await f.service.createPost(actor, { ...postInput, title: `讨论 ${index}` });
    await f.service.moderatePost(admin, special.id, { pinned: true });
    const first = await f.service.listPosts(peer), second = await f.service.listPosts(peer, { page: "2" });
    assert.equal(first.total, 23); assert.equal(first.posts.length, 20); assert.equal(second.posts.length, 3); assert.equal(first.posts[0]!.id, special.id);
    assert.equal((await f.service.listPosts(peer, { query: "%_" })).total, 1); assert.equal((await f.service.listPosts(peer, { query: "\\" })).total, 1);
    for (const page of [0,-1,1.5,"1x","10001",[1]]) await assert.rejects(f.service.listPosts(peer, { page }), error => error instanceof ForumError && error.status === 400);
    await assert.rejects(f.service.listPosts(peer, { query: "x".repeat(101) }), failure("FORUM_INVALID_SEARCH"));
    await f.pg.query("INSERT INTO forum_replies(corporation_id,post_id,author_user_id,author_name,body) SELECT 1001,$1,3,'成员乙','批量回应' FROM generate_series(1,51)", [special.id]);
    assert.equal((await f.service.getPost(actor, special.id)).replies.length, 50); const replies = await f.service.getPost(actor, special.id, { replyPage: "2" }); assert.equal(replies.replyTotal, 51); assert.equal(replies.replies.length, 1); assert.equal(replies.post.replyCount, 51);
  } finally { await f.close(); }
});

test("text boundaries preserve plain malicious markup as inert text, prevent NUL and oversized inputs", async () => {
  const f = await createForumFixture();
  try {
    const text = '<script>alert("fixture")</script> <img src=x onerror=alert(1)>', { post } = await f.service.createPost(actor, { title: "纯文本", body: text }); assert.equal(post.body, text);
    for (const input of [{title:"x".repeat(151),body:"ok"},{title:"ok",body:"x".repeat(20001)},{title:"ok\nnotitle",body:"ok"},{title:"ok",body:"a\0b"},{title:"ok",body:""}]) await assert.rejects(f.service.createPost(actor, input), error => error instanceof ForumError && error.status === 400);
    const maximum = (await f.service.createPost(actor, { title: "x".repeat(150), body: "中".repeat(20000) })).post; assert.equal(maximum.body.length, 20000);
    const files = await Promise.all(Array.from({length:7}, () => upload(f.service)));
    await assert.rejects(f.service.createPost(actor, { title: "超附件", body: "", attachmentIds: files.map(file => file.attachment.id) }), failure("FORUM_ATTACHMENT_LIMIT"));
  } finally { await f.close(); }
});

test("storage quota byte and object limits include exact boundary, pending attachments and FK-compatible transaction locks", async () => {
  const zero = { corporation: 0, user: 0, draft: 0, corporationCount: 0, userCount: 0, draftCount: 0 };
  for (const [field,max,code] of [["draft",FORUM_LIMITS.draftBytesMax,"FORUM_USER_STORAGE_LIMIT"],["user",FORUM_LIMITS.userBytesMax,"FORUM_USER_STORAGE_LIMIT"],["corporation",FORUM_LIMITS.corporationBytesMax,"FORUM_CORPORATION_STORAGE_LIMIT"]] as const) {
    assert.doesNotThrow(() => forumStorageQuota({...zero,[field]:max-1},1)); assert.throws(() => forumStorageQuota({...zero,[field]:max},1), failure(code));
  }
  assert.throws(() => forumStorageQuota({...zero,userCount:1000},1), failure("FORUM_USER_STORAGE_LIMIT")); assert.throws(() => forumStorageQuota({...zero,corporationCount:20000},1), failure("FORUM_CORPORATION_STORAGE_LIMIT"));
  const queries: string[] = [], f = await createForumFixture({logQuery:query=>queries.push(query)});
  try {
    const files = []; for(let index=0;index<24;index++) files.push((await upload(f.service)).attachment);
    await assert.rejects(upload(f.service), failure("FORUM_USER_STORAGE_LIMIT"));
    await f.service.createPost(actor, {...postInput,attachmentIds:files.slice(0,6).map(file=>file.id)}); await upload(f.service);
    const locks = queries.filter(query=>/for (?:no key )?update/i.test(query)); assert.ok(locks.length>=26); assert.ok(locks.every(query=>query.includes('from "corporations"') && /for no key update/i.test(query)));
    // PGlite checks SQL and limits, not real multi-session PostgreSQL contention.
  } finally { await f.close(); }
});

test("file validation rejects spoofed types, controls/path/HTML/SVG, truncated JPEG and image dimension bombs without unexpected throws", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  assert.equal(forumUpload(png,"image/png",encodeURIComponent("舰船截图.html")).fileName,"舰船截图.png");
  assert.equal(forumUpload(Buffer.from("[Tengu, Fleet]\nHeavy Missile Launcher II"),"text/plain","fit.txt").mimeType,"text/plain");
  assert.equal(forumUpload(Buffer.from("%PDF-2.0\n1 0 obj <<>> endobj\n%%EOF"),"application/pdf","doc.pdf").mimeType,"application/pdf");
  for (const [bytes,mime,name] of [[Buffer.from("<svg onload=alert(1)></svg>"),"image/svg+xml","a.svg"],[Buffer.from("<html>attack</html>"),"text/plain","a.txt"],[Buffer.from([0xff,0xfe]),"text/plain","a.txt"],[Buffer.from("a\0b"),"text/plain","a.txt"],[Buffer.from("hello"),"image/png","a.png"],[png,"image/png","..%2Fa.png"],[png,"image/png","a%0Ab.png"],[png,"image/png","%FF"],[Buffer.alloc(0),"text/plain","empty.txt"],[Buffer.alloc(5242881),"text/plain","large.txt"],[Buffer.from("%PDF-1.7 /J#53 (evil)\n%%EOF"),"application/pdf","a.pdf"]] as const) assert.throws(()=>forumUpload(bytes,mime,name),error=>error instanceof ForumError);
  const bomb=Buffer.from(png); bomb.writeUInt32BE(10000,16);bomb.writeUInt32BE(10000,20); assert.throws(()=>forumUpload(bomb,"image/png","bomb.png"),failure("FORUM_INVALID_FILE_CONTENT"));
  for(let length=12;length<80;length++){ const broken=Buffer.alloc(length,0xff);broken[0]=0xff;broken[1]=0xd8;broken[length-2]=0xff;broken[length-1]=0xd9;assert.throws(()=>forumUpload(broken,"image/jpeg","bad.jpg"),error=>error instanceof ForumError && error.status===400); }
  for(let length=1;length<45;length++)assert.throws(()=>forumUpload(png.subarray(0,length),"image/png","short.png"),error=>error instanceof ForumError);
});

test("real small JPEG, GIF and WebP images are accepted while malformed WebP chunks and dimensions are rejected",()=>{
  // JPEG/WebP generated from a real browser 1px canvas; optional ICC profile
  // chunks removed so fixtures remain short and reproducible.
  const jpeg=Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABwj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwC4AKAH7//Z","base64");
  const gif=Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7","base64");
  const webp=Buffer.from("UklGRkgAAABXRUJQVlA4WAoAAAAAAAAAAAAAAAAAVlA4ICoAAACQAQCdASoBAAEAAUAmJaACdLoAA5gA/vAM//89M/QL7A+xn+LaR0KTwAA=","base64");
  for(const [bytes,mime,name] of [[jpeg,"image/jpeg","one.jpeg"],[gif,"image/gif","one.gif"],[webp,"image/webp","one.webp"]] as const)assert.equal(forumUpload(bytes,mime,name).mimeType,mime);
  const bomb=Buffer.from(webp);bomb.writeUIntLE(10000,24,3);bomb.writeUIntLE(10000,27,3);assert.throws(()=>forumUpload(bomb,"image/webp","bomb.webp"),failure("FORUM_INVALID_FILE_CONTENT"));
  const truncated=Buffer.from(webp);truncated.writeUInt32LE(200,16);assert.throws(()=>forumUpload(truncated,"image/webp","broken.webp"),failure("FORUM_INVALID_FILE_CONTENT"));
});
