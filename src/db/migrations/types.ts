/**
 * Migration type definition.
 *
 * Each migration has a version number, a name, and optional SQL for
 * different backends. The `sql` field is the generic SQL used when no
 * dialect-specific override is provided.
 */
export interface Migration {
  version: number;
  name: string;
  sql?: string;
  postgresSql?: string;
  sqliteSql?: string;
}
