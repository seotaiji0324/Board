const PAGE_SIZE = 6;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const APP_VERSION = "snowflake-8";

const state = {
  posts: [], query: "", page: 1, selectedId: null, editorFiles: [],
};

const $ = (selector) => document.querySelector(selector);
const els = {
  list: $("#post-list"), empty: $("#empty-state"), count: $("#post-count"),
  pagination: $("#pagination"), search: $("#search-input"), editor: $("#editor-dialog"),
  detail: $("#detail-dialog"), confirm: $("#confirm-dialog"), form: $("#post-form"),
  postId: $("#post-id"), title: $("#title-input"), content: $("#content-input"),
  files: $("#file-input"), fileList: $("#file-list"), dropZone: $("#drop-zone"), toast: $("#toast"),
};

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || `요청을 처리하지 못했습니다. (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

const getPosts = () => api("/api/posts");
const getPost = (id) => api(`/api/posts/${Number(id)}`);
const removePost = (id) => api(`/api/posts/${Number(id)}`, { method: "DELETE" });

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function formatDate(value, long = false) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("ko-KR", long
    ? { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "2-digit", day: "2-digit" }
  ).format(date);
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function filteredPosts() {
  const query = state.query.trim().toLocaleLowerCase("ko");
  return state.posts
    .filter((post) => !query || `${post.title} ${post.content}`.toLocaleLowerCase("ko").includes(query))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function attachmentIcon() {
  return `<svg viewBox="0 0 24 24" aria-label="첨부파일 있음"><path d="m8.5 12.5 6.2-6.2a3 3 0 0 1 4.2 4.2l-8.3 8.3a5 5 0 0 1-7.1-7.1l8.2-8.2"></path></svg>`;
}

function render() {
  const posts = filteredPosts();
  const pages = Math.max(1, Math.ceil(posts.length / PAGE_SIZE));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * PAGE_SIZE;
  const visible = posts.slice(start, start + PAGE_SIZE);

  els.count.textContent = posts.length;
  els.list.innerHTML = visible.map((post, index) => `
    <article class="post-row" tabindex="0" role="button" data-id="${post.id}" aria-label="${escapeHtml(post.title)} 게시글 보기">
      <span class="post-number">${String(posts.length - start - index).padStart(2, "0")}</span>
      <div class="post-title-wrap">
        <h3 class="post-title">${escapeHtml(post.title)} ${Number(post.fileCount) ? attachmentIcon() : ""} ${post.syncStatus ? `<span class="sync-badge ${post.syncStatus}">${post.syncStatus === "pending" ? "저장 중" : "저장 완료"}</span>` : ""}</h3>
        <p class="post-excerpt">${escapeHtml(post.content.replace(/\s+/g, " "))}</p>
      </div>
      <time class="post-date" datetime="${post.createdAt}">${formatDate(post.createdAt)}</time>
    </article>`).join("");

  const isEmpty = !visible.length;
  els.list.hidden = isEmpty;
  els.empty.hidden = !isEmpty;
  els.empty.querySelector("h3").textContent = state.query ? "검색 결과가 없어요" : "아직 이야기가 없어요";
  els.empty.querySelector("p").textContent = state.query ? "다른 검색어로 찾아보세요." : "첫 번째 이야기를 남겨보세요.";
  els.pagination.innerHTML = posts.length > PAGE_SIZE
    ? Array.from({ length: pages }, (_, i) => `<button class="page-button ${i + 1 === state.page ? "active" : ""}" data-page="${i + 1}" aria-label="${i + 1}페이지">${i + 1}</button>`).join("")
    : "";
}

function renderEditorFiles() {
  els.fileList.innerHTML = state.editorFiles.map((file, index) => `
    <li class="file-item">
      <span>📎 ${escapeHtml(file.name)} · ${formatBytes(file.size)}</span>
      <button type="button" data-remove-file="${index}" aria-label="${escapeHtml(file.name)} 삭제">×</button>
    </li>`).join("");
}

function addFiles(fileList) {
  for (const file of fileList) {
    if (file.size > MAX_FILE_SIZE) {
      showToast(`${file.name}: 10MB 이하 파일만 첨부할 수 있어요.`);
      continue;
    }
    const duplicate = state.editorFiles.some((item) => item.name === file.name && item.size === file.size);
    if (!duplicate) state.editorFiles.push(file);
  }
  renderEditorFiles();
}

function showEditor(post = null) {
  els.form.reset();
  els.postId.value = post?.id ?? "";
  els.title.value = post?.title ?? "";
  els.content.value = post?.content ?? "";
  state.editorFiles = post?.files ? [...post.files] : [];
  $("#editor-title").textContent = post ? "이야기 수정하기" : "새 이야기 쓰기";
  els.form.querySelector('[type="submit"]').textContent = post ? "수정 완료" : "이야기 등록";
  updateCounts();
  renderEditorFiles();
  els.editor.showModal();
  setTimeout(() => els.title.focus(), 50);
}

function closeDialog(dialog) { if (dialog.open) dialog.close(); }

async function showDetail(id) {
  try {
    const post = await getPost(id);
    state.selectedId = post.id;
    const sorted = filteredPosts();
    const number = sorted.length - sorted.findIndex((item) => Number(item.id) === Number(post.id));
    $("#detail-number").textContent = `NO. ${String(number).padStart(2, "0")}`;
    $("#detail-title").textContent = post.title;
    $("#detail-date").textContent = `${formatDate(post.createdAt, true)}${post.updatedAt ? ` · ${formatDate(post.updatedAt, true)} 수정` : ""}`;
    $("#detail-content").textContent = post.content;
    $("#detail-files").innerHTML = (post.files || []).map((file) => `
      <div class="attachment">
        <span>📎 ${escapeHtml(file.name)} · ${formatBytes(file.size)}</span>
        <a href="/api/attachments/${file.id}/download">다운로드 ↓</a>
      </div>`).join("");
    els.detail.showModal();
  } catch (error) { showToast(error.message); }
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 3000);
}

function updateCounts() {
  $("#title-count").textContent = els.title.value.length;
  $("#content-count").textContent = els.content.value.length.toLocaleString();
}

async function refresh() {
  state.posts = await getPosts();
  render();
}

document.addEventListener("click", async (event) => {
  try {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "write") showEditor();
    if (action === "close-editor") closeDialog(els.editor);
    if (action === "close-detail") closeDialog(els.detail);
    if (action === "cancel-delete") closeDialog(els.confirm);
    if (action === "delete") els.confirm.showModal();
    if (action === "edit") {
      const post = await getPost(state.selectedId);
      closeDialog(els.detail);
      showEditor(post);
    }
    if (action === "confirm-delete") {
      await removePost(state.selectedId);
      closeDialog(els.confirm);
      closeDialog(els.detail);
      await refresh();
      showToast("이야기가 삭제되었습니다.");
    }

    const row = event.target.closest(".post-row");
    if (row) {
      const pendingPost = state.posts.find((post) => String(post.id) === row.dataset.id && post.syncStatus);
      if (pendingPost) showToast(pendingPost.syncStatus === "pending" ? "Snowflake에 저장 중입니다." : "Snowflake 반영을 확인 중입니다.");
      else showDetail(row.dataset.id);
    }
    const page = event.target.closest("[data-page]")?.dataset.page;
    if (page) {
      state.page = Number(page);
      render();
      $("#board-title").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const removeIndex = event.target.closest("[data-remove-file]")?.dataset.removeFile;
    if (removeIndex !== undefined) {
      state.editorFiles.splice(Number(removeIndex), 1);
      renderEditorFiles();
    }
  } catch (error) { showToast(error.message); }
});

els.list.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.classList.contains("post-row")) {
    event.preventDefault();
    const pendingPost = state.posts.find((post) => String(post.id) === event.target.dataset.id && post.syncStatus);
    if (pendingPost) showToast(pendingPost.syncStatus === "pending" ? "Snowflake에 저장 중입니다." : "Snowflake 반영을 확인 중입니다.");
    else showDetail(event.target.dataset.id);
  }
});
els.search.addEventListener("input", () => { state.query = els.search.value; state.page = 1; render(); });
els.title.addEventListener("input", updateCounts);
els.content.addEventListener("input", updateCounts);
els.files.addEventListener("change", () => addFiles(els.files.files));
els.dropZone.addEventListener("dragover", (event) => { event.preventDefault(); els.dropZone.classList.add("dragover"); });
els.dropZone.addEventListener("dragleave", () => els.dropZone.classList.remove("dragover"));
els.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  els.dropZone.classList.remove("dragover");
  addFiles(event.dataTransfer.files);
});

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!els.form.reportValidity()) return;
  if (!els.title.value.trim() || !els.content.value.trim()) {
    showToast("제목과 내용을 입력해 주세요.");
    (!els.title.value.trim() ? els.title : els.content).focus();
    return;
  }
  const submitButton = els.form.querySelector('[type="submit"]');
  const submitLabel = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = "Snowflake에 저장 중…";
  try {
    const existingId = Number(els.postId.value) || null;
    const title = els.title.value.trim();
    const content = els.content.value.trim();
    const formData = new FormData();
    formData.append("title", title);
    formData.append("content", content);
    formData.append("retainedAttachmentIds", JSON.stringify(state.editorFiles.filter((file) => file.id).map((file) => Number(file.id))));
    state.editorFiles.filter((file) => file instanceof File).forEach((file) => formData.append("files", file));
    if (existingId) {
      await api(`/api/posts/${existingId}`, { method: "PUT", body: formData });
      closeDialog(els.editor);
      await refresh();
      showToast("이야기가 수정되었습니다.");
    } else {
      const tempId = `pending-${Date.now()}`;
      state.posts.unshift({
        id: tempId, title, content, createdAt: new Date().toISOString(), updatedAt: null,
        fileCount: state.editorFiles.length, syncStatus: "pending",
      });
      closeDialog(els.editor);
      render();
      showToast("게시글이 접수되었습니다. Snowflake에 저장 중입니다.");
      const created = await api("/api/posts", { method: "POST", body: formData });
      if (!created.verified || !created.id) throw new Error("Snowflake 저장 확인 응답이 없습니다.");
      const pending = state.posts.find((post) => post.id === tempId);
      if (pending) {
        pending.id = Number(created.id);
        pending.syncStatus = "synced";
      }
      render();
      showToast(`${created.target} 저장이 확인되었습니다.`);
      setTimeout(async () => {
        try { await refresh(); }
        catch { /* 다음 화면 조회 시 다시 동기화됩니다. */ }
      }, 1500);
    }
  } catch (error) {
    state.posts = state.posts.filter((post) => post.syncStatus !== "pending");
    render();
    showToast(`저장 실패: ${error.message}`);
  }
  finally {
    submitButton.disabled = false;
    submitButton.textContent = submitLabel;
  }
});

[els.editor, els.detail, els.confirm].forEach((dialog) => {
  dialog.addEventListener("click", (event) => { if (event.target === dialog) closeDialog(dialog); });
});

(async function init() {
  const status = $("#db-status");
  const writeButtons = document.querySelectorAll('[data-action="write"]');
  writeButtons.forEach((button) => { button.disabled = true; });
  try {
    const [health] = await Promise.all([api("/api/health"), refresh()]);
    if (health.appVersion !== APP_VERSION) {
      location.reload();
      return;
    }
    status.className = "db-status connected";
    status.innerHTML = "<i></i> Snowflake 연결됨";
    writeButtons.forEach((button) => { button.disabled = false; });
  }
  catch (error) {
    render();
    status.className = "db-status error";
    status.innerHTML = "<i></i> DB 연결 오류";
    els.empty.querySelector("h3").textContent = "데이터베이스 연결이 필요해요";
    els.empty.querySelector("p").textContent = ".env에 Snowflake 접속 정보를 설정해 주세요.";
    showToast(error.message);
  }
})();
