/**
 * m2.js — منطق و رفتار صفحه (UI Logic Layer)
 * ------------------------------------------------------------
 * این فایل index.html را به m1.js (API Client) وصل می‌کند:
 * سوییچ بین صفحات، رندر کردن داده‌ی واقعی، مدیریت آپلود،
 * پست تمام‌صفحه، لایک/کامنت، ویرایش پروفایل، استوری و لایو.
 *
 * تا وقتی بک‌اند واقعی روشن نیست، فراخوانی‌های BamgramAPI با خطا
 * مواجه می‌شوند و این فایل آن خطا را به‌صورت toast نشان می‌دهد —
 * هیچ داده‌ی ساختگی جایگزین نمی‌شود.
 */
(function () {
  const API = window.BamgramAPI;
  if (!API) {
    console.error("m1.js لود نشده — m2.js نمی‌تواند کار کند.");
    return;
  }
  const { Auth, Users, Posts, Stories, Messages, Live, Realtime } = API;

  /* ------------------------------------------------------------ */
  /* Helpers                                                        */
  /* ------------------------------------------------------------ */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function toast(message, isError = false) {
    const el = $("#toast");
    el.textContent = message;
    el.style.borderColor = isError ? "var(--danger)" : "var(--line)";
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function handleApiError(err, fallback) {
    console.error(err);
    const msg = err && err.message ? err.message : fallback || "خطایی رخ داد";
    toast(msg, true);
  }

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function timeAgo(iso) {
    if (!iso) return "";
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return "چند لحظه پیش";
    if (diff < 3600) return Math.floor(diff / 60) + " دقیقه پیش";
    if (diff < 86400) return Math.floor(diff / 3600) + " ساعت پیش";
    return Math.floor(diff / 86400) + " روز پیش";
  }

  /* ------------------------------------------------------------ */
  /* App state                                                      */
  /* ------------------------------------------------------------ */
  const state = {
    currentUser: null,
    activeView: "explore",
    openPost: null,
    uploadFile: null
  };

  /* ------------------------------------------------------------ */
  /* View switching (bottom nav)                                   */
  /* ------------------------------------------------------------ */
  function switchView(view) {
    state.activeView = view;
    $$(".view").forEach((v) => v.classList.remove("active"));
    $(`#view-${view}`).classList.add("active");
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));

    if (view === "explore") loadExploreFeed();
    if (view === "profile") loadProfile();
  }

  $$(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  /* ------------------------------------------------------------ */
  /* Explore                                                        */
  /* ------------------------------------------------------------ */
  async function loadExploreFeed() {
    const grid = $("#explore-grid");
    try {
      const data = await Posts.getExploreFeed();
      const posts = (data && data.posts) || [];
      if (!posts.length) {
        grid.innerHTML = `<div style="grid-column:1/-1;padding:40px 16px;text-align:center;color:var(--text-dim);font-size:13.5px;">هنوز پستی برای نمایش نیست</div>`;
        return;
      }
      grid.innerHTML = posts.map((p) => `
        <div class="cell" data-post-id="${p.id}" style="background-image:url('${escapeHtml(p.imageUrl)}')"></div>
      `).join("");
      grid.querySelectorAll(".cell").forEach((cell) => {
        cell.addEventListener("click", () => openPost(cell.dataset.postId));
      });
    } catch (err) {
      grid.innerHTML = `<div style="grid-column:1/-1;padding:40px 16px;text-align:center;color:var(--text-dim);font-size:13.5px;">اتصال به سرور برقرار نشد</div>`;
      handleApiError(err, "بارگذاری اکسپلور ناموفق بود");
    }
  }

  /* ------------------------------------------------------------ */
  /* Post fullscreen (open from explore or profile grid)           */
  /* ------------------------------------------------------------ */
  async function openPost(postId) {
    try {
      const post = await Posts.getById(postId);
      state.openPost = post;
      renderPostFull(post);
      $("#post-full").classList.add("active");
      loadComments(postId);
    } catch (err) {
      handleApiError(err, "بارگذاری پست ناموفق بود");
    }
  }

  function renderPostFull(post) {
    $("#pf-username").textContent = post.author?.username || "";
    $("#pf-avatar").style.backgroundImage = post.author?.avatarUrl ? `url('${post.author.avatarUrl}')` : "";
    $("#pf-media").style.backgroundImage = `url('${post.imageUrl}')`;
    $("#pf-caption").innerHTML = `<b>${escapeHtml(post.author?.username)}</b> ${escapeHtml(post.caption)}`;
    $("#pf-like-count").textContent = `${post.likeCount ?? 0} لایک`;
    $("#pf-like svg").classList.toggle("liked", !!post.likedByMe);
  }

  async function loadComments(postId) {
    const wrap = $("#pf-comments");
    wrap.innerHTML = `<div style="color:var(--text-dim);font-size:13px;padding:10px 0;">در حال بارگذاری کامنت‌ها...</div>`;
    try {
      const data = await Posts.getComments(postId);
      const comments = (data && data.comments) || [];
      wrap.innerHTML = comments.length ? comments.map(renderComment).join("") :
        `<div style="color:var(--text-dim);font-size:13px;padding:10px 0;">هنوز کامنتی نیست — اولین نفر باش</div>`;
    } catch (err) {
      wrap.innerHTML = `<div style="color:var(--text-dim);font-size:13px;padding:10px 0;">بارگذاری کامنت‌ها ناموفق بود</div>`;
    }
  }

  function renderComment(c) {
    return `
      <div class="comment-row">
        <div class="avatar-sm" style="background-image:url('${escapeHtml(c.author?.avatarUrl || "")}')"></div>
        <div>
          <div><b>${escapeHtml(c.author?.username)}</b> ${escapeHtml(c.text)}</div>
          <div style="color:var(--text-dim);font-size:11.5px;margin-top:2px;">${timeAgo(c.createdAt)}
            <button class="reply-btn" data-comment-id="${c.id}" style="background:none;border:none;color:var(--text-dim);cursor:pointer;margin-inline-start:8px;">پاسخ</button>
          </div>
          ${(c.replies || []).map((r) => `
            <div class="comment-reply">
              <b>${escapeHtml(r.author?.username)}</b> ${escapeHtml(r.text)}
            </div>
          `).join("")}
        </div>
      </div>`;
  }

  $("#pf-close").addEventListener("click", () => {
    $("#post-full").classList.remove("active");
    state.openPost = null;
  });

  $("#pf-like").addEventListener("click", async () => {
    if (!state.openPost) return;
    const svg = $("#pf-like svg");
    const wasLiked = svg.classList.contains("liked");
    try {
      if (wasLiked) {
        await Posts.unlike(state.openPost.id);
        svg.classList.remove("liked");
      } else {
        await Posts.like(state.openPost.id);
        svg.classList.add("liked");
      }
      const countEl = $("#pf-like-count");
      const current = parseInt(countEl.textContent) || 0;
      countEl.textContent = `${wasLiked ? current - 1 : current + 1} لایک`;
    } catch (err) {
      handleApiError(err, "ثبت لایک ناموفق بود");
    }
  });

  $("#pf-comment-focus").addEventListener("click", () => $("#pf-comment-input").focus());

  let replyTarget = null;
  $("#pf-comments").addEventListener("click", (e) => {
    if (e.target.classList.contains("reply-btn")) {
      replyTarget = e.target.dataset.commentId;
      $("#pf-comment-input").focus();
      toast("در حال پاسخ به کامنت...");
    }
  });

  async function submitComment() {
    const input = $("#pf-comment-input");
    const text = input.value.trim();
    if (!text || !state.openPost) return;
    try {
      const comment = await Posts.addComment(state.openPost.id, text, replyTarget);
      input.value = "";
      replyTarget = null;
      loadComments(state.openPost.id);
    } catch (err) {
      handleApiError(err, "ارسال کامنت ناموفق بود");
    }
  }
  $("#pf-comment-send").addEventListener("click", submitComment);
  $("#pf-comment-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitComment();
  });

  $("#pf-share").addEventListener("click", async () => {
    if (!state.openPost) return;
    const url = `${location.origin}${location.pathname}?post=${state.openPost.id}`;
    if (navigator.share) {
      try { await navigator.share({ url }); } catch {}
    } else {
      await navigator.clipboard.writeText(url);
      toast("لینک پست کپی شد");
    }
  });

  /* ------------------------------------------------------------ */
  /* Profile                                                        */
  /* ------------------------------------------------------------ */
  async function loadProfile() {
    try {
      const me = await Users.getMe();
      state.currentUser = me;
      renderProfileHeader(me);
      const postsData = await Posts.getUserPosts(me.id);
      renderProfileGrid((postsData && postsData.posts) || []);
    } catch (err) {
      $("#profile-name").textContent = "ورود لازم است";
      handleApiError(err, "بارگذاری پروفایل ناموفق بود");
    }
  }

  function renderProfileHeader(user) {
    $("#profile-name").textContent = user.displayName || user.username;
    $("#profile-bio").textContent = user.bio || "";
    $("#stat-posts").textContent = user.postCount ?? 0;
    $("#stat-followers").textContent = user.followerCount ?? 0;
    $("#stat-following").textContent = user.followingCount ?? 0;
    $("#profile-avatar").style.backgroundImage = user.avatarUrl ? `url('${user.avatarUrl}')` : "";
  }

  function renderProfileGrid(posts) {
    const grid = $("#profile-grid");
    if (!posts.length) {
      grid.innerHTML = `<div style="grid-column:1/-1;padding:30px 16px;text-align:center;color:var(--text-dim);font-size:13px;">هنوز پستی نداری — از تب آپلودر شروع کن</div>`;
      return;
    }
    grid.innerHTML = posts.map((p) => `
      <div class="cell" data-post-id="${p.id}" style="background-image:url('${escapeHtml(p.imageUrl)}')"></div>
    `).join("");
    grid.querySelectorAll(".cell").forEach((cell) => {
      cell.addEventListener("click", () => openPost(cell.dataset.postId));
    });
  }

  $("#btn-edit-bio").addEventListener("click", async () => {
    const current = state.currentUser?.bio || "";
    const next = prompt("بیوگرافی جدید:", current);
    if (next === null || next === current) return;
    try {
      const updated = await Users.updateProfile({ bio: next });
      state.currentUser = updated;
      renderProfileHeader(updated);
      toast("بیوگرافی به‌روزرسانی شد");
    } catch (err) {
      handleApiError(err, "به‌روزرسانی بیوگرافی ناموفق بود");
    }
  });

  $("#btn-edit-avatar").addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const updated = await Users.updateAvatar(file);
        state.currentUser = updated;
        renderProfileHeader(updated);
        toast("عکس پروفایل به‌روزرسانی شد");
      } catch (err) {
        handleApiError(err, "آپلود عکس پروفایل ناموفق بود");
      }
    };
    input.click();
  });

  $("#btn-share-profile").addEventListener("click", async () => {
    if (!state.currentUser) return;
    const url = `${location.origin}${location.pathname}?u=${state.currentUser.username}`;
    if (navigator.share) {
      try { await navigator.share({ url }); } catch {}
    } else {
      await navigator.clipboard.writeText(url);
      toast("لینک پروفایل کپی شد");
    }
  });

  /* ------------------------------------------------------------ */
  /* Uploader                                                       */
  /* ------------------------------------------------------------ */
  $("#uploader-box").addEventListener("click", () => $("#upload-input").click());

  $("#upload-input").addEventListener("change", () => {
    const file = $("#upload-input").files[0];
    if (!file) return;
    state.uploadFile = file;
    const url = URL.createObjectURL(file);
    $("#upload-preview-img").src = url;
    $("#upload-preview").style.display = "block";
    $("#upload-form").style.display = "flex";
    $("#uploader-box").style.display = "none";
  });

  $("#btn-submit-upload").addEventListener("click", async () => {
    if (!state.uploadFile) return;
    const caption = $("#upload-caption").value.trim();
    const hashtags = $("#upload-hashtags").value.trim().split(/\s+/).filter((h) => h.startsWith("#"));
    const btn = $("#btn-submit-upload");
    btn.disabled = true;
    btn.textContent = "در حال انتشار...";
    try {
      await Posts.create({ imageFile: state.uploadFile, caption, hashtags });
      toast("پست منتشر شد");
      resetUploadForm();
      switchView("profile");
    } catch (err) {
      handleApiError(err, "انتشار پست ناموفق بود");
    } finally {
      btn.disabled = false;
      btn.textContent = "انتشار پست";
    }
  });

  function resetUploadForm() {
    state.uploadFile = null;
    $("#upload-input").value = "";
    $("#upload-caption").value = "";
    $("#upload-hashtags").value = "";
    $("#upload-preview").style.display = "none";
    $("#upload-form").style.display = "none";
    $("#uploader-box").style.display = "block";
  }

  /* ------------------------------------------------------------ */
  /* Stories                                                        */
  /* ------------------------------------------------------------ */
  async function loadStoryRail() {
    const rail = $("#story-rail");
    try {
      const data = await Stories.getFeed();
      const groups = (data && data.storyGroups) || [];

      const selfHtml = `
        <div class="story-item" id="story-add">
          <div class="story-ring self story-add-badge">
            <div class="story-avatar" id="story-self-avatar"></div>
          </div>
          <span>استوری من</span>
        </div>`;

      const othersHtml = groups.map((g) => `
        <div class="story-item" data-user-id="${g.user.id}">
          <div class="story-ring ${g.seen ? "seen" : ""}">
            <div class="story-avatar" style="background-image:url('${escapeHtml(g.user.avatarUrl || "")}')"></div>
          </div>
          <span>${escapeHtml(g.user.username)}</span>
        </div>
      `).join("");

      rail.innerHTML = selfHtml + othersHtml;

      $("#story-add").addEventListener("click", handleStoryAddClick);
      rail.querySelectorAll(".story-item[data-user-id]").forEach((item) => {
        item.addEventListener("click", () => viewStoryGroup(item.dataset.userId));
      });
    } catch (err) {
      rail.innerHTML = "";
    }
  }

  function handleStoryAddClick() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,video/*";
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        await Stories.upload(file);
        toast("استوری منتشر شد");
        loadStoryRail();
      } catch (err) {
        handleApiError(err, "انتشار استوری ناموفق بود");
      }
    };
    input.click();
  }

  function viewStoryGroup(userId) {
    // بازکردن نمای تمام‌صفحه‌ی استوری (پیاده‌سازی نمایش/لایک/بازدید در تکمیل بعدی)
    toast("نمایش استوری — در حال تکمیل");
  }

  /* ------------------------------------------------------------ */
  /* Search & Chat (top bar)                                        */
  /* ------------------------------------------------------------ */
  $("#btn-search").addEventListener("click", () => {
    const q = prompt("جستجوی کاربر:");
    if (!q) return;
    Users.search(q)
      .then((data) => {
        const results = (data && data.users) || [];
        toast(results.length ? `${results.length} کاربر پیدا شد` : "نتیجه‌ای پیدا نشد");
      })
      .catch((err) => handleApiError(err, "جستجو ناموفق بود"));
  });

  $("#btn-chat").addEventListener("click", () => {
    toast("لیست گفتگوها — در حال تکمیل");
  });

  /* ------------------------------------------------------------ */
  /* Live                                                           */
  /* ------------------------------------------------------------ */
  $("#btn-live").addEventListener("click", async () => {
    if (!confirm("لایو رو شروع می‌کنی؟ به همه‌ی فالوورهات اعلان میره.")) return;
    try {
      const session = await Live.start("لایو " + new Date().toLocaleTimeString("fa-IR"));
      await Live.notifyFollowers(session.id);
      toast("لایو شروع شد");
    } catch (err) {
      handleApiError(err, "شروع لایو ناموفق بود");
    }
  });

  /* ------------------------------------------------------------ */
  /* Realtime events                                                */
  /* ------------------------------------------------------------ */
  Realtime.on("new_message", () => $("#chat-badge").hidden = false);
  Realtime.on("new_comment", (payload) => {
    if (state.openPost && payload.postId === state.openPost.id) {
      loadComments(state.openPost.id);
    }
  });

  /* ------------------------------------------------------------ */
  /* Init                                                           */
  /* ------------------------------------------------------------ */
  async function init() {
    if (Auth.isAuthenticated()) {
      Realtime.connect();
    }
    loadStoryRail();
    switchView("explore");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
