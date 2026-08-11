import "dotenv/config";
import snowflake from "snowflake-sdk";

const required = ["SNOWFLAKE_ACCOUNT"];
let connectionPromise;

export function missingConfiguration() {
  return required.filter((name) => !process.env[name]);
}

function connectionOptions() {
  const proxyValue = process.env.HTTPS_PROXY || process.env.https_proxy;
  const options = {
    account: process.env.SNOWFLAKE_ACCOUNT,
    username: process.env.SNOWFLAKE_USERNAME || "seohyunho",
    warehouse: process.env.SNOWFLAKE_WAREHOUSE,
    database: process.env.SNOWFLAKE_DATABASE || "MEMBER",
    schema: process.env.SNOWFLAKE_SCHEMA || "PUBLIC",
    role: process.env.SNOWFLAKE_ROLE || undefined,
    authenticator: process.env.SNOWFLAKE_AUTHENTICATOR || "SNOWFLAKE",
    application: "MOA_BOARD",
    clientSessionKeepAlive: true,
    timeout: 20000,
    retryTimeout: 0,
  };
  if (proxyValue) {
    const proxy = new URL(proxyValue);
    options.proxyHost = proxy.hostname;
    options.proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
    options.proxyProtocol = proxy.protocol.replace(":", "");
  }
  if (process.env.SNOWFLAKE_PASSWORD) options.password = process.env.SNOWFLAKE_PASSWORD;
  if (process.env.SNOWFLAKE_PRIVATE_KEY_PATH) options.privateKeyPath = process.env.SNOWFLAKE_PRIVATE_KEY_PATH;
  if (process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE) options.privateKeyPass = process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE;
  return options;
}

export async function getConnection() {
  const missing = missingConfiguration();
  if (missing.length) throw new Error(`Snowflake 환경변수가 필요합니다: ${missing.join(", ")}`);
  if (!connectionPromise) {
    connectionPromise = new Promise((resolve, reject) => {
      const connection = snowflake.createConnection(connectionOptions());
      connection.connect((error, connected) => {
        if (error) {
          connectionPromise = undefined;
          const wrapped = new Error(`Snowflake 연결 실패: ${error.message}`, { cause: error });
          wrapped.code = error.code;
          wrapped.sqlState = error.sqlState;
          reject(wrapped);
        } else {
          resolve(connected);
        }
      });
    });
  }
  return connectionPromise;
}

export async function query(sqlText, binds = [], options = {}) {
  const connection = await getConnection();
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      ...options,
      complete(error, statement, rows) {
        if (error) reject(new Error(`Snowflake 쿼리 실패: ${error.message}`));
        else resolve(rows || []);
      },
    });
  });
}

export async function transaction(work) {
  await query("BEGIN");
  try {
    const result = await work();
    await query("COMMIT");
    return result;
  } catch (error) {
    await query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export const schemaStatements = [
  "CREATE SEQUENCE IF NOT EXISTS MEMBER.PUBLIC.BOARD_POST_ID_SEQ START = 1 INCREMENT = 1",
  `CREATE TABLE IF NOT EXISTS MEMBER.PUBLIC.BOARD_POSTS (
    POST_ID NUMBER(38, 0) NOT NULL DEFAULT MEMBER.PUBLIC.BOARD_POST_ID_SEQ.NEXTVAL,
    TITLE VARCHAR(80) NOT NULL,
    CONTENT VARCHAR(3000) NOT NULL,
    CREATED_AT TIMESTAMP_TZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    UPDATED_AT TIMESTAMP_TZ,
    CONSTRAINT PK_BOARD_POSTS PRIMARY KEY (POST_ID)
  )`,
  `CREATE TABLE IF NOT EXISTS MEMBER.PUBLIC.BOARD_ATTACHMENTS (
    ATTACHMENT_ID NUMBER(38, 0) AUTOINCREMENT START 1 INCREMENT 1,
    POST_ID NUMBER(38, 0) NOT NULL,
    FILE_NAME VARCHAR(500) NOT NULL,
    CONTENT_TYPE VARCHAR(255) NOT NULL,
    FILE_SIZE NUMBER(38, 0) NOT NULL,
    FILE_DATA BINARY(10485760) NOT NULL,
    CREATED_AT TIMESTAMP_TZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT PK_BOARD_ATTACHMENTS PRIMARY KEY (ATTACHMENT_ID),
    CONSTRAINT FK_BOARD_ATTACHMENTS_POST FOREIGN KEY (POST_ID)
      REFERENCES MEMBER.PUBLIC.BOARD_POSTS (POST_ID)
  )`,
];

export async function initializeSchema() {
  for (const statement of schemaStatements) await query(statement);
}
