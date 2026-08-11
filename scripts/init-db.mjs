import { initializeSchema } from "../db.mjs";

try {
  await initializeSchema();
  console.log("MEMBER.PUBLIC에 게시판 테이블을 생성했습니다.");
  process.exit(0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
