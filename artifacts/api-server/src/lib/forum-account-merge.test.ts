import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { memberForumMigration } from "../../../../lib/db/src/migrations/0034-member-forum";
import { mergeForumAccounts } from "./forum-account-merge";

test("account linking preserves forum ownership and author snapshots without moving foreign-corporation records", async () => {
  const pg = new PGlite();
  try {
    await pg.exec("CREATE TABLE corporations (id integer PRIMARY KEY); CREATE TABLE users (id integer PRIMARY KEY); INSERT INTO corporations VALUES (1001),(2002); INSERT INTO users VALUES(1),(2);");
    await memberForumMigration.up({ query: (text: string) => pg.exec(text) } as unknown as Parameters<typeof memberForumMigration.up>[0]);
    await pg.exec(`
      INSERT INTO forum_posts (id,corporation_id,author_user_id,author_name,title,body) VALUES
        (1,1001,1,'原角色','本军团帖子','正文'),(2,2002,1,'历史角色','历史军团帖子','历史正文');
      INSERT INTO forum_replies (corporation_id,post_id,author_user_id,author_name,body) VALUES (1001,1,1,'原角色','回复');
      INSERT INTO forum_attachments (id,corporation_id,owner_user_id,post_id,file_name,mime_type,size,data_base64) VALUES
        ('00000000-0000-4000-8000-000000000001',1001,1,1,'公开.txt','text/plain',1,'YQ=='),
        ('00000000-0000-4000-8000-000000000002',1001,1,NULL,'草稿.txt','text/plain',1,'Yg=='),
        ('00000000-0000-4000-8000-000000000003',2002,1,2,'历史.txt','text/plain',1,'Yw==');
    `);
    const database = drizzle(pg);
    await database.transaction(tx => mergeForumAccounts(tx as unknown as Parameters<typeof mergeForumAccounts>[0], 1001, 1, 2));
    const posts = (await pg.query("SELECT corporation_id,author_user_id,author_name,version FROM forum_posts ORDER BY id")).rows;
    assert.deepEqual(posts, [
      { corporation_id: 1001, author_user_id: 2, author_name: "原角色", version: 1 },
      { corporation_id: 2002, author_user_id: 1, author_name: "历史角色", version: 1 },
    ]);
    assert.deepEqual((await pg.query("SELECT author_user_id,author_name FROM forum_replies")).rows, [{ author_user_id: 2, author_name: "原角色" }]);
    assert.deepEqual((await pg.query("SELECT owner_user_id FROM forum_attachments ORDER BY id")).rows, [{ owner_user_id: 2 }, { owner_user_id: 2 }, { owner_user_id: 1 }]);
    await pg.exec("DELETE FROM users WHERE id=1");
    assert.equal((await pg.query("SELECT data_base64 FROM forum_attachments WHERE corporation_id=1001")).rows.length, 2);
    assert.equal((await pg.query<{ author_user_id: number }>("SELECT author_user_id FROM forum_posts WHERE corporation_id=1001")).rows[0]!.author_user_id, 2);
    await assert.rejects(database.transaction(tx => mergeForumAccounts(tx as unknown as Parameters<typeof mergeForumAccounts>[0], 1001, 2, 2)), /itself/);
  } finally { await pg.close(); }
});

test("forum account transfer rolls back with the surrounding link transaction", async () => {
  const pg = new PGlite();
  try {
    await pg.exec("CREATE TABLE corporations (id integer PRIMARY KEY); CREATE TABLE users (id integer PRIMARY KEY); INSERT INTO corporations VALUES (1001); INSERT INTO users VALUES(1),(2);");
    await memberForumMigration.up({ query: (text: string) => pg.exec(text) } as unknown as Parameters<typeof memberForumMigration.up>[0]);
    await pg.exec("INSERT INTO forum_posts(corporation_id,author_user_id,author_name,title,body) VALUES (1001,1,'角色','标题','正文')");
    await assert.rejects(drizzle(pg).transaction(async tx => {
      await mergeForumAccounts(tx as unknown as Parameters<typeof mergeForumAccounts>[0], 1001, 1, 2);
      throw new Error("Later linking step failed");
    }));
    assert.equal((await pg.query<{ author_user_id: number }>("SELECT author_user_id FROM forum_posts")).rows[0]!.author_user_id, 1);
  } finally { await pg.close(); }
});
