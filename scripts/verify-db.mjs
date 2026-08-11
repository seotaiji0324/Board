import { query } from "../db.mjs";

try {
  const tables = await query(`
    SELECT TABLE_NAME AS "name"
    FROM MEMBER.INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'PUBLIC'
      AND TABLE_NAME IN ('BOARD_POSTS', 'BOARD_ATTACHMENTS')
    ORDER BY TABLE_NAME`);
  const sequences = await query(`
    SELECT SEQUENCE_NAME AS "name"
    FROM MEMBER.INFORMATION_SCHEMA.SEQUENCES
    WHERE SEQUENCE_SCHEMA = 'PUBLIC'
      AND SEQUENCE_NAME = 'BOARD_POST_ID_SEQ'`);
  const [postCount] = await query(`SELECT COUNT(*) AS "posts" FROM MEMBER.PUBLIC.BOARD_POSTS`);
  console.log({ tables: tables.map((row) => row.name), sequences: sequences.map((row) => row.name), posts: postCount.posts });
  process.exit(0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
