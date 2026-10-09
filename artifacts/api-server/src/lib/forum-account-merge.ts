import type { db } from "@workspace/db";
import { forumAttachmentsTable, forumPostsTable, forumRepliesTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The surrounding SSO account-link transaction has already verified both
 * accounts belong to this corporation and locked them through mergePapWallets.
 * Preserve original character-name snapshots while moving account ownership. */
export async function mergeForumAccounts(tx: Transaction, corporationId: number, sourceUserId: number, destinationUserId: number): Promise<void> {
  if (sourceUserId === destinationUserId) throw new Error("Cannot merge an account into itself");
  await tx.update(forumPostsTable).set({ authorUserId: destinationUserId }).where(and(
    eq(forumPostsTable.corporationId, corporationId), eq(forumPostsTable.authorUserId, sourceUserId),
  ));
  await tx.update(forumRepliesTable).set({ authorUserId: destinationUserId }).where(and(
    eq(forumRepliesTable.corporationId, corporationId), eq(forumRepliesTable.authorUserId, sourceUserId),
  ));
  await tx.update(forumAttachmentsTable).set({ ownerUserId: destinationUserId }).where(and(
    eq(forumAttachmentsTable.corporationId, corporationId), eq(forumAttachmentsTable.ownerUserId, sourceUserId),
  ));
}
