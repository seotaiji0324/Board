import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import snowflake from "snowflake-sdk";
import { randomInt } from "node:crypto";
import runtimeConfig from "./runtime-config.json" with { type: "json" };

const allowedOrigin = "https://seotaiji0324.github.io";
let connectionPromise: Promise<any> | undefined;

function headers(request: Request) {
  const origin = request.headers.get("origin");
  return {
    "Content-Type": "application/json; charset=utf-8",
    ...(origin === allowedOrigin ? {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    } : {}),
  };
}

function json(request: Request, value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: headers(request) });
}

const configKey: Record<string, keyof typeof runtimeConfig> = {
  SNOWFLAKE_ACCOUNT: "account", SNOWFLAKE_USERNAME: "username",
  SNOWFLAKE_PASSWORD: "password", SNOWFLAKE_AUTHENTICATOR: "authenticator",
  SNOWFLAKE_DATABASE: "database", SNOWFLAKE_SCHEMA: "schema",
};

function env(name: string, fallback?: string) {
  const value = Netlify.env.get(name) || runtimeConfig[configKey[name]] || fallback;
  if (!value) throw new Error(`${name} 환경변수가 필요합니다.`);
  return value;
}

async function connection() {
  if (!connectionPromise) {
    connectionPromise = new Promise((resolve, reject) => {
      const client = snowflake.createConnection({
        account: env("SNOWFLAKE_ACCOUNT"),
        username: env("SNOWFLAKE_USERNAME", "seohyunho"),
        password: env("SNOWFLAKE_PASSWORD"),
        authenticator: env("SNOWFLAKE_AUTHENTICATOR", "SNOWFLAKE"),
        database: env("SNOWFLAKE_DATABASE", "MEMBER"),
        schema: env("SNOWFLAKE_SCHEMA", "PUBLIC"),
        warehouse: Netlify.env.get("SNOWFLAKE_WAREHOUSE") || undefined,
        role: Netlify.env.get("SNOWFLAKE_ROLE") || undefined,
        clientSessionKeepAlive: true,
      });
      client.connect((error, connected) => error ? reject(error) : resolve(connected));
    }).catch((error) => { connectionPromise = undefined; throw error; });
  }
  return connectionPromise;
}

async function query(sqlText: string, binds: any[] = []) {
  const client = await connection();
  return new Promise<any[]>((resolve, reject) => client.execute({
    sqlText, binds,
    complete(error: Error | undefined, _statement: unknown, rows: any[]) {
      if (error) reject(error); else resolve(rows || []);
    },
  }));
}

async function transaction<T>(work: () => Promise<T>) {
  await query("BEGIN");
  try { const result = await work(); await query("COMMIT"); return result; }
  catch (error) { await query("ROLLBACK").catch(() => {}); throw error; }
}

function id(value: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("잘못된 번호입니다.");
  return parsed;
}

async function form(request: Request) {
  const data = await request.formData();
  const title = String(data.get("title") || "").trim();
  const content = String(data.get("content") || "").trim();
  if (!title || !content) throw new Error("제목과 내용을 입력해 주세요.");
  if (title.length > 80 || content.length > 3000) throw new Error("입력 길이를 확인해 주세요.");
  const files = data.getAll("files").filter((item): item is File => item instanceof File);
  return { data, title, content, files };
}

async function saveFiles(postId: number, files: File[]) {
  const store = getStore({ name: "board-attachments", consistency: "strong" });
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > 4 * 1024 * 1024) throw new Error("공개 게시판 첨부파일은 전체 4MB까지 가능합니다.");
  for (const file of files) {
    if (file.size > 4 * 1024 * 1024) throw new Error("공개 게시판 첨부파일은 파일당 4MB까지 가능합니다.");
    const attachmentId = Date.now() * 1000 + randomInt(1000);
    await store.set(String(attachmentId), await file.arrayBuffer());
    try {
      await query(`INSERT INTO MEMBER.PUBLIC.BOARD_ATTACHMENTS
        (ATTACHMENT_ID, POST_ID, FILE_NAME, CONTENT_TYPE, FILE_SIZE, FILE_DATA)
        SELECT ?, ?, ?, ?, ?, TO_BINARY('00', 'HEX')`,
        [attachmentId, postId, file.name, file.type || "application/octet-stream", file.size]);
    } catch (error) { await store.delete(String(attachmentId)); throw error; }
  }
}

async function deleteFiles(postId: number, retained: number[] = []) {
  const keep = retained.length ? ` AND ATTACHMENT_ID NOT IN (${retained.map(() => "?").join(",")})` : "";
  const binds = [postId, ...retained];
  const files = await query(`SELECT ATTACHMENT_ID AS "id" FROM MEMBER.PUBLIC.BOARD_ATTACHMENTS WHERE POST_ID = ?${keep}`, binds);
  await query(`DELETE FROM MEMBER.PUBLIC.BOARD_ATTACHMENTS WHERE POST_ID = ?${keep}`, binds);
  const store = getStore({ name: "board-attachments", consistency: "strong" });
  await Promise.all(files.map((file) => store.delete(String(file.id))));
}

export default async (request: Request, context: Context) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(request) });
  try {
    const path = new URL(request.url).pathname;
    if (path === "/api/health" && request.method === "GET") {
      const [session] = await query(`SELECT CURRENT_ACCOUNT() AS "account", CURRENT_USER() AS "user",
        CURRENT_DATABASE() AS "database", CURRENT_SCHEMA() AS "schema", CURRENT_ROLE() AS "role"`);
      return json(request, { ok: true, configured: true, appVersion: "snowflake-13", ...session });
    }
    if (path === "/api/posts" && request.method === "GET") {
      const rows = await query(`SELECT p.POST_ID AS "id", p.TITLE AS "title", p.CONTENT AS "content",
        p.CREATED_AT AS "createdAt", p.UPDATED_AT AS "updatedAt", COUNT(a.ATTACHMENT_ID) AS "fileCount"
        FROM MEMBER.PUBLIC.BOARD_POSTS p LEFT JOIN MEMBER.PUBLIC.BOARD_ATTACHMENTS a ON a.POST_ID=p.POST_ID
        GROUP BY p.POST_ID,p.TITLE,p.CONTENT,p.CREATED_AT,p.UPDATED_AT ORDER BY p.CREATED_AT DESC`);
      return json(request, rows);
    }
    if (path === "/api/posts" && request.method === "POST") {
      const input = await form(request);
      const requestedPostId = Number(input.data.get("postId"));
      const postId = Number.isSafeInteger(requestedPostId) && requestedPostId > 0
        ? requestedPostId : Date.now() * 1000 + randomInt(1000);
      const [existing] = await query("SELECT POST_ID AS \"id\" FROM MEMBER.PUBLIC.BOARD_POSTS WHERE POST_ID=?", [postId]);
      if (!existing) {
        try {
          await transaction(async () => {
            await query("INSERT INTO MEMBER.PUBLIC.BOARD_POSTS (POST_ID,TITLE,CONTENT) VALUES (?,?,?)", [postId,input.title,input.content]);
            await saveFiles(postId, input.files);
          });
        } catch (error) {
          const [saved] = await query("SELECT POST_ID AS \"id\" FROM MEMBER.PUBLIC.BOARD_POSTS WHERE POST_ID=?", [postId]);
          if (!saved) throw error;
        }
      }
      const [verified] = await query(`SELECT POST_ID AS "id", TITLE AS "title", CONTENT AS "content"
        FROM MEMBER.PUBLIC.BOARD_POSTS WHERE POST_ID=?`, [postId]);
      if (!verified || String(verified.title) !== input.title || String(verified.content) !== input.content) {
        throw new Error("커밋 후 MEMBER.PUBLIC.BOARD_POSTS 재조회에 실패했습니다.");
      }
      return json(request, {
        id: postId, created: !existing, verified: true,
        target: "MEMBER.PUBLIC.BOARD_POSTS", verifiedTitle: verified.title,
      }, 201);
    }
    const postMatch = path.match(/^\/api\/posts\/(\d+)$/);
    if (postMatch && request.method === "GET") {
      const postId = id(postMatch[1]);
      const [post] = await query(`SELECT POST_ID AS "id",TITLE AS "title",CONTENT AS "content",CREATED_AT AS "createdAt",UPDATED_AT AS "updatedAt" FROM MEMBER.PUBLIC.BOARD_POSTS WHERE POST_ID=?`, [postId]);
      if (!post) return json(request, { message: "게시글을 찾을 수 없습니다." }, 404);
      post.files = await query(`SELECT ATTACHMENT_ID AS "id",FILE_NAME AS "name",CONTENT_TYPE AS "type",FILE_SIZE AS "size" FROM MEMBER.PUBLIC.BOARD_ATTACHMENTS WHERE POST_ID=? ORDER BY ATTACHMENT_ID`, [postId]);
      return json(request, post);
    }
    if (postMatch && request.method === "PUT") {
      const postId = id(postMatch[1]); const input = await form(request);
      const retained = JSON.parse(String(input.data.get("retainedAttachmentIds") || "[]")).map(Number).filter(Number.isSafeInteger);
      await transaction(async () => {
        await query("UPDATE MEMBER.PUBLIC.BOARD_POSTS SET TITLE=?,CONTENT=?,UPDATED_AT=CURRENT_TIMESTAMP() WHERE POST_ID=?", [input.title,input.content,postId]);
        await deleteFiles(postId, retained); await saveFiles(postId, input.files);
      });
      return json(request, { id: postId });
    }
    if (postMatch && request.method === "DELETE") {
      const postId = id(postMatch[1]);
      await transaction(async () => { await deleteFiles(postId); await query("DELETE FROM MEMBER.PUBLIC.BOARD_POSTS WHERE POST_ID=?", [postId]); });
      return new Response(null, { status: 204, headers: headers(request) });
    }
    const fileMatch = path.match(/^\/api\/attachments\/(\d+)\/download$/);
    if (fileMatch && request.method === "GET") {
      const fileId = id(fileMatch[1]);
      const [file] = await query(`SELECT FILE_NAME AS "name",CONTENT_TYPE AS "type" FROM MEMBER.PUBLIC.BOARD_ATTACHMENTS WHERE ATTACHMENT_ID=?`, [fileId]);
      if (!file) return json(request, { message: "첨부파일을 찾을 수 없습니다." }, 404);
      const data = await getStore({ name: "board-attachments", consistency: "strong" }).get(String(fileId), { type: "arrayBuffer" });
      if (!data) return json(request, { message: "첨부파일 데이터가 없습니다." }, 404);
      return new Response(data, { headers: { ...headers(request), "Content-Type": file.type, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` } });
    }
    return json(request, { message: "요청 경로를 찾을 수 없습니다." }, 404);
  } catch (error: any) {
    console.error(error);
    return json(request, { message: `Snowflake 요청 실패: ${error.message}` }, 500);
  }
};

export const config: Config = { path: "/api/*" };
