import { query } from "../db.mjs";

try {
  const [row] = await query(`
    SELECT CURRENT_ACCOUNT() AS "account", CURRENT_USER() AS "user",
           CURRENT_DATABASE() AS "database", CURRENT_SCHEMA() AS "schema",
           CURRENT_WAREHOUSE() AS "warehouse"`);
  console.log(row);
  process.exit(0);
} catch (error) {
  console.error({
    message: error.message,
    code: error.code,
    sqlState: error.sqlState,
    cause: error.cause?.message,
    causeCode: error.cause?.code,
  });
  process.exit(1);
}
