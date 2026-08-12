import express from "express";
import multer from "multer";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomInt } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { getConnection, missingConfiguration, query, transaction } from "./db.mjs";

const app = express();
const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 43177);
const appVersion = "snowflake-8";
const uploadRoot = join(root, ".uploads");
let snowflakeReady = false;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10, fields: 20 },
});

app.use((_request, response, next) => {
  response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});

app.get("/", (_request, response) => response.sendFile(join(root, "index.html")));
app.get("/styles.css", (_request, response) => response.sendFile(join(root, "styles.css")));
app.get("/app.js", (_request, response) => response.sendFile(join(root, "app.js")));

function requireText(value, name, maxLength) {
  const text = String(value || "").trim();
  if (!text) throw Object.assign(new Error(`${name}을(를) 입력해 주세요.`), { status: 400 });
  if (text.length > maxLength) throw Object.assign(new Error(`${name}은(는) ${maxLength}자 이하여야 합니다.`), { status: 400 });
  return text;
}

function numberId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error("잘못된 게시글 번호입니다."), { status: 400 });
  return id;
}

function createPostId() {
  return Date.now() * 1000 + randomInt(1000);
}

function createAttachmentId() {
  return Date.now() * 1000 + randomInt(1000);
}

async function insertAttachments(postId, files) {
  for (const file of files || []) {
    const attachmentId = createAttachmentId();
    await mkdir(uploadRoot, { recursive: true });
    await writeFile(join(uploadRoot, String(attachmentId)), file.buffer);
    try {
      await query(
        `INSERT INTO MEMBER.PUBLIC.BOARD_ATTACHMENTS
         (ATTACHMENT_ID, POST_ID, FILE_NAME, CONTENT_TYPE, FILE_SIZE, FILE_DATA)
         SELECT ?, ?, ?, ?, ?, TO_BINARY('00', 'HEX')`,
        [attachmentId, postId, file.originalname, file.mimetype || "application/octet-stream", file.size]
      );
    } catch (error) {
      await unlink(join(uploadRoot, String(attachmentId))).catch(() => {});
      throw new Error(`첨부파일 메타데이터 저장 실패: ${error.message}`);
    }
  }
}

async function deleteAttachmentData(postId, retained = []) {
  const keepSql = retained.length ? ` AND ATTACHMENT_ID NOT IN (${retained.map(() => "?").join(",")})` : "";
  const binds = [postId, ...retained];
  const attachments = await query(`SELECT ATTACHMENT_ID AS "id" FROM MEMBER.PUBLIC.BOARD_ATTACHMENTS
                                    WHERE POST_ID = ?${keepSql}`, binds);
  await query(`DELETE FROM MEMBER.PUBLIC.BOARD_ATTACHMENT_CHUNKS
               WHERE ATTACHMENT_ID IN (SELECT ATTACHMENT_ID FROM MEMBER.PUBLIC.BOARD_ATTACHMENTS
               WHERE POST_ID = ?${keepSql})`, binds);
  await query(`DELETE FROM MEMBER.PUBLIC.BOARD_ATTACHMENTS WHERE POST_ID = ?${keepSql}`, binds);
  await Promise.all(attachments.map((attachment) =>
    unlink(join(uploadRoot, String(attachment.id))).catch(() => {})
  ));
}

async function verifyStoredPost(postId) {
  const [stored] = await query(`
    SELECT POST_ID AS "id", TITLE AS "title", CREATED_AT AS "createdAt"
    FROM MEMBER.PUBLIC.BOARD_POSTS WHERE POST_ID = ?`, [postId]);
  if (!stored) throw new Error("Snowflake 저장 확인에 실패했습니다.");
  return stored;
}

app.get("/api/health", async (_request, response, next) => {
  try {
    const missing = missingConfiguration();
    if (missing.length) return response.status(503).json({ ok: false, configured: false, missing });
    response.json({
      ok: snowflakeReady,
      configured: true,
      appVersion,
      account: process.env.SNOWFLAKE_ACCOUNT,
      database: process.env.SNOWFLAKE_DATABASE || "MEMBER",
      schema: process.env.SNOWFLAKE_SCHEMA || "PUBLIC",
    });
  } catch (error) { next(error); }
});

app.get("/api/posts", async (_request, response, next) => {
  try {
    const rows = await query(`
      SELECT p.POST_ID AS "id", p.TITLE AS "title", p.CONTENT AS "content",
             p.CREATED_AT AS "createdAt", p.UPDATED_AT AS "updatedAt",
             COUNT(a.ATTACHMENT_ID) AS "fileCount"
      FROM MEMBER.PUBLIC.BOARD_POSTS p
      LEFT JOIN MEMBER.PUBLIC.BOARD_ATTACHMENTS a ON a.POST_ID = p.POST_ID
      GROUP BY p.POST_ID, p.TITLE, p.CONTENT, p.CREATED_AT, p.UPDATED_AT
      ORDER BY p.CREATED_AT DESC
    `);
    response.json(rows);
  } catch (error) { next(error); }
});

app.get("/api/posts/:id", async (request, response, next) => {
  try {
    const id = numberId(request.params.id);
    const [post] = await query(`
      SELECT POST_ID AS "id", TITLE AS "title", CONTENT AS "content",
             CREATED_AT AS "createdAt", UPDATED_AT AS "updatedAt"
      FROM MEMBER.PUBLIC.BOARD_POSTS WHERE POST_ID = ?`, [id]);
    if (!post) return response.status(404).json({ message: "게시글을 찾을 수 없습니다." });
    post.files = await query(`
      SELECT ATTACHMENT_ID AS "id", FILE_NAME AS "name", CONTENT_TYPE AS "type", FILE_SIZE AS "size"
      FROM MEMBER.PUBLIC.BOARD_ATTACHMENTS WHERE POST_ID = ? ORDER BY ATTACHMENT_ID`, [id]);
    response.json(post);
  } catch (error) { next(error); }
});

app.post("/api/posts", upload.array("files", 10), async (request, response, next) => {
  try {
    const title = requireText(request.body.title, "제목", 80);
    const content = requireText(request.body.content, "내용", 3000);
    const postId = createPostId();
    if (!request.files?.length) {
      await query(`INSERT INTO MEMBER.PUBLIC.BOARD_POSTS (POST_ID, TITLE, CONTENT) VALUES (?, ?, ?)`, [postId, title, content], { timeoutMs: 20000 });
      return response.status(201).json({ id: postId, created: true, verified: true, target: "MEMBER.PUBLIC.BOARD_POSTS" });
    }
    const id = await transaction(async () => {
      await query(`INSERT INTO MEMBER.PUBLIC.BOARD_POSTS (POST_ID, TITLE, CONTENT) VALUES (?, ?, ?)`, [postId, title, content], { timeoutMs: 20000 });
      await insertAttachments(postId, request.files);
      return postId;
    });
    response.status(201).json({ id, created: true, verified: true, target: "MEMBER.PUBLIC.BOARD_POSTS" });
  } catch (error) { next(error); }
});

app.put("/api/posts/:id", upload.array("files", 10), async (request, response, next) => {
  try {
    const id = numberId(request.params.id);
    const title = requireText(request.body.title, "제목", 80);
    const content = requireText(request.body.content, "내용", 3000);
    let retained = [];
    try { retained = JSON.parse(request.body.retainedAttachmentIds || "[]").map(Number).filter(Number.isSafeInteger); }
    catch { throw Object.assign(new Error("첨부파일 정보가 올바르지 않습니다."), { status: 400 }); }
    await transaction(async () => {
      const result = await query(`UPDATE MEMBER.PUBLIC.BOARD_POSTS SET TITLE = ?, CONTENT = ?, UPDATED_AT = CURRENT_TIMESTAMP() WHERE POST_ID = ?`, [title, content, id]);
      await deleteAttachmentData(id, retained);
      await insertAttachments(id, request.files);
      return result;
    });
    response.json({ id });
  } catch (error) { next(error); }
});

app.delete("/api/posts/:id", async (request, response, next) => {
  try {
    const id = numberId(request.params.id);
    await transaction(async () => {
      await deleteAttachmentData(id);
      await query(`DELETE FROM MEMBER.PUBLIC.BOARD_POSTS WHERE POST_ID = ?`, [id]);
    });
    response.status(204).end();
  } catch (error) { next(error); }
});

app.get("/api/attachments/:id/download", async (request, response, next) => {
  try {
    const id = numberId(request.params.id);
    const [file] = await query(`
      SELECT FILE_NAME AS "name", CONTENT_TYPE AS "type", FILE_DATA AS "data"
      FROM MEMBER.PUBLIC.BOARD_ATTACHMENTS WHERE ATTACHMENT_ID = ?`, [id]);
    if (!file) return response.status(404).json({ message: "첨부파일을 찾을 수 없습니다." });
    const safeName = String(file.name).replace(/[\r\n"]/g, "_");
    response.setHeader("Content-Type", file.type || "application/octet-stream");
    response.setHeader("Content-Disposition", `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    const data = await readFile(join(uploadRoot, String(id))).catch(() =>
      Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "hex")
    );
    response.send(data);
  } catch (error) { next(error); }
});

app.use((error, _request, response, _next) => {
  const isUploadLimit = error instanceof multer.MulterError;
  const status = error.status || (isUploadLimit ? 400 : 500);
  console.error(error.message);
  response.status(status).json({ message: isUploadLimit ? "첨부파일은 파일당 10MB, 최대 10개까지 가능합니다." : error.message });
});

app.listen(port, "127.0.0.1", async () => {
  console.log(`모아 게시판: http://127.0.0.1:${port}`);
  if (missingConfiguration().length) {
    console.log("Snowflake 환경변수가 설정되지 않았습니다. .env.example을 참고해 .env를 작성해 주세요.");
    return;
  }
  try {
    await getConnection();
    snowflakeReady = true;
    console.log("MEMBER.PUBLIC Snowflake 연결 준비 완료");
  } catch (error) {
    console.error(error.message);
  }
});
