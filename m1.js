/**
 * m1.js — لایه ارتباط واقعی با سرور (API Client)
 * ------------------------------------------------------------
 * این فایل مسئول تمام درخواست‌های واقعی HTTP بین مرورگر و بک‌اند است.
 * خودِ این فایل یک سرور نیست — در مرورگر اجرا می‌شود و با fetch()
 * به یک بک‌اند واقعی (Node.js/Express یا هر سرویس دیگر) وصل می‌شود.
 *
 * قبل از استفاده باید:
 *   1) یک بک‌اند واقعی با همین مسیرها (endpoints) بالا بیاد
 *   2) API_BASE_URL پایین رو به آدرس همون سرور تنظیم کنی
 *
 * تا وقتی سرور واقعی وصل نشده، درخواست‌ها با خطای شبکه fail می‌شوند —
 * این عمدی است؛ این فایل هیچ داده‌ی ساختگی (mock) برنمی‌گرداند.
 */

const API_BASE_URL = window.BAMGRAM_API_BASE_URL || "https://api.bamgram.example.com/v1";

/* ------------------------------------------------------------------ */
/* Token storage (in-memory + fallback)                                */
/* ------------------------------------------------------------------ */
const TokenStore = (() => {
  let accessToken = null;
  let refreshToken = null;

  return {
    set(access, refresh) {
      accessToken = access || accessToken;
      refreshToken = refresh || refreshToken;
    },
    getAccess() { return accessToken; },
    getRefresh() { return refreshToken; },
    clear() { accessToken = null; refreshToken = null; },
    isAuthenticated() { return !!accessToken; }
  };
})();

/* ------------------------------------------------------------------ */
/* Core request helper                                                 */
/* ------------------------------------------------------------------ */
class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function apiRequest(path, { method = "GET", body = null, isFormData = false, auth = true, retry = true } = {}) {
  const headers = {};
  if (!isFormData) headers["Content-Type"] = "application/json";
  if (auth && TokenStore.getAccess()) {
    headers["Authorization"] = `Bearer ${TokenStore.getAccess()}`;
  }

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body ? (isFormData ? body : JSON.stringify(body)) : undefined,
      credentials: "include"
    });
  } catch (networkErr) {
    throw new ApiError("خطای شبکه: سرور در دسترس نیست", 0, null);
  }

  // Access token expired -> try refresh once
  if (response.status === 401 && retry && TokenStore.getRefresh()) {
    const refreshed = await Auth.refresh();
    if (refreshed) {
      return apiRequest(path, { method, body, isFormData, auth, retry: false });
    }
  }

  let payload = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    payload = await response.json().catch(() => null);
  }

  if (!response.ok) {
    const message = (payload && payload.message) || `خطای سرور (${response.status})`;
    throw new ApiError(message, response.status, payload);
  }

  return payload;
}

/* ------------------------------------------------------------------ */
/* Auth                                                                 */
/* ------------------------------------------------------------------ */
const Auth = {
  async register({ username, email, password, displayName }) {
    const data = await apiRequest("/auth/register", {
      method: "POST",
      auth: false,
      body: { username, email, password, displayName }
    });
    if (data?.accessToken) TokenStore.set(data.accessToken, data.refreshToken);
    return data;
  },

  async login({ identifier, password }) {
    const data = await apiRequest("/auth/login", {
      method: "POST",
      auth: false,
      body: { identifier, password }
    });
    if (data?.accessToken) TokenStore.set(data.accessToken, data.refreshToken);
    return data;
  },

  async refresh() {
    try {
      const data = await apiRequest("/auth/refresh", {
        method: "POST",
        auth: false,
        retry: false,
        body: { refreshToken: TokenStore.getRefresh() }
      });
      if (data?.accessToken) {
        TokenStore.set(data.accessToken, data.refreshToken);
        return true;
      }
      return false;
    } catch {
      TokenStore.clear();
      return false;
    }
  },

  async logout() {
    try {
      await apiRequest("/auth/logout", { method: "POST" });
    } finally {
      TokenStore.clear();
    }
  },

  isAuthenticated() {
    return TokenStore.isAuthenticated();
  }
};

/* ------------------------------------------------------------------ */
/* Users / Profile                                                     */
/* ------------------------------------------------------------------ */
const Users = {
  getMe() {
    return apiRequest("/users/me");
  },
  getByUsername(username) {
    return apiRequest(`/users/${encodeURIComponent(username)}`);
  },
  updateProfile({ displayName, bio }) {
    return apiRequest("/users/me", {
      method: "PATCH",
      body: { displayName, bio }
    });
  },
  async updateAvatar(file) {
    const form = new FormData();
    form.append("avatar", file);
    return apiRequest("/users/me/avatar", {
      method: "POST",
      isFormData: true,
      body: form
    });
  },
  follow(userId) {
    return apiRequest(`/users/${userId}/follow`, { method: "POST" });
  },
  unfollow(userId) {
    return apiRequest(`/users/${userId}/follow`, { method: "DELETE" });
  },
  getFollowers(userId, cursor = null) {
    return apiRequest(`/users/${userId}/followers${cursor ? `?cursor=${cursor}` : ""}`);
  },
  getFollowing(userId, cursor = null) {
    return apiRequest(`/users/${userId}/following${cursor ? `?cursor=${cursor}` : ""}`);
  },
  search(query) {
    return apiRequest(`/users/search?q=${encodeURIComponent(query)}`);
  }
};

/* ------------------------------------------------------------------ */
/* Posts                                                                */
/* ------------------------------------------------------------------ */
const Posts = {
  getExploreFeed(cursor = null) {
    return apiRequest(`/posts/explore${cursor ? `?cursor=${cursor}` : ""}`);
  },
  getUserPosts(userId, cursor = null) {
    return apiRequest(`/users/${userId}/posts${cursor ? `?cursor=${cursor}` : ""}`);
  },
  getById(postId) {
    return apiRequest(`/posts/${postId}`);
  },
  async create({ imageFile, caption, hashtags }) {
    const form = new FormData();
    form.append("image", imageFile);
    form.append("caption", caption || "");
    form.append("hashtags", JSON.stringify(hashtags || []));
    return apiRequest("/posts", {
      method: "POST",
      isFormData: true,
      body: form
    });
  },
  delete(postId) {
    return apiRequest(`/posts/${postId}`, { method: "DELETE" });
  },
  like(postId) {
    return apiRequest(`/posts/${postId}/like`, { method: "POST" });
  },
  unlike(postId) {
    return apiRequest(`/posts/${postId}/like`, { method: "DELETE" });
  },
  getComments(postId, cursor = null) {
    return apiRequest(`/posts/${postId}/comments${cursor ? `?cursor=${cursor}` : ""}`);
  },
  addComment(postId, text, replyToCommentId = null) {
    return apiRequest(`/posts/${postId}/comments`, {
      method: "POST",
      body: { text, replyToCommentId }
    });
  }
};

/* ------------------------------------------------------------------ */
/* Stories                                                              */
/* ------------------------------------------------------------------ */
const Stories = {
  getFeed() {
    return apiRequest("/stories/feed");
  },
  getMine() {
    return apiRequest("/stories/me");
  },
  async upload(mediaFile) {
    const form = new FormData();
    form.append("media", mediaFile);
    return apiRequest("/stories", {
      method: "POST",
      isFormData: true,
      body: form
    });
  },
  markViewed(storyId) {
    return apiRequest(`/stories/${storyId}/view`, { method: "POST" });
  },
  getInsights(storyId) {
    // بازدید و لایک استوری خودم
    return apiRequest(`/stories/${storyId}/insights`);
  },
  like(storyId) {
    return apiRequest(`/stories/${storyId}/like`, { method: "POST" });
  }
};

/* ------------------------------------------------------------------ */
/* Direct messages                                                      */
/* ------------------------------------------------------------------ */
const Messages = {
  getConversations() {
    return apiRequest("/messages/conversations");
  },
  getThread(userId, cursor = null) {
    return apiRequest(`/messages/thread/${userId}${cursor ? `?cursor=${cursor}` : ""}`);
  },
  send(userId, text) {
    return apiRequest(`/messages/thread/${userId}`, {
      method: "POST",
      body: { text }
    });
  }
};

/* ------------------------------------------------------------------ */
/* Live streaming                                                       */
/* ------------------------------------------------------------------ */
const Live = {
  // شروع لایو: سرور یک stream key / RTMP یا WebRTC session برمی‌گرداند
  start(title) {
    return apiRequest("/live/start", { method: "POST", body: { title } });
  },
  stop(sessionId) {
    return apiRequest(`/live/${sessionId}/stop`, { method: "POST" });
  },
  getActive() {
    // لایوهای فعال از افرادی که فالو می‌کنم
    return apiRequest("/live/active");
  },
  notifyFollowers(sessionId) {
    return apiRequest(`/live/${sessionId}/notify`, { method: "POST" });
  }
};

/* ------------------------------------------------------------------ */
/* Realtime channel (WebSocket) — برای پیام، اعلان لایو، لایک/کامنت زنده */
/* ------------------------------------------------------------------ */
const Realtime = (() => {
  let socket = null;
  const listeners = {};

  function connect() {
    if (socket && socket.readyState === WebSocket.OPEN) return;
    const wsUrl = API_BASE_URL.replace(/^http/, "ws") + `/realtime?token=${TokenStore.getAccess() || ""}`;
    socket = new WebSocket(wsUrl);

    socket.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      const handlers = listeners[msg.type] || [];
      handlers.forEach((fn) => fn(msg.payload));
    });

    socket.addEventListener("close", () => {
      // تلاش مجدد برای اتصال بعد از قطعی
      setTimeout(connect, 3000);
    });
  }

  function on(eventType, handler) {
    if (!listeners[eventType]) listeners[eventType] = [];
    listeners[eventType].push(handler);
  }

  function off(eventType, handler) {
    if (!listeners[eventType]) return;
    listeners[eventType] = listeners[eventType].filter((fn) => fn !== handler);
  }

  function send(eventType, payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: eventType, payload }));
    }
  }

  return { connect, on, off, send };
})();

/* ------------------------------------------------------------------ */
/* Export — در دسترس m2.js قرار می‌گیرد                                */
/* ------------------------------------------------------------------ */
window.BamgramAPI = {
  ApiError,
  TokenStore,
  Auth,
  Users,
  Posts,
  Stories,
  Messages,
  Live,
  Realtime
};
