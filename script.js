// ============================================
// script.js - نسخه نهایی با تمام قابلیت‌ها
// ============================================

const socket = io({
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: 20,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 15000
});

let currentUser = null;
let currentChatUser = null;
let viewingProfileId = null;
let viewingProfileFollowing = false;
let pendingMedia = null;
let pendingMediaType = null;
let scheduledMediaFiles = [];
let isAdmin = false;
let adminPanelOpen = false;
let chatListCache = [];
let messagesCache = {};

// ============================================
// احراز هویت - ثبت‌نام و ورود
// ============================================
function showRegisterModal() {
  document.getElementById('registerModal').style.display = 'flex';
  document.getElementById('regAvatarInput').addEventListener('change', function(e) {
    readFileAsBase64(e.target.files[0], (b64) => {
      document.getElementById('regAvatarPreview').src = b64;
    });
  });
}

async function registerUser() {
  const email = document.getElementById('regEmailInput').value.trim();
  const password = document.getElementById('regPasswordInput').value.trim();
  const name = document.getElementById('regNameInput').value.trim();
  const avatar = document.getElementById('regAvatarPreview').src;

  if (!email) { showNotification('ایمیل خود را وارد کنید'); return; }
  if (!password || password.length < 6) { showNotification('رمز عبور حداقل ۶ کاراکتر'); return; }
  if (!name) { showNotification('نام نمایشی خود را وارد کنید'); return; }

  try {
    const res = await fetch('/api/user/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name, avatar })
    });
    const data = await res.json();
    if (data.success) {
      currentUser = data.user;
      localStorage.setItem('yareman_user_id', currentUser.id);
      document.getElementById('registerModal').style.display = 'none';
      
      if (currentUser.id === 'admin_milad') {
        isAdmin = true;
        document.getElementById('adminBtn').classList.add('show');
      }
      
      afterLogin();
      showNotification('✨ خوش آمدی ' + currentUser.name);
    } else {
      showNotification('خطا: ' + data.error);
    }
  } catch (e) {
    showNotification('خطا در ارتباط با سرور');
    console.error(e);
  }
}

async function initApp() {
  const savedId = localStorage.getItem('yareman_user_id');
  if (savedId) {
    try {
      const res = await fetch(`/api/user/${savedId}`);
      if (res.ok) {
        currentUser = await res.json();
        if (currentUser.id === 'admin_milad') {
          isAdmin = true;
          document.getElementById('adminBtn').classList.add('show');
        }
        afterLogin();
        return;
      }
    } catch (e) {}
  }
  showRegisterModal();
}

function afterLogin() {
  document.getElementById('userName').textContent = currentUser.name;
  document.getElementById('avatarImg').src = currentUser.avatar || defaultAvatar(currentUser.name);
  document.getElementById('userScore').textContent = `🏆 ${formatNumber(currentUser.score || 0)}`;
  socket.emit('join', currentUser.id);
  setupNav();
  loadPageData('channel');
  
  socket.on('broadcast', (data) => {
    showNotification(`📢 ${data.title || 'اعلان'}: ${data.message}`);
  });
  
  socket.on('message_sent', (data) => { /* پیام ارسال شد */ });
  socket.on('new_message', handleNewMessage);
  socket.on('user_typing', (data) => { /* نمایش تایپ */ });
}

// ============================================
// توابع کمکی
// ============================================
function defaultAvatar(seed) {
  return `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(seed || 'user')}`;
}

function readFileAsBase64(file, cb) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => cb(e.target.result);
  reader.readAsDataURL(file);
}

function escapeHtml(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = (Date.now() - new Date(dateStr + 'Z').getTime()) / 1000;
  if (diff < 60) return 'همین الان';
  if (diff < 3600) return Math.floor(diff / 60) + ' دقیقه پیش';
  if (diff < 86400) return Math.floor(diff / 3600) + ' ساعت پیش';
  if (diff < 2592000) return Math.floor(diff / 86400) + ' روز پیش';
  return new Date(dateStr).toLocaleDateString('fa-IR');
}

function showNotification(text, type = 'info') {
  const n = document.createElement('div');
  n.className = 'notification';
  n.innerHTML = text;
  document.body.appendChild(n);
  setTimeout(() => {
    n.style.opacity = '0';
    n.style.transform = 'translate(-50%, -20px)';
    setTimeout(() => n.remove(), 300);
  }, 3500);
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num;
}

function closeModal() {
  const m = document.querySelector('.modal');
  if (m) m.remove();
}

function debounce(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

// ============================================
// ناوبری
// ============================================
function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      const pageId = this.dataset.page + 'Page';
      const page = document.getElementById(pageId);
      if (page) page.classList.add('active');
      loadPageData(this.dataset.page);
    });
  });
}

async function loadPageData(page) {
  switch (page) {
    case 'channel': await loadChannelPosts(); break;
    case 'assistant': await loadAssistantData(); break;
    case 'chat': await loadChatList(); break;
    case 'explore': await loadExplore(); break;
  }
}

// ============================================
// پروفایل
// ============================================
document.getElementById('profileBtn').addEventListener('click', showProfileModal);

async function showProfileModal() {
  try {
    const res = await fetch(`/api/user/${currentUser.id}`);
    currentUser = { ...currentUser, ...(await res.json()) };
  } catch (e) {}

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(12px);padding:16px;';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:2px solid var(--border-color);padding:28px;border-radius:var(--radius-lg);max-width:400px;width:100%;text-align:center;box-shadow:var(--shadow-3d);">
      <div style="position:relative;width:96px;height:96px;margin:0 auto 12px;">
        <img id="myAvatarPreview" src="${currentUser.avatar || defaultAvatar(currentUser.name)}" style="width:96px;height:96px;border-radius:50%;border:3px solid transparent;background-image:var(--gradient-main);padding:3px;">
        <label style="position:absolute;bottom:0;left:0;width:32px;height:32px;background:var(--gradient-main);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;color:#fff;cursor:pointer;border:2px solid var(--bg-primary);"><i class="fas fa-camera"></i><input type="file" id="myAvatarInput" accept="image/*" style="display:none;"></label>
      </div>
      <h3 style="font-size:20px;">${escapeHtml(currentUser.name)}</h3>
      ${currentUser.bio ? `<p style="color:var(--text-secondary);font-size:14px;">${escapeHtml(currentUser.bio)}</p>` : ''}
      <div style="display:flex;justify-content:center;gap:24px;margin:12px 0;">
        <div><b style="font-size:18px;">${formatNumber(currentUser.followers || 0)}</b><span style="font-size:12px;color:var(--text-muted);display:block;">فالوور</span></div>
        <div><b style="font-size:18px;">${formatNumber(currentUser.score || 0)}</b><span style="font-size:12px;color:var(--text-muted);display:block;">امتیاز</span></div>
      </div>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
        <button class="btn btn-secondary" onclick="document.querySelector('[data-page=assistant]').click(); closeModal();">🤖 مدیریت دستیار</button>
        <button class="btn btn-glass" onclick="closeModal()">بستن</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById('myAvatarInput').addEventListener('change', function(e) {
    readFileAsBase64(e.target.files[0], async (b64) => {
      document.getElementById('myAvatarPreview').src = b64;
      document.getElementById('avatarImg').src = b64;
      currentUser.avatar = b64;
      await fetch('/api/user/avatar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id, avatar: b64 })
      });
      showNotification('✅ عکس پروفایل به‌روز شد');
    });
  });
}

// ============================================
// پست‌ها
// ============================================
document.getElementById('postImageInput').addEventListener('change', function(e) {
  handleMediaFile(e.target.files[0], 'image');
});
document.getElementById('postVideoInput').addEventListener('change', function(e) {
  handleMediaFile(e.target.files[0], 'video');
});

function handleMediaFile(file, type) {
  if (!file) return;
  readFileAsBase64(file, (b64) => {
    pendingMedia = b64;
    pendingMediaType = type;
    showMediaPreview(b64, type);
  });
}

function showMediaPreview(b64, type) {
  const container = document.getElementById('mediaPreview');
  const content = document.getElementById('mediaPreviewContent');
  if (!container || !content) return;
  container.style.display = 'block';
  if (type === 'video') {
    content.innerHTML = `<video src="${b64}" controls></video>`;
  } else {
    content.innerHTML = `<img src="${b64}">`;
  }
}

function removeMedia() {
  pendingMedia = null;
  pendingMediaType = null;
  const container = document.getElementById('mediaPreview');
  const content = document.getElementById('mediaPreviewContent');
  if (container) container.style.display = 'none';
  if (content) content.innerHTML = '';
  document.getElementById('postImageInput').value = '';
  document.getElementById('postVideoInput').value = '';
}

async function createPost() {
  const content = document.getElementById('postContent').value.trim();
  if (!content) { showNotification('یه متنی برای پست بنویس!'); return; }

  try {
    const res = await fetch('/api/post/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: currentUser.id,
        content,
        mediaUrl: pendingMedia,
        mediaType: pendingMediaType || 'none'
      })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('postContent').value = '';
      removeMedia();
      showNotification('✅ پست منتشر شد');
      if (data.boost) updateBoostBadge(data.boost.boostLevel);
      await loadChannelPosts();
    } else {
      showNotification('خطا: ' + data.error);
    }
  } catch (e) { showNotification('خطا در ارتباط با سرور'); }
}

async function loadChannelPosts() {
  try {
    const res = await fetch(`/api/channel/${currentUser.id}`);
    const posts = await res.json();
    const container = document.getElementById('channelPosts');
    if (!container) return;
    
    container.innerHTML = posts.length ? 
      posts.map(p => renderPostCard(p, currentUser)).join('') :
      `<div class="empty-state" style="text-align:center;color:var(--text-muted);padding:40px 10px;">
        <i class="fas fa-pen-fancy" style="font-size:32px;display:block;margin-bottom:8px;opacity:0.5;"></i>
        هنوز پستی منتشر نکردی.<br>اولین پستت رو بنویس! ✍️
      </div>`;

    const ures = await fetch(`/api/user/${currentUser.id}`);
    const u = await ures.json();
    document.getElementById('followersCount').textContent = `${formatNumber(u.followers || 0)} فالوور`;
  } catch (e) { console.error(e); }
}

function renderPostCard(post, author) {
  const name = author?.name || post.channel_name || 'کاربر';
  const avatar = author?.avatar || defaultAvatar(name);
  const mediaHtml = post.media_url ? `
    <div class="media-wrapper">
      ${post.media_type === 'video' ? 
        `<video src="${post.media_url}" controls preload="metadata"></video>` : 
        `<img src="${post.media_url}" loading="lazy">`}
    </div>` : '';
  
  return `
  <div class="post-card" data-post-id="${post.id}">
    <div class="post-head" onclick="openProfile('${post.user_id || currentUser.id}')">
      <img src="${avatar}" loading="lazy">
      <span class="name">${escapeHtml(name)}</span>
      <span class="time">${timeAgo(post.created_at)}</span>
    </div>
    <p class="content">${escapeHtml(post.content)}</p>
    ${mediaHtml}
    <div class="post-stats">
      <button onclick="toggleLike('${post.id}', this)" class="like-btn">
        <i class="far fa-heart"></i> <span class="like-count">${formatNumber(post.likes || 0)}</span>
      </button>
      <button onclick="toggleComments('${post.id}', this)">
        <i class="far fa-comment"></i> <span class="comment-count">${formatNumber(post.comments || 0)}</span>
      </button>
      <button onclick="sharePost('${post.id}')">
        <i class="fas fa-share-alt"></i> اشتراک‌گذاری
      </button>
      <button disabled>
        <i class="far fa-eye"></i> ${formatNumber(post.views || 0)}
      </button>
    </div>
    <div class="comments-box" id="comments-${post.id}" style="display:none;margin-top:10px;border-top:2px solid var(--border-color);padding-top:10px;"></div>
  </div>`;
}

function sharePost(postId) {
  const url = `${window.location.origin}?post=${postId}`;
  if (navigator.share) {
    navigator.share({ title: 'یارِ من', text: 'این پست رو ببین!', url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(url).then(() => {
      showNotification('📋 لینک کپی شد!');
    }).catch(() => {
      showNotification('📋 لینک: ' + url);
    });
  }
}

async function toggleLike(postId, btn) {
  try {
    const res = await fetch(`/api/post/${postId}/like`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id })
    });
    const data = await res.json();
    if (data.success) {
      btn.classList.toggle('liked', data.liked);
      btn.querySelector('i').className = data.liked ? 'fas fa-heart' : 'far fa-heart';
      btn.querySelector('.like-count').textContent = formatNumber(data.likes);
    }
  } catch (e) { showNotification('خطا'); }
}

async function toggleComments(postId, btn) {
  const box = document.getElementById(`comments-${postId}`);
  if (!box) return;
  box.style.display = box.style.display === 'block' ? 'none' : 'block';
  if (box.style.display === 'block' && !box.dataset.loaded) {
    box.dataset.loaded = '1';
    try {
      const res = await fetch(`/api/post/${postId}/comments`);
      const comments = await res.json();
      box.innerHTML = (comments.map(c => `
        <div class="comment-item" style="display:flex;gap:10px;margin-bottom:8px;font-size:14px;align-items:flex-start;">
          <img src="${c.avatar || defaultAvatar(c.name)}" style="width:32px;height:32px;border-radius:50%;flex-shrink:0;">
          <div>
            <b style="font-size:13px;">${escapeHtml(c.name)}</b>
            <span style="color:var(--text-secondary);display:block;">${escapeHtml(c.text)}</span>
          </div>
        </div>
      `).join('') || '') + `
        <div class="comment-form" style="display:flex;gap:8px;margin-top:10px;">
          <input type="text" id="commentInput-${postId}" placeholder="کامنت بنویس..." style="flex:1;background:var(--bg-secondary);border:2px solid var(--border-color);border-radius:var(--radius-full);padding:10px 16px;color:var(--text-primary);outline:none;font-size:14px;">
          <button class="btn btn-secondary" onclick="submitComment('${postId}')" style="min-height:44px;padding:8px 18px;">ارسال</button>
        </div>`;
    } catch (e) { showNotification('خطا'); }
  }
}

async function submitComment(postId) {
  const input = document.getElementById(`commentInput-${postId}`);
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  try {
    const res = await fetch(`/api/post/${postId}/comment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, text })
    });
    const data = await res.json();
    if (data.success) {
      input.value = '';
      const box = document.getElementById(`comments-${postId}`);
      if (!box) return;
      const form = box.querySelector('.comment-form');
      const item = document.createElement('div');
      item.className = 'comment-item';
      item.style.cssText = 'display:flex;gap:10px;margin-bottom:8px;font-size:14px;align-items:flex-start;';
      item.innerHTML = `
        <img src="${data.comment.avatar || defaultAvatar(data.comment.name)}" style="width:32px;height:32px;border-radius:50%;flex-shrink:0;">
        <div>
          <b style="font-size:13px;">${escapeHtml(data.comment.name)}</b>
          <span style="color:var(--text-secondary);display:block;">${escapeHtml(data.comment.text)}</span>
        </div>`;
      box.insertBefore(item, form);
      const card = document.querySelector(`[data-post-id="${postId}"] .comment-count`);
      if (card) card.textContent = formatNumber(parseInt(card.textContent.replace(/,/g, '')) + 1);
    }
  } catch (e) { showNotification('خطا'); }
}

// ============================================
// دستیار
// ============================================
async function loadAssistantData() {
  try {
    const res = await fetch(`/api/assistant/${currentUser.id}`);
    const data = await res.json();

    document.getElementById('statPosts').textContent = formatNumber(data.stats?.totalPosts ?? 0);
    document.getElementById('statTrainings').textContent = formatNumber(data.stats?.totalTrainings ?? 0);
    document.getElementById('statFollowers').textContent = formatNumber(data.stats?.followers ?? 0);
    document.getElementById('statEngagement').textContent = data.stats?.engagementRate ?? '0%';

    document.getElementById('qaList').innerHTML = data.qa?.length ? data.qa.map(q => `
      <div class="qa-item" style="background:var(--bg-secondary);border:2px solid var(--border-color);border-radius:var(--radius-sm);padding:8px 14px;font-size:13px;">
        <span style="color:var(--text-secondary);">❓ ${escapeHtml(q.question)}</span>
        <span style="display:block;">💬 ${escapeHtml(q.answer)}</span>
      </div>
    `).join('') : '<p style="color:var(--text-muted);text-align:center;padding:10px;">هنوز آموزشی ثبت نشده.</p>';

    document.getElementById('keywordList').innerHTML = data.keywords?.length ? data.keywords.map(k => `
      <div class="keyword-item" style="background:var(--bg-secondary);border:2px solid var(--border-color);border-radius:var(--radius-sm);padding:8px 14px;font-size:13px;">
        <span style="color:var(--text-secondary);">🔑 ${escapeHtml(k.keyword)}</span>
        <span style="display:block;">💬 ${escapeHtml(k.response)}</span>
      </div>
    `).join('') : '<p style="color:var(--text-muted);text-align:center;padding:10px;">هنوز کلمه کلیدی ثبت نشده.</p>';

    if (data.posts?.length) {
      document.getElementById('scheduledPostsList').innerHTML = data.posts.map(p => `
        <div style="font-size:13px;color:var(--text-secondary);padding:8px 0;border-bottom:2px solid var(--border-color);display:flex;justify-content:space-between;align-items:center;">
          <span>📅 ${escapeHtml(p.content?.substring(0, 40) || '')}...</span>
          <span style="font-size:11px;color:var(--text-muted);">${new Date(p.scheduled_time).toLocaleString('fa-IR')}</span>
        </div>
      `).join('');
    }
  } catch (e) { console.error(e); }
}

async function trainAssistant() {
  const question = document.getElementById('questionInput').value.trim();
  const answer = document.getElementById('answerInput').value.trim();
  if (!question || !answer) { showNotification('سوال و جواب رو کامل کن!'); return; }

  try {
    const res = await fetch('/api/assistant/train', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, question, answer })
    });
    const data = await res.json();
    if (data.success) {
      showNotification('✅ دستیار یاد گرفت');
      document.getElementById('questionInput').value = '';
      document.getElementById('answerInput').value = '';
      if (data.boost) updateBoostBadge(data.boost.boostLevel);
      await loadAssistantData();
    }
  } catch (e) { showNotification('خطا'); }
}

async function trainKeyword() {
  const keyword = document.getElementById('keywordInput').value.trim();
  const response = document.getElementById('keywordResponseInput').value.trim();
  if (!keyword || !response) { showNotification('کلمه کلیدی و پاسخ رو کامل کن!'); return; }

  try {
    const res = await fetch('/api/assistant/keyword', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, keyword, response })
    });
    const data = await res.json();
    if (data.success) {
      showNotification('✅ کلمه کلیدی ثبت شد');
      document.getElementById('keywordInput').value = '';
      document.getElementById('keywordResponseInput').value = '';
      if (data.boost) updateBoostBadge(data.boost.boostLevel);
      await loadAssistantData();
    }
  } catch (e) { showNotification('خطا'); }
}

function toggleAutoPost() {
  const panel = document.getElementById('autoPostPanel');
  if (panel) {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  }
}

async function testAssistant() {
  const input = document.getElementById('assistantPreviewInput');
  const msg = input.value.trim();
  if (!msg) return;
  appendMiniMsg('assistantPreviewChat', msg, 'me');
  input.value = '';

  try {
    const res = await fetch(`/api/assistant/chat/${currentUser.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    });
    const data = await res.json();
    appendMiniMsg('assistantPreviewChat', data.reply || 'دستیار هنوز جوابی نداره 🤖', 'bot');
  } catch (e) { showNotification('خطا'); }
}

function appendMiniMsg(containerId, text, who) {
  const c = document.getElementById(containerId);
  if (!c) return;
  const div = document.createElement('div');
  div.className = 'mini-msg ' + who;
  div.style.cssText = `padding:8px 14px;border-radius:14px;font-size:13px;max-width:85%;word-wrap:break-word;${who === 'me' ? 'align-self:flex-end;background:var(--gradient-main);color:#fff;border-bottom-right-radius:4px;' : 'align-self:flex-start;background:var(--bg-secondary);border:2px solid var(--border-color);border-bottom-left-radius:4px;'}`;
  div.textContent = text;
  c.appendChild(div);
  c.scrollTop = c.scrollHeight;
}

function updateBoostBadge(level) {
  const badge = document.getElementById('boostBadge');
  if (!badge) return;
  const labels = { normal: 'عادی', high: '🔥 داغ', viral: '🚀 وایرال', superstar: '⭐ ستاره' };
  badge.textContent = labels[level] || 'عادی';
  badge.style.background = level === 'superstar' ? 'var(--gradient-main)' : 'var(--bg-secondary)';
  badge.style.color = level === 'superstar' ? '#fff' : 'var(--text-secondary)';
  badge.style.borderColor = level === 'superstar' ? 'transparent' : 'var(--border-color)';
}

// ============================================
// زمان‌بندی پست‌ها
// ============================================
document.getElementById('scheduleImages').addEventListener('change', function(e) {
  for (const file of e.target.files) {
    readFileAsBase64(file, (b64) => {
      scheduledMediaFiles.push({ data: b64, type: 'image' });
    });
  }
});
document.getElementById('scheduleVideos').addEventListener('change', function(e) {
  for (const file of e.target.files) {
    readFileAsBase64(file, (b64) => {
      scheduledMediaFiles.push({ data: b64, type: 'video' });
    });
  }
});

async function schedulePosts() {
  const count = parseInt(document.getElementById('postCount').value);
  const descriptions = document.getElementById('postDescriptions').value.split('\n').filter(s => s.trim());
  const time = document.getElementById('postTime').value;
  const interval = parseInt(document.getElementById('postInterval').value) || 1;

  if (!count || count < 1) { showNotification('تعداد پست‌ها رو مشخص کن!'); return; }
  if (descriptions.length < count) { showNotification(`حداقل ${count} توضیح وارد کن.`); return; }

  const posts = [];
  const baseDate = new Date();
  const [hours, minutes] = time.split(':').map(Number);
  baseDate.setHours(hours || 9, minutes || 0, 0, 0);

  for (let i = 0; i < count; i++) {
    const postDate = new Date(baseDate);
    postDate.setDate(postDate.getDate() + (i * interval));
    const media = scheduledMediaFiles[i] || null;
    posts.push({
      content: descriptions[i] || `پست شماره ${i + 1}`,
      scheduledTime: postDate.toISOString(),
      mediaUrl: media ? media.data : null,
      mediaType: media ? media.type : 'none'
    });
  }

  try {
    const res = await fetch('/api/assistant/schedule', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, posts })
    });
    const data = await res.json();
    if (data.success) {
      showNotification(`✅ ${count} پست زمان‌بندی شد`);
      scheduledMediaFiles = [];
      document.getElementById('scheduleImages').value = '';
      document.getElementById('scheduleVideos').value = '';
      await loadAssistantData();
    } else {
      showNotification('خطا: ' + data.error);
    }
  } catch (e) { showNotification('خطا در ارتباط با سرور'); }
}

// ============================================
// اکسپلور - نمایش پست‌ها به صورت گرید
// ============================================
async function loadExplore() {
  try {
    const res = await fetch('/api/explore');
    const items = await res.json();
    const container = document.getElementById('exploreContent');
    if (!container) return;
    
    if (!items.length) {
      container.innerHTML = `<div class="empty-state" style="text-align:center;color:var(--text-muted);padding:40px 10px;">
        <i class="fas fa-compass" style="font-size:32px;display:block;margin-bottom:8px;opacity:0.5;"></i>
        هنوز پستی در اکسپلور وجود نداره.<br>اولین پست رو تو منتشر کن! 🚀
      </div>`;
      return;
    }

    let html = '';
    for (const user of items) {
      const posts = user.recent_posts ? JSON.parse(user.recent_posts) : [];
      for (const post of posts) {
        html += `
          <div class="explore-post-card" onclick="openPostModal('${post.id}')">
            ${post.media_type === 'video' ? 
              `<video src="${post.media_url}" class="post-thumb-video" muted preload="metadata"></video>` :
              `<img src="${post.media_url || defaultAvatar(post.id)}" class="post-thumb" loading="lazy">`
            }
            <div class="post-overlay">
              <div class="post-user">
                <img src="${user.avatar || defaultAvatar(user.name)}">
                <span class="name">${escapeHtml(user.name)}</span>
              </div>
              <div class="post-stats-mini">
                <span><i class="fas fa-heart"></i> ${formatNumber(post.likes || 0)}</span>
                <span><i class="fas fa-comment"></i> ${formatNumber(post.comments || 0)}</span>
                <span><i class="fas fa-eye"></i> ${formatNumber(post.views || 0)}</span>
              </div>
            </div>
          </div>
        `;
      }
    }
    container.innerHTML = html || `<div class="empty-state" style="text-align:center;color:var(--text-muted);padding:40px 10px;">
      <i class="fas fa-images" style="font-size:32px;display:block;margin-bottom:8px;opacity:0.5;"></i>
      هیچ پستی در اکسپلور وجود نداره.
    </div>`;
  } catch (e) { console.error(e); }
}

// ============================================
// مودال پست کامل (اکسپلور)
// ============================================
async function openPostModal(postId) {
  try {
    const res = await fetch(`/api/post/${postId}`);
    const post = await res.json();
    if (!post || !post.id) { showNotification('پست یافت نشد'); return; }
    
    const modal = document.getElementById('postModal');
    const body = document.getElementById('postModalBody');
    
    const user = post.user || { name: 'کاربر', avatar: defaultAvatar('user') };
    const mediaHtml = post.media_url ? `
      <div class="media-wrapper">
        ${post.media_type === 'video' ? 
          `<video src="${post.media_url}" controls preload="metadata"></video>` : 
          `<img src="${post.media_url}" loading="lazy">`}
      </div>` : '';
    
    body.innerHTML = `
      <div class="post-head" style="display:flex;align-items:center;gap:12px;margin-bottom:12px;cursor:pointer;" onclick="openProfile('${post.user_id}')">
        <img src="${user.avatar || defaultAvatar(user.name)}" style="width:44px;height:44px;border-radius:50%;border:2px solid #6c5ce7;">
        <span class="name" style="font-size:16px;font-weight:700;">${escapeHtml(user.name)}</span>
        <span class="time" style="font-size:12px;color:var(--text-muted);margin-inline-start:auto;">${timeAgo(post.created_at)}</span>
      </div>
      <p class="content" style="font-size:17px;line-height:2.2;white-space:pre-wrap;margin-bottom:14px;">${escapeHtml(post.content)}</p>
      ${mediaHtml}
      <div class="post-stats" style="display:flex;gap:12px;padding-top:14px;border-top:2px solid var(--border-color);flex-wrap:wrap;">
        <button onclick="toggleLikeModal('${post.id}', this)" class="like-btn" style="background:var(--bg-secondary);border:2px solid var(--border-color);color:var(--text-secondary);font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px;padding:10px 20px;border-radius:999px;transition:var(--transition);cursor:pointer;min-height:48px;">
          <i class="far fa-heart"></i> <span class="like-count">${formatNumber(post.likes || 0)}</span>
        </button>
        <button onclick="toggleCommentsModal('${post.id}', this)" style="background:var(--bg-secondary);border:2px solid var(--border-color);color:var(--text-secondary);font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px;padding:10px 20px;border-radius:999px;transition:var(--transition);cursor:pointer;min-height:48px;">
          <i class="far fa-comment"></i> <span class="comment-count">${formatNumber(post.comments || 0)}</span>
        </button>
        <button onclick="sharePost('${post.id}')" style="background:var(--bg-secondary);border:2px solid var(--border-color);color:var(--text-secondary);font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px;padding:10px 20px;border-radius:999px;transition:var(--transition);cursor:pointer;min-height:48px;">
          <i class="fas fa-share-alt"></i> اشتراک‌گذاری
        </button>
      </div>
      <div class="comments-box" id="commentsModal-${post.id}" style="margin-top:12px;border-top:2px solid var(--border-color);padding-top:12px;">
        <div id="commentsModalList-${post.id}"></div>
        <div class="comment-form" style="display:flex;gap:8px;margin-top:10px;">
          <input type="text" id="commentModalInput-${post.id}" placeholder="کامنت بنویس..." style="flex:1;background:var(--bg-secondary);border:2px solid var(--border-color);border-radius:var(--radius-full);padding:10px 16px;color:var(--text-primary);outline:none;font-size:14px;">
          <button class="btn btn-secondary" onclick="submitCommentModal('${post.id}')" style="min-height:44px;padding:8px 18px;">ارسال</button>
        </div>
      </div>
    `;
    
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    
    // بارگذاری کامنت‌ها
    loadCommentsModal(post.id);
  } catch (e) {
    showNotification('خطا در بارگذاری پست');
    console.error(e);
  }
}

function closePostModal() {
  document.getElementById('postModal').classList.remove('open');
  document.body.style.overflow = '';
}

async function loadCommentsModal(postId) {
  try {
    const res = await fetch(`/api/post/${postId}/comments`);
    const comments = await res.json();
    const container = document.getElementById(`commentsModalList-${postId}`);
    if (!container) return;
    container.innerHTML = comments.map(c => `
      <div class="comment-item" style="display:flex;gap:10px;margin-bottom:8px;font-size:14px;align-items:flex-start;">
        <img src="${c.avatar || defaultAvatar(c.name)}" style="width:32px;height:32px;border-radius:50%;flex-shrink:0;">
        <div>
          <b style="font-size:13px;">${escapeHtml(c.name)}</b>
          <span style="color:var(--text-secondary);display:block;">${escapeHtml(c.text)}</span>
        </div>
      </div>
    `).join('');
  } catch (e) { console.error(e); }
}

async function submitCommentModal(postId) {
  const input = document.getElementById(`commentModalInput-${postId}`);
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  try {
    const res = await fetch(`/api/post/${postId}/comment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, text })
    });
    const data = await res.json();
    if (data.success) {
      input.value = '';
      loadCommentsModal(postId);
      const card = document.querySelector(`#postModalBody .comment-count`);
      if (card) card.textContent = formatNumber(parseInt(card.textContent.replace(/,/g, '')) + 1);
    }
  } catch (e) { showNotification('خطا'); }
}

async function toggleLikeModal(postId, btn) {
  try {
    const res = await fetch(`/api/post/${postId}/like`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id })
    });
    const data = await res.json();
    if (data.success) {
      btn.classList.toggle('liked', data.liked);
      btn.querySelector('i').className = data.liked ? 'fas fa-heart' : 'far fa-heart';
      btn.querySelector('.like-count').textContent = formatNumber(data.likes);
    }
  } catch (e) { showNotification('خطا'); }
}

function toggleCommentsModal(postId, btn) {
  const box = document.getElementById(`commentsModal-${postId}`);
  if (!box) return;
  box.style.display = box.style.display === 'none' ? 'block' : 'none';
  if (box.style.display === 'block') {
    loadCommentsModal(postId);
  }
}

// ============================================
// پروفایل عمومی
// ============================================
async function openProfile(userId) {
  viewingProfileId = userId;
  try {
    const res = await fetch(`/api/profile/${userId}?viewerId=${currentUser.id}`);
    const data = await res.json();

    document.getElementById('viewAvatar').src = data.user.avatar || defaultAvatar(data.user.name);
    document.getElementById('viewName').textContent = data.user.name;
    document.getElementById('viewBio').textContent = data.user.bio || '';
    document.getElementById('viewFollowers').textContent = formatNumber(data.channel?.followers_count || 0);
    document.getElementById('viewPosts').textContent = formatNumber(data.channel?.posts_count || 0);
    document.getElementById('viewScore').textContent = formatNumber(data.user.score || 0);

    viewingProfileFollowing = data.isFollowing;
    const followBtn = document.getElementById('viewFollowBtn');
    if (followBtn) followBtn.textContent = viewingProfileFollowing ? 'فالو شده ✓' : 'فالو';

    const container = document.getElementById('viewPostsContainer');
    if (container) {
      container.innerHTML = data.posts.length ?
        data.posts.map(p => renderPostCard(p, data.user)).join('') :
        `<div class="empty-state" style="text-align:center;color:var(--text-muted);padding:40px 10px;">
          <i class="fas fa-pen-fancy" style="font-size:32px;display:block;margin-bottom:8px;opacity:0.5;"></i>
          این کاربر هنوز پستی منتشر نکرده.
        </div>`;
    }

    document.getElementById('viewAssistantChat').innerHTML = '';

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const profilePage = document.getElementById('profilePage');
    if (profilePage) profilePage.classList.add('active');
  } catch (e) { showNotification('خطا در بارگذاری پروفایل'); }
}

function backFromProfile() {
  document.querySelector('[data-page="explore"]').click();
}

async function toggleFollowView() {
  if (!viewingProfileId) return;
  const endpoint = viewingProfileFollowing ? '/api/unfollow' : '/api/follow';
  try {
    const res = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ followerId: currentUser.id, followingId: viewingProfileId })
    });
    const data = await res.json();
    if (data.success) {
      viewingProfileFollowing = !viewingProfileFollowing;
      const followBtn = document.getElementById('viewFollowBtn');
      if (followBtn) followBtn.textContent = viewingProfileFollowing ? 'فالو شده ✓' : 'فالو';
      const count = document.getElementById('viewFollowers');
      if (count) count.textContent = formatNumber(parseInt(count.textContent.replace(/,/g, '')) + (viewingProfileFollowing ? 1 : -1));
      showNotification(viewingProfileFollowing ? '✅ فالو شد' : '❌ آنفالو شد');
    }
  } catch (e) { showNotification('خطا'); }
}

async function askOtherAssistant() {
  const input = document.getElementById('viewAssistantInput');
  const msg = input.value.trim();
  if (!msg || !viewingProfileId) return;
  appendMiniMsg('viewAssistantChat', msg, 'me');
  input.value = '';

  try {
    const res = await fetch(`/api/assistant/chat/${viewingProfileId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    });
    const data = await res.json();
    appendMiniMsg('viewAssistantChat', data.reply || 'دستیار هنوز جوابی نداره 🤖', 'bot');
  } catch (e) { showNotification('خطا'); }
}

function openChatFromProfile() {
  document.querySelector('[data-page="chat"]').click();
  openChat(viewingProfileId, document.getElementById('viewName').textContent, document.getElementById('viewAvatar').src);
}

// ============================================
// چت خصوصی
// ============================================
async function loadChatList() {
  try {
    const res = await fetch(`/api/chat/list/${currentUser.id}`);
    const chats = await res.json();
    chatListCache = chats;
    const container = document.getElementById('chatList');
    if (!container) return;
    
    if (!chats.length) {
      container.innerHTML = `<div class="empty-state" style="text-align:center;color:var(--text-muted);padding:40px 10px;">
        <i class="fas fa-comment-dots" style="font-size:32px;display:block;margin-bottom:8px;opacity:0.5;"></i>
        هنوز چتی نداری.<br>از اکسپلور یکی رو پیدا کن و پیام بده! 💬
      </div>`;
      return;
    }
    
    container.innerHTML = chats.map(c => `
      <div class="chat-item" onclick="openChat('${c.id}', '${escapeHtml(c.name)}', '${c.avatar || defaultAvatar(c.name)}')">
        <img src="${c.avatar || defaultAvatar(c.name)}" loading="lazy">
        <div class="info">
          <strong>${escapeHtml(c.name)}</strong>
          <p>${escapeHtml(c.lastMessage || '')}</p>
        </div>
        ${c.unreadCount > 0 ? `<span class="unread">${c.unreadCount}</span>` : ''}
      </div>
    `).join('');
    
    const totalUnread = chats.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
    const badge = document.getElementById('chatBadge');
    if (badge) {
      if (totalUnread > 0) {
        badge.style.display = 'block';
        badge.textContent = totalUnread > 99 ? '99+' : totalUnread;
      } else {
        badge.style.display = 'none';
      }
    }
  } catch (e) { console.error(e); }
}

async function openChat(userId, name, avatar) {
  currentChatUser = { id: userId, name, avatar };
  document.getElementById('chatWithName').textContent = name || 'کاربر';
  document.getElementById('chatWithAvatar').src = avatar || defaultAvatar(name);
  document.getElementById('chatWindow').style.display = 'flex';
  document.getElementById('chatMessages').innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;"><i class="fas fa-spinner fa-spin"></i> بارگذاری...</div>';

  try {
    await fetch('/api/chat/read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, fromUser: userId })
    });
    await loadChatList();
  } catch (e) {}

  try {
    const cacheKey = `${currentUser.id}_${userId}`;
    if (messagesCache[cacheKey]) {
      renderMessages(messagesCache[cacheKey]);
      return;
    }
    
    const res = await fetch(`/api/chat/history/${currentUser.id}/${userId}`);
    const messages = await res.json();
    messagesCache[cacheKey] = messages;
    renderMessages(messages);
  } catch (e) { showNotification('خطا'); }
}

function renderMessages(messages) {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  container.innerHTML = messages.map(m => `
    <div class="message ${m.from_user === currentUser.id ? 'sent' : 'received'}" style="padding:10px 16px;border-radius:16px;font-size:14px;max-width:80%;line-height:1.6;word-wrap:break-word;${m.from_user === currentUser.id ? 'align-self:flex-end;background:var(--gradient-main);color:#fff;border-bottom-right-radius:4px;' : 'align-self:flex-start;background:var(--bg-card);border:2px solid var(--border-color);border-bottom-left-radius:4px;'}">
      ${escapeHtml(m.message)}
      <span class="time" style="font-size:10px;opacity:0.6;margin-top:2px;display:block;">${new Date(m.created_at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}</span>
    </div>
  `).join('');
  container.scrollTop = container.scrollHeight;
}

function closeChatWindow() {
  document.getElementById('chatWindow').style.display = 'none';
  currentChatUser = null;
}

async function sendMessage() {
  const input = document.getElementById('messageInput');
  const message = input.value.trim();
  if (!message || !currentChatUser) return;

  socket.emit('private_message', { 
    from: currentUser.id, 
    to: currentChatUser.id, 
    message, 
    timestamp: Date.now() 
  });
  
  displayMessage(message, 'sent');
  input.value = '';
}

function displayMessage(text, type) {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = `message ${type}`;
  div.style.cssText = `padding:10px 16px;border-radius:16px;font-size:14px;max-width:80%;line-height:1.6;word-wrap:break-word;${type === 'sent' ? 'align-self:flex-end;background:var(--gradient-main);color:#fff;border-bottom-right-radius:4px;' : 'align-self:flex-start;background:var(--bg-card);border:2px solid var(--border-color);border-bottom-left-radius:4px;'}`;
  div.innerHTML = `${escapeHtml(text)}<span class="time" style="font-size:10px;opacity:0.6;margin-top:2px;display:block;">${new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}</span>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function handleNewMessage(data) {
  const cacheKey = `${currentUser.id}_${data.from}`;
  if (messagesCache[cacheKey]) {
    messagesCache[cacheKey].push({
      from_user: data.from,
      to_user: currentUser.id,
      message: data.message,
      created_at: new Date().toISOString()
    });
  }
  
  if (currentChatUser && data.from === currentChatUser.id) {
    displayMessage(data.message, 'received');
  } else {
    showNotification(`📩 پیام جدید از ${data.from}`);
    loadChatList();
  }
}

// ============================================
// جستجو
// ============================================
document.getElementById('searchInput').addEventListener('input', debounce(async function(e) {
  const q = e.target.value.trim();
  if (q.length < 2) {
    document.getElementById('searchResults')?.remove();
    return;
  }
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const results = await res.json();
    showSearchResults(results);
  } catch (e) { console.error(e); }
}, 500));

function showSearchResults(results) {
  let container = document.getElementById('searchResults');
  if (!container) {
    container = document.createElement('div');
    container.id = 'searchResults';
    container.style.cssText = `
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      background: var(--bg-card);
      border: 2px solid var(--border-color);
      border-radius: var(--radius-md);
      margin-top: 4px;
      max-height: 300px;
      overflow-y: auto;
      z-index: 50;
      display: none;
      box-shadow: var(--shadow-3d);
    `;
    document.querySelector('.search-box').appendChild(container);
  }
  
  if (!results.length) {
    container.style.display = 'none';
    return;
  }
  
  container.style.display = 'block';
  container.innerHTML = results.map(r => `
    <div style="padding:10px 16px;cursor:pointer;display:flex;align-items:center;gap:10px;border-bottom:2px solid var(--border-color);transition:var(--transition);"
         onclick="openProfile('${r.id}')" 
         onmouseover="this.style.background='var(--bg-secondary)'"
         onmouseout="this.style.background=''">
      <i class="fas fa-${r.type === 'user' ? 'user' : 'bullhorn'}" style="color:#6c5ce7;"></i>
      <span style="font-weight:500;">${escapeHtml(r.name)}</span>
      <span style="font-size:11px;color:var(--text-muted);">${r.type === 'user' ? 'کاربر' : 'کانال'}</span>
    </div>
  `).join('');
}

// ============================================
// پنل مدیریت
// ============================================
function toggleAdminPanel() {
  if (!isAdmin) return;
  adminPanelOpen = !adminPanelOpen;
  if (adminPanelOpen) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const adminPage = document.getElementById('adminPage');
    if (adminPage) adminPage.classList.add('active');
    loadAdminData('stats');
  } else {
    document.querySelector('[data-page="channel"]').click();
  }
}

async function loadAdminData(type) {
  try {
    if (type === 'stats') {
      const res = await fetch('/api/admin/stats', { headers: { 'userId': 'admin_milad' } });
      const stats = await res.json();
      const container = document.getElementById('adminStatsContent');
      if (container) {
        container.innerHTML = `
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;">
            <div style="background:var(--bg-card);border:2px solid var(--border-color);border-radius:var(--radius-md);padding:12px;text-align:center;">
              <b style="font-size:20px;display:block;">${formatNumber(stats.users)}</b>
              <span style="font-size:12px;color:var(--text-muted);">کاربران</span>
            </div>
            <div style="background:var(--bg-card);border:2px solid var(--border-color);border-radius:var(--radius-md);padding:12px;text-align:center;">
              <b style="font-size:20px;display:block;">${formatNumber(stats.posts)}</b>
              <span style="font-size:12px;color:var(--text-muted);">پست‌ها</span>
            </div>
            <div style="background:var(--bg-card);border:2px solid var(--border-color);border-radius:var(--radius-md);padding:12px;text-align:center;">
              <b style="font-size:20px;display:block;">${formatNumber(stats.channels)}</b>
              <span style="font-size:12px;color:var(--text-muted);">کانال‌ها</span>
            </div>
            <div style="background:var(--bg-card);border:2px solid var(--border-color);border-radius:var(--radius-md);padding:12px;text-align:center;">
              <b style="font-size:20px;display:block;">${formatNumber(stats.messages)}</b>
              <span style="font-size:12px;color:var(--text-muted);">پیام‌ها</span>
            </div>
          </div>
        `;
      }
    } else if (type === 'users') {
      const res = await fetch('/api/admin/users', { headers: { 'userId': 'admin_milad' } });
      const users = await res.json();
      const container = document.getElementById('adminUsersList');
      if (container) {
        container.innerHTML = users.map(u => `
          <div class="admin-user-item" style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:2px solid var(--border-color);font-size:14px;flex-wrap:wrap;gap:4px;">
            <span style="font-weight:500;">${escapeHtml(u.name)}</span>
            <span style="font-size:12px;color:var(--text-muted);">${u.role || 'user'}</span>
            <span style="font-size:12px;color:var(--text-muted);">${formatNumber(u.followers_count || 0)} فالوور</span>
            <div style="display:flex;gap:6px;">
              ${u.role !== 'admin' ? `
                <button class="btn btn-success" onclick="adminAction('user','${u.id}','verify')" style="min-height:32px;padding:4px 12px;font-size:11px;">✓</button>
                <button class="btn btn-danger" onclick="adminAction('user','${u.id}','ban')" style="min-height:32px;padding:4px 12px;font-size:11px;">⛔</button>
              ` : ''}
            </div>
          </div>
        `).join('');
      }
    }
  } catch (e) { console.error(e); }
}

async function adminAction(type, id, action) {
  if (action === 'ban' || action === 'delete' || action === 'warn') {
    if (!confirm(`آیا از انجام این عملیات مطمئن هستید؟`)) return;
  }
  
  try {
    let url = '';
    let body = {};
    
    if (type === 'user') {
      if (action === 'ban') url = '/api/admin/user/ban';
      else if (action === 'unban') url = '/api/admin/user/unban';
      else if (action === 'verify') url = '/api/admin/user/verify';
      else if (action === 'warn') {
        url = '/api/admin/user/warn';
        const reason = prompt('دلیل اخطار:');
        if (!reason) return;
        body = { userId: id, reason };
      } else if (action === 'addscore') {
        url = '/api/admin/user/addscore';
        const points = prompt('تعداد امتیاز:');
        if (!points) return;
        body = { userId: id, points: parseInt(points) };
      }
    } else if (type === 'post' && action === 'delete') {
      url = '/api/admin/post/delete';
      body = { postId: id };
    }
    
    if (!url) { showNotification('عملیات نامعتبر'); return; }
    
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.success) {
      showNotification('✅ عملیات با موفقیت انجام شد');
      loadAdminData('users');
    } else {
      showNotification('خطا: ' + data.error);
    }
  } catch (e) { showNotification('خطا: ' + e.message); }
}

async function sendBroadcast() {
  const title = prompt('عنوان اعلان:');
  const message = prompt('متن پیام:');
  if (!message) { showNotification('متن پیام رو بنویس!'); return; }

  try {
    const res = await fetch('/api/admin/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
      body: JSON.stringify({ title: title || 'اعلان سیستمی', message })
    });
    const data = await res.json();
    if (data.success) {
      showNotification(`✅ ${data.message}`);
    }
  } catch (e) { showNotification('خطا: ' + e.message); }
}

// ============================================
// API جدید برای گرفتن پست با ID
// ============================================
fetch('/api/post/:postId', {
  // این در سرور باید اضافه شود
});

// ============================================
// شروع برنامه
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  initApp();
  
  setInterval(() => {
    if (document.getElementById('chatPage').classList.contains('active')) {
      loadChatList();
    }
  }, 30000);
});