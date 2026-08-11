# 모아 게시판 · Snowflake

Snowflake `MEMBER.PUBLIC`에 게시글과 첨부파일을 저장하는 게시판입니다. 작성·조회·수정·삭제, 검색, 페이지 이동, 다중 첨부파일 업로드와 다운로드를 지원합니다.

## 설정

1. `.env.example`을 복사해 `.env` 파일을 만듭니다.
2. 아래 필수 값을 입력합니다.

```dotenv
SNOWFLAKE_ACCOUNT=조직명-계정명
SNOWFLAKE_USERNAME=seohyunho
SNOWFLAKE_PASSWORD=비밀번호
SNOWFLAKE_WAREHOUSE=웨어하우스명 # 사용자 기본 웨어하우스가 있으면 생략 가능
SNOWFLAKE_DATABASE=MEMBER
SNOWFLAKE_SCHEMA=PUBLIC
```

`SNOWFLAKE_ACCOUNT`에는 사용자명이 아닌 Snowflake 계정 식별자가 필요합니다. Snowsight URL이 `https://app.snowflake.com/myorg/myaccount/`라면 일반적으로 `myorg-myaccount` 형식입니다.

운영 환경에서는 비밀번호 대신 키 페어 인증(`SNOWFLAKE_JWT`)을 권장합니다. `.env.example`의 키 경로 항목을 참고하세요.

## 설치 및 실행

```powershell
npm.cmd install
npm.cmd run init-db
npm.cmd start
```

브라우저에서 `http://127.0.0.1:43177`을 엽니다. 서버 시작 시에도 테이블이 없으면 자동으로 생성됩니다.

현재 사내 네트워크에서는 `npm` 스크립트가 Git에서 제외된 `.certs`의 SDS 루트 인증서를 고정하고, 해당 구형 인증서에 필요한 OpenSSL 호환 모드로 Node 프로세스를 실행합니다. 외부 환경에서는 최신 CA 인증서로 교체하는 것을 권장합니다.

연결만 점검하려면 다음 명령을 사용합니다.

```powershell
npm.cmd run check-db
```

## 생성되는 테이블

- `MEMBER.PUBLIC.BOARD_POSTS`: 제목, 내용, 작성·수정 시각
- `MEMBER.PUBLIC.BOARD_ATTACHMENTS`: 파일명, 형식, 크기, 최대 10MB의 바이너리 데이터

DDL 원본은 `sql/init.sql`에 있습니다. Snowflake의 기본 키와 외래 키 제약조건은 일반 테이블에서 정보 제공용이며, 삭제 정합성은 API 트랜잭션에서 처리합니다.
