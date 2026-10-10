import type { PoolClient } from "pg";

/** Keep membership evidence separate from manual unlink retention. Existing
 * records start unknown: only a successful ESI check may start a departure
 * window. Identity history survives character deletion without losing its
 * corporation boundary or its applicant snapshot. No account/PAP rows are
 * removed and no retention deadline is backdated by this migration. */
export const characterMembershipRetentionMigration = {
  id: "0035_character_membership_retention",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE characters
        ADD COLUMN IF NOT EXISTS membership_status text NOT NULL DEFAULT 'unknown',
        ADD COLUMN IF NOT EXISTS membership_checked_at timestamptz,
        ADD COLUMN IF NOT EXISTS corporation_left_at timestamptz,
        ADD COLUMN IF NOT EXISTS actual_corporation_id integer,
        ADD COLUMN IF NOT EXISTS retention_corporation_id integer REFERENCES corporations(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS membership_retained_until timestamptz;
      ALTER TABLE characters ADD CONSTRAINT characters_membership_status_valid
        CHECK (membership_status IN ('unknown', 'member', 'departed'));
      CREATE INDEX IF NOT EXISTS characters_membership_retention_due_idx
        ON characters(retention_corporation_id,membership_retained_until,id)
        WHERE membership_status = 'departed' AND membership_retained_until IS NOT NULL;

      ALTER TABLE identity_group_applications
        ALTER COLUMN character_id DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS applicant_character_name_snapshot text,
        ADD COLUMN IF NOT EXISTS applicant_eve_character_id_snapshot integer;
      UPDATE identity_group_applications a SET
        applicant_character_name_snapshot = COALESCE(a.applicant_character_name_snapshot,c.eve_character_name),
        applicant_eve_character_id_snapshot = COALESCE(a.applicant_eve_character_id_snapshot,c.eve_character_id)
      FROM characters c WHERE c.id = a.character_id
        AND (a.applicant_character_name_snapshot IS NULL OR a.applicant_eve_character_id_snapshot IS NULL);

      ALTER TABLE identity_group_applications
        DROP CONSTRAINT identity_group_applications_character_id_fkey,
        DROP CONSTRAINT identity_group_applications_corporation_character_fk;
      ALTER TABLE identity_group_applications
        ADD CONSTRAINT identity_group_applications_character_id_fkey
          FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE SET NULL,
        ADD CONSTRAINT identity_group_applications_corporation_character_fk
          FOREIGN KEY(corporation_id,character_id) REFERENCES characters(corporation_id,id)
          ON DELETE SET NULL(character_id);
      ALTER TABLE identity_group_memberships
        DROP CONSTRAINT identity_group_memberships_corporation_character_fk;
      ALTER TABLE identity_group_memberships
        ADD CONSTRAINT identity_group_memberships_corporation_character_fk
          FOREIGN KEY(corporation_id,character_id) REFERENCES characters(corporation_id,id)
          ON DELETE SET NULL(character_id);
    `);
  },
};
