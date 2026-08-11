import express from "express";
import multer from "multer";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initializeSchema, missingConfiguration, query, transaction } from "./db.mjs";

const app = express();
const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 43177);
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

async function insertAttachments(postId, files) {
  for (const file of files || []) {
    await query(
      `INSERT INTO MEMBER.PUBLIC.BOARD_ATTACHMENTS
       (POST_ID, FILE_NAME, CONTENT_TYPE, FILE_SIZE, FILE_DATA)
       SELECT ?, ?, ?, ?, TO_BINARY(?, 'BASE64')`,
      [postId, file.originalname, file.mimetype || "application/octet-stream", file.size, file.buffer.toString("base64")]
    );
  }
}

app.get("/api/health", async (_request, response, next) => {
  try {
    const missing = missingConfiguration();
    if (missing.length) return response.status(503).json({ ok: false, configured: false, missing });
    const [row] = await query(`SELECT CURRENT_ACCOUNT() AS "account", CURRENT_DATABASE() AS "database", CURRENT_SCHEMA() AS "schema"`);
    response.json({ ok: true, configured: true, ...row });
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
    if (!request.files?.length) {
      await query(`INSERT INTO MEMBER.PUBLIC.BOARD_POSTS (TITLE, CONTENT) VALUES (?, ?)`, [title, content]);
      return response.status(201).json({ created: true });
    }
    const id = await transaction(async () => {
      const [nextId] = await query(`SELECT MEMBER.PUBLIC.BOARD_POST_ID_SEQ.NEXTVAL AS "id"`);
      await query(`INSERT INTO MEMBER.PUBLIC.BOARD_POSTS (POST_ID, TITLE, CONTENT) VALUES (?, ?, ?)`, [nextId.id, title, content]);
      await insertAttachments(nextId.id, request.files);
      return nextId.id;
    });
    response.status(201).json({ id });
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
      const keepSql = retained.length ? ` AND ATTACHMENT_ID NOT IN (${retained.map(() => "?").join(",")})` : "";
      await query(`DELETE FROM MEMBER.PUBLIC.BOARD_ATTACHMENTS WHERE POST_ID = ?${keepSql}`, [id, ...retained]);
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
      await query(`DELETE FROM MEMBER.PUBLIC.BOARD_ATTACHMENTS WHERE POST_ID = ?`, [id]);
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
    response.send(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "hex"));
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
    await initializeSchema();
    console.log("MEMBER.PUBLIC 게시판 테이블 준비 완료");
  } catch (error) {
    console.error(error.message);
  }
});
