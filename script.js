// script.js - نسخه نهایی با تمام قابلیت‌ها
const socket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: 20, reconnectionDelay: 1000 });

let currentUser = null;
let currentChatUser = null;
let viewingProfileId = null;
let viewingProfileFollowing = false;
let pendingMediaUrl = null;
let pendingMediaType = null;
let mediaUploadXhr = null;
let isAdmin = false;
let chatMode = 'assistant'; // 'user' | 'assistant'
let explorePostIndex = {};
let pfCurrentPostId = null;
let allStories = [];
let explorePage = 1;
let exploreLoading = false;
let exploreHasMore = true;
let exploreItems = [];

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const icon = document.getElementById('themeIcon');
    if (icon) icon.className = theme === 'light' ? 'fas fa-sun' : 'fas fa-moon';
    try { localStorage.setItem('yareman_theme', theme); } catch (e) {}
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    applyTheme(current === 'light' ? 'dark' : 'light');
}

(function initTheme() {
    let saved = 'dark';
    try { saved = localStorage.getItem('yareman_theme') || 'dark'; } catch (e) {}
    applyTheme(saved);
})();

function defaultAvatar(seed) { return `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(seed || 'user')}`; }

function escapeHtml(str) { if (!str) return ''; const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

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
    setTimeout(() => { n.style.opacity = '0'; n.style.transform = 'translate(-50%, -20px)'; setTimeout(() => n.remove(), 300); }, 3000);
}

function closeModal() { const m = document.querySelector('.modal'); if (m) m.remove(); }

function formatNumber(num) { if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'; if (num >= 1000) return (num / 1000).toFixed(1) + 'K'; return num; }

// ============================================
// ورود / ثبت‌نام
// ============================================
async function initApp() {
    const savedId = localStorage.getItem('yareman_user_id');
    if (savedId) {
        try {
            const res = await fetch(`/api/user/${savedId}`);
            if (res.ok) {
                currentUser = await res.json();
                if (currentUser.id === 'admin_milad') { isAdmin = true; document.getElementById('adminBtn').classList.add('show'); }
                afterLogin();
                return;
            }
        } catch (e) {}
    }
    showRegisterModal();
}

function showRegisterModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'registerModal';
    modal.innerHTML = `
        <div class="modal-content">
            <h2>👋 خوش اومدی!</h2>
            <p style="color:var(--text-2);font-size:13px;margin-bottom:12px;">ثبت‌نام در یارِ من</p>
            <div class="avatar-upload">
                <img id="regAvatarPreview" src="${defaultAvatar('guest')}">
                <label><i class="fas fa-camera"></i><input type="file" id="regAvatarInput" accept="image/*"></label>
            </div>
            <input type="text" id="regNameInput" class="name-input" placeholder="نام کاربری" maxlength="30">
            <input type="text" id="regEmailInput" class="name-input" placeholder="ایمیل (اختیاری)">
            <input type="password" id="regPasswordInput" class="name-input" placeholder="رمز عبور (حداقل ۶ کاراکتر)">
            <button class="btn-primary" style="width:100%;padding:12px;font-size:14px;" onclick="registerUser()">
                <i class="fas fa-rocket"></i> ثبت‌نام
            </button>
            <p style="font-size:10px;color:var(--text-3);margin-top:8px;">با ثبت‌نام، قوانین و حریم خصوصی را می‌پذیرید</p>
        </div>`;
    document.body.appendChild(modal);
    document.getElementById('regAvatarInput').addEventListener('change', function(e) {
        const reader = new FileReader();
        reader.onload = (e) => { document.getElementById('regAvatarPreview').src = e.target.result; };
        reader.readAsDataURL(e.target.files[0]);
    });
}

async function registerUser() {
    const name = document.getElementById('regNameInput').value.trim();
    const email = document.getElementById('regEmailInput').value.trim();
    const password = document.getElementById('regPasswordInput').value;
    if (!name) { showNotification('نام کاربری رو بنویس!'); return; }
    if (password.length < 6) { showNotification('رمز عبور حداقل ۶ کاراکتر باشه!'); return; }
    const avatar = document.getElementById('regAvatarPreview').src;
    try {
        const res = await fetch('/api/user/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, avatar, email, password })
        });
        const data = await res.json();
        if (data.success) {
            currentUser = data.user;
            localStorage.setItem('yareman_user_id', currentUser.id);
            document.getElementById('registerModal').remove();
            if (currentUser.id === 'admin_milad') { isAdmin = true; document.getElementById('adminBtn').classList.add('show'); }
            afterLogin();
            showNotification('✨ خوش آمدی ' + currentUser.name);
        } else {
            showNotification('خطا: ' + data.error);
        }
    } catch (e) { showNotification('خطا در ارتباط با سرور'); }
}

function afterLogin() {
    document.getElementById('userName').textContent = currentUser.name;
    document.getElementById('avatarImg').src = currentUser.avatar || defaultAvatar(currentUser.name);
    document.getElementById('userScore').textContent = `🏆 ${formatNumber(currentUser.score || 0)}`;
    socket.emit('join', currentUser.id);
    setupNav();
    loadPageData('channel');
    loadStories();
    socket.on('broadcast', (data) => { showNotification(`📢 ${data.title || 'اعلان'}: ${data.message}`); });
}

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
// استوری‌ها
// ============================================
async function loadStories() {
    try {
        const res = await fetch(`/api/stories/${currentUser.id}`);
        const data = await res.json();
        allStories = data.stories || [];
        renderStories();
    } catch (e) { console.error(e); }
}

function renderStories() {
    const row = document.getElementById('storiesRow');
    if (!row) return;
    let html = `
        <div class="story-ring" onclick="addStory()">
            <div class="ring add"><img src="${currentUser.avatar || defaultAvatar(currentUser.name)}"><i class="fas fa-plus" style="position:absolute;bottom:4px;right:4px;background:var(--primary);border-radius:50%;padding:2px;font-size:10px;"></i></div>
            <span>استوری جدید</span>
        </div>`;
    allStories.forEach(s => {
        html += `
            <div class="story-ring" onclick="viewStory('${s.id}')">
                <div class="ring"><img src="${s.user_avatar || defaultAvatar(s.user_name)}"></div>
                <span>${escapeHtml(s.user_name)}</span>
            </div>`;
    });
    row.innerHTML = html;
}

async function addStory() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,video/*';
    input.onchange = async function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('file', file);
        try {
            const res = await fetch('/api/upload', { method: 'POST', body: formData });
            const data = await res.json();
            if (data.success) {
                await fetch('/api/stories/add', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: currentUser.id, mediaUrl: data.url, mediaType: data.mediaType })
                });
                showNotification('✅ استوری اضافه شد');
                loadStories();
            }
        } catch (e) { showNotification('خطا در آپلود استوری'); }
    };
    input.click();
}

function viewStory(storyId) {
    const story = allStories.find(s => s.id === storyId);
    if (!story) return;
    const viewer = document.getElementById('storyViewer');
    const content = document.getElementById('storyContent');
    const userEl = document.getElementById('storyUser');
    viewer.classList.add('open');
    userEl.textContent = story.user_name;
    if (story.media_type === 'video') {
        content.innerHTML = `<video src="${story.media_url}" controls autoplay class="story-content"></video>`;
    } else {
        content.innerHTML = `<img src="${story.media_url}" class="story-content">`;
    }
}

function closeStory() {
    document.getElementById('storyViewer').classList.remove('open');
    document.getElementById('storyContent').innerHTML = '';
}

// ============================================
// پست‌ها
// ============================================
document.getElementById('postImageInput').addEventListener('change', function(e) { handleMediaFile(e.target.files[0], 'image'); });
document.getElementById('postVideoInput').addEventListener('change', function(e) { handleMediaFile(e.target.files[0], 'video'); });

function handleMediaFile(file, type) {
    if (!file) return;
    const maxMb = type === 'video' ? 300 : 20;
    if (file.size > maxMb * 1024 * 1024) { showNotification(`حجم فایل نباید بیشتر از ${maxMb} مگابایت باشه`); return; }
    uploadMediaFile(file, type);
}

function uploadMediaFile(file, type) {
    const container = document.getElementById('mediaPreview');
    const content = document.getElementById('mediaPreviewContent');
    if (!container || !content) return;
    container.style.display = 'block';
    pendingMediaUrl = null; pendingMediaType = null;
    content.innerHTML = `
        <div class="media-upload-progress">
            <i class="fas fa-spinner fa-spin"></i>
            <div class="progress-bar-track"><div class="progress-bar-fill" id="mediaProgressFill" style="width:0%"></div></div>
            <span id="mediaProgressText">در حال آپلود... ۰٪</span>
        </div>`;
    const formData = new FormData(); formData.append('file', file);
    const xhr = new XMLHttpRequest(); mediaUploadXhr = xhr;
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        const fill = document.getElementById('mediaProgressFill');
        const text = document.getElementById('mediaProgressText');
        if (fill) fill.style.width = pct + '%';
        if (text) text.textContent = `در حال آپلود... ${pct}٪`;
    };
    xhr.onload = () => {
        mediaUploadXhr = null;
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && data && data.success) {
            pendingMediaUrl = data.url; pendingMediaType = data.mediaType;
            showMediaPreview(data.url, data.mediaType);
        } else { showNotification('❌ ' + (data?.error || 'آپلود ناموفق بود')); removeMedia(); }
    };
    xhr.onerror = () => { mediaUploadXhr = null; showNotification('❌ خطا در ارتباط با سرور'); removeMedia(); };
    xhr.send(formData);
}

function showMediaPreview(url, type) {
    const container = document.getElementById('mediaPreview');
    const content = document.getElementById('mediaPreviewContent');
    if (!container || !content) return;
    container.style.display = 'block';
    if (type === 'video') { content.innerHTML = `<video src="${url}" controls></video>`; }
    else { content.innerHTML = `<img src="${url}">`; }
}

function removeMedia() {
    if (mediaUploadXhr) { mediaUploadXhr.abort(); mediaUploadXhr = null; }
    pendingMediaUrl = null; pendingMediaType = null;
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
    if (mediaUploadXhr) { showNotification('⏳ صبر کن آپلود مدیا تموم بشه'); return; }
    try {
        const res = await fetch('/api/post/create', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, content, mediaUrl: pendingMediaUrl, mediaType: pendingMediaType || 'none' })
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('postContent').value = '';
            removeMedia();
            showNotification('✅ پست منتشر شد');
            await loadChannelPosts();
        } else { showNotification('خطا: ' + data.error); }
    } catch (e) { showNotification('خطا در ارتباط با سرور'); }
}

async function loadChannelPosts() {
    try {
        const res = await fetch(`/api/channel/${currentUser.id}/posts`);
        const posts = await res.json();
        const container = document.getElementById('channelPosts');
        if (!container) return;
        if (!posts.length) {
            container.innerHTML = `<div class="empty-state"><i class="fas fa-pen-fancy"></i>هنوز پستی منتشر نکردی.<br>اولین پستت رو بنویس! ✍️</div>`;
        } else {
            let html = '';
            posts.forEach(p => { html += renderPostCard(p, currentUser); });
            container.innerHTML = html;
        }
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
            ${post.media_type === 'video' ? `<video src="${post.media_url}" controls preload="metadata"></video>` : `<img src="${post.media_url}" loading="lazy">`}
        </div>` : '';
    return `
    <div class="post-card" data-post-id="${post.id}">
        <div class="post-head">
            <img src="${avatar}" loading="lazy" onclick="openProfile('${post.user_id || currentUser.id}')">
            <span class="name" onclick="openProfile('${post.user_id || currentUser.id}')">${escapeHtml(name)}</span>
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
            <button disabled><i class="far fa-eye"></i> ${formatNumber(post.views || 0)}</button>
            <button onclick="showPaymentInfo()" style="font-size:11px;color:var(--text-3);"><i class="fas fa-arrow-up"></i></button>
        </div>
        <div class="comments-box" id="comments-${post.id}"></div>
    </div>`;
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
    box.classList.toggle('open');
    if (box.classList.contains('open') && !box.dataset.loaded) {
        box.dataset.loaded = '1';
        try {
            const res = await fetch(`/api/post/${postId}/comments`);
            const comments = await res.json();
            box.innerHTML = (comments.map(c => `
                <div class="comment-item">
                    <img src="${c.avatar || defaultAvatar(c.name)}" loading="lazy">
                    <div><b>${escapeHtml(c.name)}</b><span class="comment-text">${escapeHtml(c.text)}</span></div>
                </div>
            `).join('') || '') + `
                <div class="comment-form">
                    <input type="text" id="commentInput-${postId}" placeholder="کامنت بنویس...">
                    <button class="btn-secondary" onclick="submitComment('${postId}')">ارسال</button>
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
            const form = box.querySelector('.comment-form');
            const item = document.createElement('div');
            item.className = 'comment-item';
            item.innerHTML = `<img src="${data.comment.avatar || defaultAvatar(data.comment.name)}" loading="lazy"><div><b>${escapeHtml(data.comment.name)}</b><span class="comment-text">${escapeHtml(data.comment.text)}</span></div>`;
            box.insertBefore(item, form);
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
            <div class="qa-item"><span class="q">❓ ${escapeHtml(q.question)}</span><span class="a">💬 ${escapeHtml(q.answer)}</span></div>
        `).join('') : '<p class="empty-state">هنوز آموزشی ثبت نشده.</p>';
        document.getElementById('keywordList').innerHTML = data.keywords?.length ? data.keywords.map(k => `
            <div class="keyword-item"><span class="k">🔑 ${escapeHtml(k.keyword)}</span><span class="r">💬 ${escapeHtml(k.response)}</span></div>
        `).join('') : '<p class="empty-state">هنوز کلمه کلیدی ثبت نشده.</p>';
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
        if (data.success) { showNotification('✅ دستیار یاد گرفت'); document.getElementById('questionInput').value = ''; document.getElementById('answerInput').value = ''; await loadAssistantData(); }
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
        if (data.success) { showNotification('✅ کلمه کلیدی ثبت شد'); document.getElementById('keywordInput').value = ''; document.getElementById('keywordResponseInput').value = ''; await loadAssistantData(); }
    } catch (e) { showNotification('خطا'); }
}

// ============================================
// اکسپلور - اسکرول بی‌نهایت
// ============================================
async function loadExplore(reset = true) {
    if (reset) { explorePage = 1; exploreItems = []; exploreHasMore = true; }
    if (exploreLoading || !exploreHasMore) return;
    exploreLoading = true;
    try {
        const res = await fetch(`/api/explore?page=${explorePage}&limit=30`);
        const items = await res.json();
        if (!items.length) { exploreHasMore = false; exploreLoading = false; return; }
        exploreItems = exploreItems.concat(items);
        explorePage++;
        renderExploreItems();
    } catch (e) { console.error(e); }
    exploreLoading = false;
}

function renderExploreItems() {
    const container = document.getElementById('exploreContent');
    if (!container) return;
    if (!exploreItems.length) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-compass"></i>هنوز پستی در اکسپلور وجود نداره.<br>اولین پست رو تو منتشر کن! 🚀</div>`;
        return;
    }
    explorePostIndex = {};
    let html = '';
    exploreItems.forEach(user => {
        const posts = user.recent_posts || [];
        posts.forEach(p => {
            explorePostIndex[p.id] = { post: p, user };
            if (p.media_url) {
                html += `<div class="explore-tile" onclick="openPostFullscreen('${p.id}')">
                    ${p.media_type === 'video' ? `<video src="${p.media_url}" muted preload="metadata"></video><i class="fas fa-play tile-video-badge"></i>` : `<img src="${p.media_url}" loading="lazy">`}
                    <div class="tile-overlay"><span><i class="fas fa-eye"></i>${formatNumber(p.views || 0)}</span><span><i class="fas fa-heart"></i>${formatNumber(p.likes || 0)}</span></div>
                </div>`;
            } else {
                html += `<div class="explore-tile no-media" onclick="openPostFullscreen('${p.id}')">
                    <p>${escapeHtml((p.content || '').substring(0, 60))}</p>
                    <div class="tile-overlay"><span><i class="fas fa-eye"></i>${formatNumber(p.views || 0)}</span><span><i class="fas fa-heart"></i>${formatNumber(p.likes || 0)}</span></div>
                </div>`;
            }
        });
    });
    container.innerHTML = html;
}

// اسکرول بی‌نهایت برای اکسپلور
document.getElementById('explorePage').addEventListener('scroll', function() {
    if (this.scrollTop + this.clientHeight >= this.scrollHeight - 200) {
        loadExplore(false);
    }
});

// ============================================
// نمایش تمام‌صفحه پست
// ============================================
function openPostFullscreen(postId) {
    const entry = explorePostIndex[postId];
    if (!entry) return;
    const { post, user } = entry;
    pfCurrentPostId = postId;

    document.getElementById('pfAvatar').src = user.avatar || defaultAvatar(user.name);
    document.getElementById('pfName').textContent = user.name;
    document.getElementById('pfTime').textContent = timeAgo(post.created_at);
    document.getElementById('pfCaption').textContent = post.content || '';

    const mediaEl = document.getElementById('pfMedia');
    mediaEl.innerHTML = post.media_url ? (
        post.media_type === 'video' ? `<video src="${post.media_url}" controls autoplay preload="metadata"></video>` : `<img src="${post.media_url}">`
    ) : '';

    const likeBtn = document.getElementById('pfLikeBtn');
    likeBtn.classList.remove('liked');
    likeBtn.querySelector('i').className = 'far fa-heart';
    document.getElementById('pfLikeCount').textContent = formatNumber(post.likes || 0);
    document.getElementById('pfCommentCount').textContent = formatNumber(post.comments || 0);

    const commentsBox = document.getElementById('pfCommentsBox');
    commentsBox.innerHTML = '';
    commentsBox.classList.remove('open');
    delete commentsBox.dataset.loaded;

    document.getElementById('postFullOverlay').classList.add('open');
}

function closePostFullscreen() {
    document.getElementById('postFullOverlay').classList.remove('open');
    document.getElementById('pfMedia').innerHTML = '';
    pfCurrentPostId = null;
}

function pfOpenProfile() {
    const entry = explorePostIndex[pfCurrentPostId];
    if (!entry) return;
    closePostFullscreen();
    openProfile(entry.user.user_id);
}

async function pfToggleLike() {
    if (!pfCurrentPostId) return;
    const btn = document.getElementById('pfLikeBtn');
    const countEl = document.getElementById('pfLikeCount');
    try {
        const res = await fetch(`/api/post/${pfCurrentPostId}/like`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id })
        });
        const data = await res.json();
        if (data.success) {
            btn.classList.toggle('liked', data.liked);
            btn.querySelector('i').className = data.liked ? 'fas fa-heart' : 'far fa-heart';
            countEl.textContent = formatNumber(data.likes);
            const entry = explorePostIndex[pfCurrentPostId];
            if (entry) entry.post.likes = data.likes;
        }
    } catch (e) { showNotification('خطا'); }
}

async function pfToggleComments() {
    if (!pfCurrentPostId) return;
    const box = document.getElementById('pfCommentsBox');
    box.classList.toggle('open');
    if (box.classList.contains('open') && !box.dataset.loaded) {
        box.dataset.loaded = '1';
        try {
            const res = await fetch(`/api/post/${pfCurrentPostId}/comments`);
            const comments = await res.json();
            box.innerHTML = (comments.map(c => `
                <div class="comment-item">
                    <img src="${c.avatar || defaultAvatar(c.name)}" loading="lazy">
                    <div><b>${escapeHtml(c.name)}</b><span class="comment-text">${escapeHtml(c.text)}</span></div>
                </div>
            `).join('') || '') + `
                <div class="comment-form">
                    <input type="text" id="pfCommentInput" placeholder="کامنت بنویس...">
                    <button class="btn-secondary" onclick="pfSubmitComment()">ارسال</button>
                </div>`;
        } catch (e) { showNotification('خطا'); }
    }
}

async function pfSubmitComment() {
    const input = document.getElementById('pfCommentInput');
    if (!input || !pfCurrentPostId) return;
    const text = input.value.trim();
    if (!text) return;
    try {
        const res = await fetch(`/api/post/${pfCurrentPostId}/comment`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, text })
        });
        const data = await res.json();
        if (data.success) {
            input.value = '';
            const box = document.getElementById('pfCommentsBox');
            const form = box.querySelector('.comment-form');
            const item = document.createElement('div');
            item.className = 'comment-item';
            item.innerHTML = `<img src="${data.comment.avatar || defaultAvatar(data.comment.name)}" loading="lazy"><div><b>${escapeHtml(data.comment.name)}</b><span class="comment-text">${escapeHtml(data.comment.text)}</span></div>`;
            if (form) box.insertBefore(item, form); else box.appendChild(item);
            const countEl = document.getElementById('pfCommentCount');
            countEl.textContent = formatNumber((parseInt(countEl.textContent.replace(/,/g, '')) || 0) + 1);
        }
    } catch (e) { showNotification('خطا'); }
}

async function pfShare() {
    const entry = explorePostIndex[pfCurrentPostId];
    const shareUrl = `${location.origin}${location.pathname}?post=${pfCurrentPostId}`;
    const shareText = entry ? `${entry.user.name}: ${(entry.post.content || '').substring(0, 100)}` : 'یه پست جالب';
    try {
        if (navigator.share) { await navigator.share({ title: 'یارِ من', text: shareText, url: shareUrl }); }
        else { await navigator.clipboard.writeText(shareUrl); showNotification('🔗 لینک پست کپی شد'); }
    } catch (e) {}
}

function pfMessage() {
    const entry = explorePostIndex[pfCurrentPostId];
    if (!entry) return;
    if (entry.user.user_id === currentUser.id) { showNotification('این پست خودتونه 🙂'); return; }
    closePostFullscreen();
    document.querySelector('[data-page="chat"]').click();
    openChat(entry.user.user_id, entry.user.name, entry.user.avatar || defaultAvatar(entry.user.name));
}

// ============================================
// ارتقاع کاربر
// ============================================
function showPaymentInfo() {
    document.getElementById('paymentModal').style.display = 'flex';
}

async function submitPayment() {
    const file = document.getElementById('paymentReceipt').files[0];
    if (!file) { showNotification('لطفاً تصویر فیش را انتخاب کنید'); return; }
    const formData = new FormData();
    formData.append('file', file);
    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success) {
            await fetch('/api/payment/submit', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: currentUser.id, receiptUrl: data.url })
            });
            showNotification('✅ فیش شما ارسال شد، در کمتر از ۲۴ ساعت تایید می‌شود');
            document.getElementById('paymentModal').style.display = 'none';
            document.getElementById('paymentReceipt').value = '';
        } else { showNotification('خطا در آپلود فیش'); }
    } catch (e) { showNotification('خطا در ارتباط با سرور'); }
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
            container.innerHTML = data.posts.length ? data.posts.map(p => renderPostCard(p, data.user)).join('') :
                `<div class="empty-state"><i class="fas fa-pen-fancy"></i>این کاربر هنوز پستی منتشر نکرده.</div>`;
        }
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById('profilePage').classList.add('active');
    } catch (e) { showNotification('خطا در بارگذاری پروفایل'); }
}

function backFromProfile() { document.querySelector('[data-page="explore"]').click(); }

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

function openChatFromProfile() {
    document.querySelector('[data-page="chat"]').click();
    openChat(viewingProfileId, document.getElementById('viewName').textContent, document.getElementById('viewAvatar').src);
}

// ============================================
// چت خصوصی با کلید انتخاب دستیار/کاربر
// ============================================
function setChatMode(mode) {
    chatMode = mode;
    document.getElementById('chatModeUser').style.background = mode === 'user' ? 'var(--primary)' : 'transparent';
    document.getElementById('chatModeUser').style.color = mode === 'user' ? '#fff' : 'var(--text-2)';
    document.getElementById('chatModeAssistant').style.background = mode === 'assistant' ? 'var(--primary)' : 'transparent';
    document.getElementById('chatModeAssistant').style.color = mode === 'assistant' ? '#fff' : 'var(--text-2)';
}

async function loadChatList() {
    try {
        const res = await fetch(`/api/chat/list/${currentUser.id}`);
        const chats = await res.json();
        const container = document.getElementById('chatList');
        if (!container) return;
        if (!chats.length) {
            container.innerHTML = `<div class="empty-state"><i class="fas fa-comment-dots"></i>هنوز چتی نداری.<br>از اکسپلور یکی رو پیدا کن و پیام بده! 💬</div>`;
            return;
        }
        container.innerHTML = chats.map(c => `
            <div class="chat-item" onclick="openChat('${c.id}', '${escapeHtml(c.name)}', '${c.avatar || defaultAvatar(c.name)}')">
                <img src="${c.avatar || defaultAvatar(c.name)}" loading="lazy">
                <div class="info"><strong>${escapeHtml(c.name)}</strong><p>${escapeHtml(c.lastMessage || '')}</p></div>
                ${c.unreadCount > 0 ? `<span class="unread">${c.unreadCount}</span>` : ''}
            </div>
        `).join('');
        const totalUnread = chats.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
        const badge = document.getElementById('chatBadge');
        if (badge) { badge.style.display = totalUnread > 0 ? 'block' : 'none'; badge.textContent = totalUnread > 99 ? '99+' : totalUnread; }
    } catch (e) { console.error(e); }
}

async function openChat(userId, name, avatar) {
    currentChatUser = { id: userId, name, avatar };
    document.getElementById('chatWithName').textContent = name || 'کاربر';
    document.getElementById('chatWithAvatar').src = avatar || defaultAvatar(name);
    document.getElementById('chatThreadOverlay').classList.add('open');
    document.getElementById('chatMessages').innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> بارگذاری...</div>';
    setChatMode('assistant');
    try {
        const res = await fetch(`/api/chat/history/${currentUser.id}/${userId}`);
        const messages = await res.json();
        renderMessages(messages);
    } catch (e) { showNotification('خطا'); }
}

function renderMessages(messages) {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    container.innerHTML = messages.map(m => `
        <div class="message ${m.from_user === currentUser.id ? 'sent' : 'received'}">
            ${escapeHtml(m.message)}
            <span class="time">${new Date(m.created_at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
    `).join('');
    container.scrollTop = container.scrollHeight;
}

function closeChatWindow() {
    document.getElementById('chatThreadOverlay').classList.remove('open');
    currentChatUser = null;
}

function chatThreadOpenProfile() {
    if (!currentChatUser) return;
    const userId = currentChatUser.id;
    closeChatWindow();
    openProfile(userId);
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    if (!message || !currentChatUser) return;

    if (chatMode === 'assistant') {
        // ارسال به دستیار کاربر مقابل
        try {
            const res = await fetch(`/api/assistant/chat/${currentChatUser.id}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message })
            });
            const data = await res.json();
            displayMessage(message, 'sent');
            displayMessage(data.reply || 'دستیار هنوز جوابی نداره 🤖', 'received');
        } catch (e) { showNotification('خطا در ارتباط با دستیار'); }
        input.value = '';
        return;
    }

    // حالت کاربر - ارسال پیام معمولی
    socket.emit('private_message', { from: currentUser.id, to: currentChatUser.id, message, timestamp: Date.now() });
    displayMessage(message, 'sent');
    input.value = '';
}

function displayMessage(text, type) {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = `message ${type}`;
    div.innerHTML = `${escapeHtml(text)}<span class="time">${new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}</span>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

socket.on('new_message', (data) => {
    if (currentChatUser && data.from === currentChatUser.id) {
        displayMessage(data.message, 'received');
    } else {
        showNotification(`📩 پیام جدید از ${data.from}`);
        loadChatList();
    }
});

// ============================================
// جستجو
// ============================================
document.getElementById('searchInput').addEventListener('input', debounce(async function(e) {
    const q = e.target.value.trim();
    if (q.length < 2) { document.getElementById('searchResults')?.remove(); return; }
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
        container.style.cssText = `position:absolute;top:100%;left:0;right:0;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);margin-top:4px;max-height:300px;overflow-y:auto;z-index:50;display:none;`;
        document.querySelector('.search-box').appendChild(container);
    }
    if (!results.length) { container.style.display = 'none'; return; }
    container.style.display = 'block';
    container.innerHTML = results.map(r => `
        <div style="padding:8px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border);transition:var(--transition);"
             onclick="openProfile('${r.id}')" 
             onmouseover="this.style.background='var(--bg-soft)'" onmouseout="this.style.background=''">
            <i class="fas fa-${r.type === 'user' ? 'user' : 'bullhorn'}"></i>
            <span>${escapeHtml(r.name)}</span>
            <span style="font-size:10px;color:var(--text-3);">${r.type === 'user' ? 'کاربر' : 'کانال'}</span>
        </div>
    `).join('');
}

function debounce(fn, wait) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); }; }

// ============================================
// پنل مدیریت
// ============================================
function toggleAdminPanel() {
    if (!isAdmin) return;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('adminPage').classList.add('active');
    loadAdminData('stats');
}

function switchAdminTab(tab) {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    const tabBtn = document.querySelector(`.admin-tab[data-tab="${tab}"]`);
    if (tabBtn) tabBtn.classList.add('active');
    document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
    const content = document.getElementById('admin' + tab.charAt(0).toUpperCase() + tab.slice(1));
    if (content) content.classList.add('active');
    loadAdminData(tab);
}

async function loadAdminData(type) {
    try {
        if (type === 'stats') {
            const res = await fetch('/api/admin/stats', { headers: { 'userId': 'admin_milad' } });
            const stats = await res.json();
            document.getElementById('adminStatsContent').innerHTML = `
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px;">
                    <div class="stat-chip"><b>${formatNumber(stats.users)}</b><span>کاربران</span></div>
                    <div class="stat-chip"><b>${formatNumber(stats.posts)}</b><span>پست‌ها</span></div>
                    <div class="stat-chip"><b>${formatNumber(stats.channels)}</b><span>کانال‌ها</span></div>
                    <div class="stat-chip"><b>${formatNumber(stats.messages)}</b><span>پیام‌ها</span></div>
                    <div class="stat-chip"><b>${formatNumber(stats.follows)}</b><span>فالوها</span></div>
                    <div class="stat-chip"><b>${formatNumber(stats.comments)}</b><span>کامنت‌ها</span></div>
                    <div class="stat-chip"><b>${formatNumber(stats.pendingReports)}</b><span>گزارش</span></div>
                    <div class="stat-chip"><b>${formatNumber(stats.pendingPayments || 0)}</b><span>پرداخت</span></div>
                </div>`;
        } else if (type === 'users') {
            const res = await fetch('/api/admin/users', { headers: { 'userId': 'admin_milad' } });
            const users = await res.json();
            document.getElementById('adminUsersList').innerHTML = users.map(u => `
                <div class="admin-user-item">
                    <span class="name">${escapeHtml(u.name)}${u.is_verified ? ' ✔️' : ''}</span>
                    <span style="font-size:10px;color:var(--text-3);">${u.role === 'banned' ? '⛔ مسدود' : (u.restricted ? '🔒 محدود' : (u.role || 'user'))}</span>
                    <span style="font-size:10px;color:var(--text-3);">${formatNumber(u.followers_count || 0)} فالوور</span>
                    <div class="actions">
                        ${u.role !== 'admin' ? `
                            ${u.is_verified ? `<button class="btn-secondary" onclick="adminAction('user','${u.id}','unverify')">✗ حذف تیک</button>` : `<button class="btn-success" onclick="adminAction('user','${u.id}','verify')">✓ تیک آبی</button>`}
                            ${u.restricted ? `<button class="btn-secondary" onclick="adminAction('user','${u.id}','unrestrict')">🔓 رفع محدودیت</button>` : `<button class="btn-secondary" onclick="adminAction('user','${u.id}','restrict')">🔒 محدود کردن</button>`}
                            ${u.role === 'banned' ? `<button class="btn-success" onclick="adminAction('user','${u.id}','unban')">✅ رفع مسدودی</button>` : `<button class="btn-danger" onclick="adminAction('user','${u.id}','ban')">⛔ مسدود کردن</button>`}
                        ` : ''}
                    </div>
                </div>
            `).join('');
        } else if (type === 'posts') {
            const res = await fetch('/api/admin/posts', { headers: { 'userId': 'admin_milad' } });
            const posts = await res.json();
            document.getElementById('adminPostsList').innerHTML = posts.map(p => `
                <div class="admin-post-item">
                    <span>${escapeHtml((p.content || '').substring(0, 40))}...</span>
                    <span style="font-size:10px;color:var(--text-3);">${escapeHtml(p.user_name)}</span>
                    <span style="font-size:10px;color:var(--text-3);">${timeAgo(p.created_at)}</span>
                    <button class="btn-danger" onclick="adminAction('post','${p.id}','delete')">🗑️</button>
                </div>
            `).join('');
        } else if (type === 'channels') {
            const res = await fetch('/api/admin/channels', { headers: { 'userId': 'admin_milad' } });
            const channels = await res.json();
            document.getElementById('adminChannelsList').innerHTML = channels.map(c => `
                <div class="admin-user-item">
                    <span>${escapeHtml(c.name)}</span>
                    <span style="font-size:10px;color:var(--text-3);">${formatNumber(c.followers_count)} فالوور</span>
                    <span style="font-size:10px;color:var(--text-3);">${c.boost_level}</span>
                </div>
            `).join('');
        } else if (type === 'reports') {
            const res = await fetch('/api/admin/reports?status=pending', { headers: { 'userId': 'admin_milad' } });
            const reports = await res.json();
            const labels = { user: '👤 کاربر', post: '📝 پست', comment: '💬 کامنت' };
            document.getElementById('adminReportsList').innerHTML = reports.length ? reports.map(r => `
                <div class="admin-post-item">
                    <span>${labels[r.target_type] || r.target_type} — ${escapeHtml(r.reason)}</span>
                    <span style="font-size:10px;color:var(--text-3);">${timeAgo(r.created_at)}</span>
                    <div class="actions">
                        <button class="btn-success" onclick="resolveReport('${r.id}')">✅ بررسی شد</button>
                        <button class="btn-secondary" onclick="dismissReport('${r.id}')">رد کردن</button>
                    </div>
                </div>
            `).join('') : `<p style="font-size:12px;color:var(--text-3);text-align:center;padding:20px;">گزارش در انتظاری وجود ندارد 🎉</p>`;
        } else if (type === 'ads') {
            const res = await fetch('/api/admin/ads', { headers: { 'userId': 'admin_milad' } });
            const ads = await res.json();
            document.getElementById('adminAdsList').innerHTML = ads.map(a => `
                <div class="admin-post-item">
                    <span>${escapeHtml(a.title)}</span>
                    <span style="font-size:10px;color:var(--text-3);">${a.is_active ? '🟢 فعال' : '⚪ غیرفعال'}</span>
                    <div class="actions">
                        <button class="btn-secondary" onclick="toggleAd('${a.id}', ${a.is_active ? 0 : 1})">${a.is_active ? 'غیرفعال کردن' : 'فعال کردن'}</button>
                        <button class="btn-danger" onclick="deleteAd('${a.id}')">🗑️</button>
                    </div>
                </div>
            `).join('') || `<p style="font-size:12px;color:var(--text-3);text-align:center;padding:20px;">هنوز تبلیغی ساخته نشده</p>`;
        } else if (type === 'payments') {
            const res = await fetch('/api/admin/payments', { headers: { 'userId': 'admin_milad' } });
            const payments = await res.json();
            document.getElementById('adminPaymentsList').innerHTML = payments.map(p => `
                <div class="admin-post-item">
                    <span>${escapeHtml(p.user_name)}</span>
                    <span style="font-size:10px;color:var(--text-3);">${p.status === 'pending' ? '⏳ در انتظار' : (p.status === 'approved' ? '✅ تایید شده' : '❌ رد شده')}</span>
                    <span style="font-size:10px;color:var(--text-3);">${timeAgo(p.created_at)}</span>
                    ${p.status === 'pending' ? `
                        <div class="actions">
                            <button class="btn-success" onclick="approvePayment('${p.id}')">✅ تایید</button>
                            <button class="btn-danger" onclick="rejectPayment('${p.id}')">❌ رد</button>
                        </div>
                    ` : ''}
                </div>
            `).join('') || `<p style="font-size:12px;color:var(--text-3);text-align:center;padding:20px;">هیچ درخواست پرداختی وجود ندارد</p>`;
        }
    } catch (e) { console.error(e); }
}

async function adminAction(type, id, action) {
    if (!confirm(`آیا از انجام این عملیات مطمئن هستید؟`)) return;
    try {
        const res = await fetch(`/api/admin/${type}/${action}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
            body: JSON.stringify({ userId: type === 'user' ? id : undefined, postId: type === 'post' ? id : undefined })
        });
        const data = await res.json();
        if (data.success) { showNotification('✅ عملیات با موفقیت انجام شد'); loadAdminData(document.querySelector('.admin-tab.active')?.dataset.tab || 'stats'); }
    } catch (e) { showNotification('خطا: ' + e.message); }
}

async function resolveReport(reportId) {
    try {
        const res = await fetch('/api/admin/report/resolve', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
            body: JSON.stringify({ reportId })
        });
        const data = await res.json();
        if (data.success) { showNotification('✅ گزارش بررسی شد'); loadAdminData('reports'); }
    } catch (e) { showNotification('خطا: ' + e.message); }
}

async function dismissReport(reportId) {
    try {
        const res = await fetch('/api/admin/report/dismiss', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
            body: JSON.stringify({ reportId })
        });
        const data = await res.json();
        if (data.success) { showNotification('گزارش رد شد'); loadAdminData('reports'); }
    } catch (e) { showNotification('خطا: ' + e.message); }
}

async function createAd() {
    const title = document.getElementById('adTitle').value.trim();
    const content = document.getElementById('adContent').value.trim();
    const linkUrl = document.getElementById('adLink').value.trim();
    if (!title) { showNotification('عنوان تبلیغ رو بنویس!'); return; }
    try {
        const res = await fetch('/api/admin/ads/create', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
            body: JSON.stringify({ title, content, linkUrl })
        });
        const data = await res.json();
        if (data.success) { showNotification('✅ تبلیغ ساخته شد'); document.getElementById('adTitle').value = ''; document.getElementById('adContent').value = ''; document.getElementById('adLink').value = ''; loadAdminData('ads'); }
    } catch (e) { showNotification('خطا: ' + e.message); }
}

async function toggleAd(adId, active) {
    try {
        const res = await fetch('/api/admin/ads/toggle', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
            body: JSON.stringify({ adId, active })
        });
        if (res.ok) loadAdminData('ads');
    } catch (e) { showNotification('خطا: ' + e.message); }
}

async function deleteAd(adId) {
    if (!confirm('این تبلیغ حذف بشه؟')) return;
    try {
        const res = await fetch('/api/admin/ads/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
            body: JSON.stringify({ adId })
        });
        if (res.ok) loadAdminData('ads');
    } catch (e) { showNotification('خطا: ' + e.message); }
}

async function sendBroadcast() {
    const title = document.getElementById('broadcastTitle').value.trim();
    const message = document.getElementById('broadcastMessage').value.trim();
    if (!message) { showNotification('متن پیام رو بنویس!'); return; }
    try {
        const res = await fetch('/api/admin/broadcast', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
            body: JSON.stringify({ title: title || 'اعلان سیستمی', message })
        });
        const data = await res.json();
        if (data.success) { showNotification(`✅ ${data.message}`); document.getElementById('broadcastTitle').value = ''; document.getElementById('broadcastMessage').value = ''; }
    } catch (e) { showNotification('خطا: ' + e.message); }
}

async function approvePayment(paymentId) {
    try {
        const res = await fetch('/api/admin/payment/approve', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
            body: JSON.stringify({ paymentId })
        });
        if (res.ok) { showNotification('✅ پرداخت تایید شد'); loadAdminData('payments'); }
    } catch (e) { showNotification('خطا'); }
}

async function rejectPayment(paymentId) {
    try {
        const res = await fetch('/api/admin/payment/reject', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
            body: JSON.stringify({ paymentId })
        });
        if (res.ok) { showNotification('❌ پرداخت رد شد'); loadAdminData('payments'); }
    } catch (e) { showNotification('خطا'); }
}

// ============================================
// شروع برنامه
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    initApp();
    setInterval(() => { if (document.getElementById('chatPage').classList.contains('active')) loadChatList(); }, 30000);
});