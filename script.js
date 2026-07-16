// ============================================
// اتصال WebSocket
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
let pendingMediaUrl = null;
let pendingMediaType = null;
let mediaUploadXhr = null;
let scheduledMediaFiles = [];
let isAdmin = false;

// ============================================
// تم روشن/تیره
// ============================================
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
let adminPanelOpen = false;
let chatListCache = [];
let messagesCache = {};

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
    }, 3000);
}

function closeModal() {
    const m = document.querySelector('.modal');
    if (m) m.remove();
}

function appendMiniMsg(containerId, text, who) {
    const c = document.getElementById(containerId);
    if (!c) return;
    const div = document.createElement('div');
    div.className = 'mini-msg ' + who;
    div.textContent = text;
    c.appendChild(div);
    c.scrollTop = c.scrollHeight;
}

function updateBoostBadge(level) {
    const badge = document.getElementById('boostBadge');
    if (!badge) return;
    const labels = { normal: 'عادی', high: '🔥 داغ', viral: '🚀 وایرال', superstar: '⭐ ستاره' };
    badge.textContent = labels[level] || 'عادی';
    badge.className = 'boost-badge boost-' + level;
}

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num;
}

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
                applyAdminVisibility();
                afterLogin();
                return;
            }
        } catch (e) {}
    }
    showRegisterModal();
}

// دکمه مدیریت فقط برای کاربری که role اون از سمت سرور 'admin' برگشته نمایش داده می‌شه
// (role در دیتابیس فقط برای ایمیل هاردکد‌شده‌ی ادمین موقع بوت سرور ست می‌شه، نه با نام کاربری)
function applyAdminVisibility() {
    if (currentUser && currentUser.role === 'admin') {
        isAdmin = true;
        document.getElementById('adminBtn').classList.add('show');
    } else {
        isAdmin = false;
        document.getElementById('adminBtn').classList.remove('show');
    }
}

function showRegisterModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'registerModal';
    modal.innerHTML = `
        <div class="modal-content">
            <h2>👋 خوش اومدی!</h2>
            <div class="auth-tabs">
                <div class="auth-tab active" id="authTabRegister" onclick="switchAuthTab('register')">ثبت‌نام</div>
                <div class="auth-tab" id="authTabLogin" onclick="switchAuthTab('login')">ورود</div>
            </div>
            <p class="auth-error" id="authError"></p>

            <div id="authPaneRegister">
                <div class="avatar-upload">
                    <img id="regAvatarPreview" src="${defaultAvatar('guest')}">
                    <label><i class="fas fa-camera"></i><input type="file" id="regAvatarInput" accept="image/*"></label>
                </div>
                <input type="text" id="regNameInput" class="name-input" placeholder="اسمت چیه؟" maxlength="30">
                <input type="email" id="regEmailInput" class="name-input" placeholder="ایمیل">
                <input type="password" id="regPasswordInput" class="name-input" placeholder="رمز عبور (حداقل ۶ کاراکتر)">
                <button class="btn-primary" style="width:100%;padding:12px;font-size:14px;" onclick="registerUser()">
                    <i class="fas fa-rocket"></i> ثبت‌نام و ورود
                </button>
                <p style="font-size:10px;color:var(--text-3);margin-top:8px;">
                    با ثبت‌نام، قوانین و حریم خصوصی را می‌پذیرید
                </p>
            </div>

            <div id="authPaneLogin" style="display:none;">
                <input type="email" id="loginEmailInput" class="name-input" placeholder="ایمیل">
                <input type="password" id="loginPasswordInput" class="name-input" placeholder="رمز عبور">
                <button class="btn-primary" style="width:100%;padding:12px;font-size:14px;" onclick="loginUser()">
                    <i class="fas fa-right-to-bracket"></i> ورود
                </button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    document.getElementById('regAvatarInput').addEventListener('change', function(e) {
        readFileAsBase64(e.target.files[0], (b64) => {
            document.getElementById('regAvatarPreview').src = b64;
        });
    });
}

function switchAuthTab(tab) {
    const isRegister = tab === 'register';
    document.getElementById('authTabRegister').classList.toggle('active', isRegister);
    document.getElementById('authTabLogin').classList.toggle('active', !isRegister);
    document.getElementById('authPaneRegister').style.display = isRegister ? 'block' : 'none';
    document.getElementById('authPaneLogin').style.display = isRegister ? 'none' : 'block';
    const err = document.getElementById('authError');
    err.classList.remove('show');
    err.textContent = '';
}

function showAuthError(msg) {
    const err = document.getElementById('authError');
    err.textContent = msg;
    err.classList.add('show');
}

async function registerUser() {
    const name = document.getElementById('regNameInput').value.trim();
    const email = document.getElementById('regEmailInput').value.trim();
    const password = document.getElementById('regPasswordInput').value;
    if (!name) { showAuthError('اسمت رو بنویس!'); return; }
    if (!email) { showAuthError('ایمیلت رو بنویس!'); return; }
    if (!password || password.length < 6) { showAuthError('رمز عبور باید حداقل ۶ کاراکتر باشه'); return; }
    const avatar = document.getElementById('regAvatarPreview').src;

    try {
        const res = await fetch('/api/user/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password, avatar })
        });
        const data = await res.json();
        if (data.success) {
            currentUser = data.user;
            localStorage.setItem('yareman_user_id', currentUser.id);
            document.getElementById('registerModal').remove();
            applyAdminVisibility();
            afterLogin();
            showNotification('✨ خوش آمدی ' + currentUser.name);
        } else {
            showAuthError(data.error || 'خطا در ثبت‌نام');
        }
    } catch (e) { showAuthError('خطا در ارتباط با سرور'); }
}

async function loginUser() {
    const email = document.getElementById('loginEmailInput').value.trim();
    const password = document.getElementById('loginPasswordInput').value;
    if (!email || !password) { showAuthError('ایمیل و رمز عبور رو وارد کن'); return; }

    try {
        const res = await fetch('/api/user/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (data.success) {
            currentUser = data.user;
            localStorage.setItem('yareman_user_id', currentUser.id);
            document.getElementById('registerModal').remove();
            applyAdminVisibility();
            afterLogin();
            showNotification('✨ خوش آمدی ' + currentUser.name);
        } else {
            showAuthError(data.error || 'ایمیل یا رمز عبور اشتباه است');
        }
    } catch (e) { showAuthError('خطا در ارتباط با سرور'); }
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
    
    socket.on('message_sent', (data) => {
        if (!data.success) {
            showNotification('❌ ' + (data.error || 'پیام ارسال نشد'));
        }
    });
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
    modal.innerHTML = `
        <div class="modal-content">
            <div class="avatar-upload">
                <img id="myAvatarPreview" src="${currentUser.avatar || defaultAvatar(currentUser.name)}">
                <label><i class="fas fa-camera"></i><input type="file" id="myAvatarInput" accept="image/*"></label>
            </div>
            <h3 style="font-size:17px;">${escapeHtml(currentUser.name)}</h3>
            ${currentUser.bio ? `<p style="color:var(--text-2);font-size:13px;">${escapeHtml(currentUser.bio)}</p>` : ''}
            <div class="profile-stats">
                <div><b>${formatNumber(currentUser.followers || 0)}</b><span>فالوور</span></div>
                <div><b>${formatNumber(currentUser.score || 0)}</b><span>امتیاز</span></div>
            </div>
            <div class="profile-actions">
                <button class="btn-secondary" onclick="document.querySelector('[data-page=assistant]').click(); closeModal();">
                    <i class="fas fa-robot"></i> مدیریت دستیار
                </button>
                <button class="btn-ghost" onclick="closeModal()">بستن</button>
            </div>
        </div>`;
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
    const maxMb = type === 'video' ? 300 : 20;
    if (file.size > maxMb * 1024 * 1024) {
        showNotification(`حجم فایل نباید بیشتر از ${maxMb} مگابایت باشه`);
        return;
    }
    uploadMediaFile(file, type);
}

// آپلود واقعی و استریم‌شده به سرور (به‌جای Base64 توی JSON) - با نوار پیشرفت، بدون هنگ کردن مرورگر
function uploadMediaFile(file, type) {
    const container = document.getElementById('mediaPreview');
    const content = document.getElementById('mediaPreviewContent');
    if (!container || !content) return;

    container.style.display = 'block';
    pendingMediaUrl = null;
    pendingMediaType = null;
    content.innerHTML = `
        <div class="media-upload-progress">
            <i class="fas fa-spinner fa-spin"></i>
            <div class="progress-bar-track"><div class="progress-bar-fill" id="mediaProgressFill" style="width:0%"></div></div>
            <span id="mediaProgressText">در حال آپلود... ۰٪</span>
        </div>`;

    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    mediaUploadXhr = xhr;
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
            pendingMediaUrl = data.url;
            pendingMediaType = data.mediaType;
            showMediaPreview(data.url, data.mediaType);
        } else {
            showNotification('❌ ' + (data?.error || 'آپلود ناموفق بود'));
            removeMedia();
        }
    };
    xhr.onerror = () => {
        mediaUploadXhr = null;
        showNotification('❌ خطا در ارتباط با سرور هنگام آپلود');
        removeMedia();
    };
    xhr.send(formData);
}

function showMediaPreview(url, type) {
    const container = document.getElementById('mediaPreview');
    const content = document.getElementById('mediaPreviewContent');
    if (!container || !content) return;
    container.style.display = 'block';
    if (type === 'video') {
        content.innerHTML = `<video src="${url}" controls></video>`;
    } else {
        content.innerHTML = `<img src="${url}">`;
    }
}

function removeMedia() {
    if (mediaUploadXhr) { mediaUploadXhr.abort(); mediaUploadXhr = null; }
    pendingMediaUrl = null;
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
    if (mediaUploadXhr) { showNotification('⏳ صبر کن آپلود مدیا تموم بشه'); return; }

    try {
        const res = await fetch('/api/post/create', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.id,
                content,
                mediaUrl: pendingMediaUrl,
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
        const res = await fetch(`/api/channel/${currentUser.id}/posts`);
        const posts = await res.json();
        const container = document.getElementById('channelPosts');
        if (!container) return;

        if (!posts.length) {
            container.innerHTML = `<div class="empty-state">
                <i class="fas fa-pen-fancy"></i>
                هنوز پستی منتشر نکردی.<br>
                اولین پستت رو بنویس! ✍️
            </div>`;
        } else {
            let html = '';
            let ads = [];
            try {
                const adsRes = await fetch('/api/ads/active');
                ads = await adsRes.json();
            } catch (e) {}

            posts.forEach((p, i) => {
                html += renderPostCard(p, currentUser);
                // هر ۴ پست یه تبلیغ (در صورت وجود تبلیغ فعال) تزریق می‌شه
                if (ads.length && (i + 1) % 4 === 0) {
                    const ad = ads[Math.floor(i / 4) % ads.length];
                    html += renderAdCard(ad);
                }
            });
            container.innerHTML = html;
        }

        const ures = await fetch(`/api/user/${currentUser.id}`);
        const u = await ures.json();
        document.getElementById('followersCount').textContent = `${formatNumber(u.followers || 0)} فالوور`;
    } catch (e) { console.error(e); }
}

function renderAdCard(ad) {
    return `
    <div class="post-card ad-card" data-ad-id="${ad.id}">
        <div class="post-head">
            <span class="name">🎯 ${escapeHtml(ad.title)}</span>
            <span class="time ad-badge">تبلیغ</span>
        </div>
        <p class="content">${escapeHtml(ad.content || '')}</p>
        ${ad.media_url ? `<div class="media-wrapper">${ad.media_type === 'video' ?
            `<video src="${ad.media_url}" controls preload="metadata"></video>` :
            `<img src="${ad.media_url}" loading="lazy">`}</div>` : ''}
        ${ad.link_url ? `<a href="${ad.link_url}" target="_blank" rel="noopener" class="btn-primary ad-link-btn">مشاهده</a>` : ''}
    </div>`;
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
        <div class="post-head">
            <img src="${avatar}" loading="lazy" onclick="openProfile('${post.user_id || currentUser.id}')">
            <span class="name" onclick="openProfile('${post.user_id || currentUser.id}')">${escapeHtml(name)}</span>
            <span class="time">${timeAgo(post.created_at)}</span>
            <div class="post-menu">
                <button class="post-menu-btn" onclick="togglePostMenu('${post.id}')"><i class="fas fa-ellipsis-h"></i></button>
                <div class="post-menu-dropdown" id="postMenu-${post.id}">
                    <button onclick="openReportModal('post', '${post.id}')"><i class="fas fa-flag"></i> گزارش پست</button>
                </div>
            </div>
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
            <button disabled>
                <i class="far fa-eye"></i> ${formatNumber(post.views || 0)}
            </button>
        </div>
        <div class="comments-box" id="comments-${post.id}"></div>
    </div>`;
}

function togglePostMenu(postId) {
    const dropdown = document.getElementById(`postMenu-${postId}`);
    const wasOpen = dropdown?.classList.contains('open');
    document.querySelectorAll('.post-menu-dropdown.open').forEach(d => d.classList.remove('open'));
    if (dropdown && !wasOpen) dropdown.classList.add('open');
}
document.addEventListener('click', (e) => {
    if (!e.target.closest('.post-menu')) {
        document.querySelectorAll('.post-menu-dropdown.open').forEach(d => d.classList.remove('open'));
    }
});

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
                    <div>
                        <b>${escapeHtml(c.name)}</b>
                        <span class="comment-text">${escapeHtml(c.text)}</span>
                    </div>
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
            if (!box) return;
            const form = box.querySelector('.comment-form');
            const item = document.createElement('div');
            item.className = 'comment-item';
            item.innerHTML = `
                <img src="${data.comment.avatar || defaultAvatar(data.comment.name)}" loading="lazy">
                <div>
                    <b>${escapeHtml(data.comment.name)}</b>
                    <span class="comment-text">${escapeHtml(data.comment.text)}</span>
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
            <div class="qa-item">
                <span class="q">❓ ${escapeHtml(q.question)}</span>
                <span class="a">💬 ${escapeHtml(q.answer)}</span>
            </div>
        `).join('') : '<p class="empty-state">هنوز آموزشی ثبت نشده.</p>';

        document.getElementById('keywordList').innerHTML = data.keywords?.length ? data.keywords.map(k => `
            <div class="keyword-item">
                <span class="k">🔑 ${escapeHtml(k.keyword)}</span>
                <span class="r">💬 ${escapeHtml(k.response)}</span>
            </div>
        `).join('') : '<p class="empty-state">هنوز کلمه کلیدی ثبت نشده.</p>';

        if (data.posts?.length) {
            document.getElementById('scheduledPostsList').innerHTML = data.posts.map(p => `
                <div style="font-size:11px;color:var(--text-2);padding:6px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
                    <span>📅 ${escapeHtml(p.content?.substring(0, 30) || '')}...</span>
                    <span style="font-size:10px;color:var(--text-3);">${new Date(p.scheduled_time).toLocaleString('fa-IR')}</span>
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

// ============================================
// زمان‌بندی پست‌ها
// ============================================
document.getElementById('scheduleImages').addEventListener('change', function(e) {
    for (const file of e.target.files) uploadScheduledMedia(file, 'image');
});

document.getElementById('scheduleVideos').addEventListener('change', function(e) {
    for (const file of e.target.files) uploadScheduledMedia(file, 'video');
});

async function uploadScheduledMedia(file, type) {
    const maxMb = type === 'video' ? 300 : 20;
    if (file.size > maxMb * 1024 * 1024) {
        showNotification(`حجم فایل نباید بیشتر از ${maxMb} مگابایت باشه`);
        return;
    }
    const idx = scheduledMediaFiles.length;
    scheduledMediaFiles.push({ data: null, type, uploading: true });
    showNotification(`⏳ در حال آپلود ${type === 'video' ? 'ویدیو' : 'عکس'} ${idx + 1}...`);
    try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success) {
            scheduledMediaFiles[idx] = { data: data.url, type: data.mediaType, uploading: false };
        } else {
            scheduledMediaFiles[idx] = null;
            showNotification('❌ خطا در آپلود: ' + data.error);
        }
    } catch (e) {
        scheduledMediaFiles[idx] = null;
        showNotification('❌ خطا در ارتباط با سرور هنگام آپلود');
    }
}

async function schedulePosts() {
    const count = parseInt(document.getElementById('postCount').value);
    const descriptions = document.getElementById('postDescriptions').value.split('\n').filter(s => s.trim());
    const time = document.getElementById('postTime').value;
    const interval = parseInt(document.getElementById('postInterval').value) || 1;

    if (!count || count < 1) { showNotification('تعداد پست‌ها رو مشخص کن!'); return; }
    if (descriptions.length < count) { showNotification(`حداقل ${count} توضیح وارد کن.`); return; }
    if (scheduledMediaFiles.some(m => m && m.uploading)) { showNotification('⏳ صبر کن آپلود مدیاها تموم بشه'); return; }

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
// اکسپلور - گرید سه‌تایی مثل اینستاگرام
// ============================================
let explorePostIndex = {}; // postId -> { post, user }
let pfCurrentPostId = null;

async function loadExplore() {
    try {
        const res = await fetch('/api/explore');
        const items = await res.json();
        const container = document.getElementById('exploreContent');
        if (!container) return;

        if (!items.length) {
            container.innerHTML = `<div class="empty-state">
                <i class="fas fa-compass"></i>
                هنوز پستی در اکسپلور وجود نداره.<br>
                اولین پست رو تو منتشر کن! 🚀
            </div>`;
            return;
        }

        explorePostIndex = {};
        const tiles = [];

        items.forEach(user => {
            const posts = user.recent_posts || [];
            if (!posts.length) return;
            posts.forEach(p => {
                explorePostIndex[p.id] = { post: p, user };
                if (p.media_url) {
                    tiles.push(`
                        <div class="explore-tile" onclick="openPostFullscreen('${p.id}')">
                            ${p.media_type === 'video' ?
                                `<video src="${p.media_url}" muted preload="metadata"></video>
                                 <i class="fas fa-play tile-video-badge"></i>` :
                                `<img src="${p.media_url}" loading="lazy">`}
                            <div class="tile-overlay">
                                <span><i class="fas fa-eye"></i>${formatNumber(p.views || 0)}</span>
                                <span><i class="fas fa-heart"></i>${formatNumber(p.likes || 0)}</span>
                            </div>
                        </div>
                    `);
                } else {
                    tiles.push(`
                        <div class="explore-tile no-media" onclick="openPostFullscreen('${p.id}')">
                            <p>${escapeHtml((p.content || '').substring(0, 140))}</p>
                            <div class="tile-overlay">
                                <span><i class="fas fa-eye"></i>${formatNumber(p.views || 0)}</span>
                                <span><i class="fas fa-heart"></i>${formatNumber(p.likes || 0)}</span>
                            </div>
                        </div>
                    `);
                }
            });
        });

        container.innerHTML = tiles.join('') || `<div class="empty-state">
            <i class="fas fa-compass"></i>
            هنوز پستی در اکسپلور وجود نداره.<br>
            اولین پست رو تو منتشر کن! 🚀
        </div>`;
    } catch (e) { console.error(e); }
}

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
        post.media_type === 'video' ?
            `<video src="${post.media_url}" controls preload="metadata"></video>` :
            `<img src="${post.media_url}">`
    ) : '';

    const likeBtn = document.getElementById('pfLikeBtn');
    likeBtn.classList.remove('liked');
    likeBtn.querySelector('i').className = 'far fa-heart';
    document.getElementById('pfLikeCount').textContent = formatNumber(post.likes || 0);
    document.getElementById('pfCommentCount').textContent = formatNumber(post.comments || 0);

    const followBtn = document.getElementById('pfFollowBtn');
    const isMe = user.user_id === currentUser.id;
    followBtn.style.display = isMe ? 'none' : '';
    followBtn.textContent = 'فالو';
    followBtn.classList.remove('following');

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

async function pfQuickFollow() {
    const entry = explorePostIndex[pfCurrentPostId];
    if (!entry) return;
    await quickFollow(entry.user.user_id, document.getElementById('pfFollowBtn'));
}

async function pfToggleLike() {
    if (!pfCurrentPostId) return;
    await toggleLike(pfCurrentPostId, document.getElementById('pfLikeBtn'));
    const entry = explorePostIndex[pfCurrentPostId];
    if (entry) {
        entry.post.likes = parseInt((document.getElementById('pfLikeCount').textContent || '0').replace(/,/g, '')) || entry.post.likes;
    }
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
                    <div>
                        <b>${escapeHtml(c.name)}</b>
                        <span class="comment-text">${escapeHtml(c.text)}</span>
                    </div>
                </div>
            `).join('') || '') + `
                <div class="comment-form">
                    <input type="text" id="pfCommentInput" placeholder="کامنت بنویس...">
                    <button class="btn-plastic btn-plastic--pistachio" onclick="pfSubmitComment()">ارسال</button>
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
            item.innerHTML = `
                <img src="${data.comment.avatar || defaultAvatar(data.comment.name)}" loading="lazy">
                <div>
                    <b>${escapeHtml(data.comment.name)}</b>
                    <span class="comment-text">${escapeHtml(data.comment.text)}</span>
                </div>`;
            if (form) box.insertBefore(item, form); else box.appendChild(item);

            const countEl = document.getElementById('pfCommentCount');
            countEl.textContent = formatNumber((parseInt(countEl.textContent.replace(/,/g, '')) || 0) + 1);

            const entry = explorePostIndex[pfCurrentPostId];
            if (entry) entry.post.comments = (entry.post.comments || 0) + 1;
        }
    } catch (e) { showNotification('خطا در ارسال کامنت'); }
}

async function pfShare() {
    await sharePost(pfCurrentPostId);
}

async function sharePost(postId) {
    const entry = explorePostIndex[postId];
    const shareUrl = `${location.origin}${location.pathname}?post=${postId}`;
    const shareText = entry ? `${entry.user.name}: ${(entry.post.content || '').substring(0, 100)}` : 'یه پست جالب';
    try {
        if (navigator.share) {
            await navigator.share({ title: 'یارِ من', text: shareText, url: shareUrl });
        } else {
            await navigator.clipboard.writeText(shareUrl);
            showNotification('🔗 لینک پست کپی شد');
        }
    } catch (e) {
        // کاربر اشتراک‌گذاری را لغو کرده - نیازی به پیام خطا نیست
    }
}

function pfMessage() {
    const entry = explorePostIndex[pfCurrentPostId];
    if (!entry) return;
    if (entry.user.user_id === currentUser.id) {
        showNotification('این پست خودتونه 🙂');
        return;
    }
    closePostFullscreen();
    document.querySelector('[data-page="chat"]').click();
    openChat(entry.user.user_id, entry.user.name, entry.user.avatar || defaultAvatar(entry.user.name));
}

async function quickFollow(userId, btn) {
    if (userId === currentUser.id) {
        showNotification('نمی‌توانید خودتان را فالو کنید');
        return;
    }
    
    const isFollowing = btn.classList.contains('following');
    
    try {
        const endpoint = isFollowing ? '/api/unfollow' : '/api/follow';
        const res = await fetch(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ followerId: currentUser.id, followingId: userId })
        });
        const data = await res.json();
        if (data.success) {
            if (isFollowing) {
                btn.textContent = 'فالو';
                btn.classList.remove('following');
                showNotification('❌ آنفالو شد');
            } else {
                btn.textContent = 'فالو شد ✓';
                btn.classList.add('following');
                showNotification('✅ فالو شد');
            }
            const countEl = document.getElementById('viewFollowers');
            if (countEl) {
                countEl.textContent = formatNumber(parseInt(countEl.textContent.replace(/,/g, '')) + (isFollowing ? -1 : 1));
            }
        }
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
            container.innerHTML = data.posts.length ?
                data.posts.map(p => renderPostCard(p, data.user)).join('') :
                `<div class="empty-state">
                    <i class="fas fa-pen-fancy"></i>
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
            container.innerHTML = `<div class="empty-state">
                <i class="fas fa-comment-dots"></i>
                هنوز چتی نداری.<br>
                از اکسپلور یکی رو پیدا کن و پیام بده! 💬
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
    document.getElementById('chatThreadOverlay').classList.add('open');
    document.getElementById('chatMessages').innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> بارگذاری...</div>';

    try {
        const blockRes = await fetch(`/api/user/${currentUser.id}/is-blocked/${userId}`);
        const blockData = await blockRes.json();
        updateChatBlockBtn(!!blockData.blocked);
    } catch (e) { updateChatBlockBtn(false); }

    // علامت‌گذاری پیام‌ها به عنوان خوانده شده
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
    div.innerHTML = `${escapeHtml(text)}<span class="time">${new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}</span>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

socket.on('new_message', (data) => {
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
});

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
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            margin-top: 4px;
            max-height: 300px;
            overflow-y: auto;
            z-index: 50;
            display: none;
        `;
        document.querySelector('.search-box').appendChild(container);
    }
    
    if (!results.length) {
        container.style.display = 'none';
        return;
    }
    
    container.style.display = 'block';
    container.innerHTML = results.map(r => `
        <div style="padding:8px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border);transition:var(--transition);"
             onclick="openProfile('${r.id}')" 
             onmouseover="this.style.background='var(--bg-soft)'"
             onmouseout="this.style.background=''">
            <i class="fas fa-${r.type === 'user' ? 'user' : 'bullhorn'}"></i>
            <span>${escapeHtml(r.name)}</span>
            <span style="font-size:10px;color:var(--text-3);">${r.type === 'user' ? 'کاربر' : 'کانال'}</span>
        </div>
    `).join('');
}

function debounce(fn, wait) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
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
            const container = document.getElementById('adminStatsContent');
            if (container) {
                container.innerHTML = `
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px;">
                        <div class="stat-chip"><b>${formatNumber(stats.users)}</b><span>کاربران</span></div>
                        <div class="stat-chip"><b>${formatNumber(stats.posts)}</b><span>پست‌ها</span></div>
                        <div class="stat-chip"><b>${formatNumber(stats.channels)}</b><span>کانال‌ها</span></div>
                        <div class="stat-chip"><b>${formatNumber(stats.messages)}</b><span>پیام‌ها</span></div>
                        <div class="stat-chip"><b>${formatNumber(stats.follows)}</b><span>فالوها</span></div>
                        <div class="stat-chip"><b>${formatNumber(stats.comments)}</b><span>کامنت‌ها</span></div>
                        <div class="stat-chip"><b>${formatNumber(stats.pendingReports)}</b><span>گزارش در انتظار</span></div>
                    </div>
                `;
            }
        } else if (type === 'users') {
            const res = await fetch('/api/admin/users', { headers: { 'userId': 'admin_milad' } });
            const users = await res.json();
            const container = document.getElementById('adminUsersList');
            if (container) {
                container.innerHTML = users.map(u => `
                    <div class="admin-user-item">
                        <span class="name">${escapeHtml(u.name)}${u.is_verified ? ' ✔️' : ''}</span>
                        <span style="font-size:10px;color:var(--text-3);">${u.role === 'banned' ? '⛔ مسدود' : (u.restricted ? '🔒 محدود' : (u.role || 'user'))}</span>
                        <span style="font-size:10px;color:var(--text-3);">${formatNumber(u.followers_count || 0)} فالوور</span>
                        <div class="actions">
                            ${u.role !== 'admin' ? `
                                ${u.is_verified
                                    ? `<button class="btn-secondary" onclick="adminAction('user','${u.id}','unverify')">✗ حذف تیک</button>`
                                    : `<button class="btn-success" onclick="adminAction('user','${u.id}','verify')">✓ تیک آبی</button>`}
                                ${u.restricted
                                    ? `<button class="btn-secondary" onclick="adminAction('user','${u.id}','unrestrict')">🔓 رفع محدودیت</button>`
                                    : `<button class="btn-secondary" onclick="adminAction('user','${u.id}','restrict')">🔒 محدود کردن</button>`}
                                ${u.role === 'banned'
                                    ? `<button class="btn-success" onclick="adminAction('user','${u.id}','unban')">✅ رفع مسدودی</button>`
                                    : `<button class="btn-danger" onclick="adminAction('user','${u.id}','ban')">⛔ مسدود کردن</button>`}
                            ` : ''}
                        </div>
                    </div>
                `).join('');
            }
        } else if (type === 'posts') {
            const res = await fetch('/api/admin/posts', { headers: { 'userId': 'admin_milad' } });
            const posts = await res.json();
            const container = document.getElementById('adminPostsList');
            if (container) {
                container.innerHTML = posts.map(p => `
                    <div class="admin-post-item">
                        <span>${escapeHtml((p.content || '').substring(0, 40))}...</span>
                        <span style="font-size:10px;color:var(--text-3);">${escapeHtml(p.user_name)}</span>
                        <span style="font-size:10px;color:var(--text-3);">${timeAgo(p.created_at)}</span>
                        <button class="btn-danger" onclick="adminAction('post','${p.id}','delete')">🗑️</button>
                    </div>
                `).join('');
            }
        } else if (type === 'channels') {
            const res = await fetch('/api/admin/channels', { headers: { 'userId': 'admin_milad' } });
            const channels = await res.json();
            const container = document.getElementById('adminChannelsList');
            if (container) {
                container.innerHTML = channels.map(c => `
                    <div class="admin-user-item">
                        <span>${escapeHtml(c.name)}</span>
                        <span style="font-size:10px;color:var(--text-3);">${formatNumber(c.followers_count)} فالوور</span>
                        <span style="font-size:10px;color:var(--text-3);">${c.boost_level}</span>
                        <span style="font-size:10px;color:var(--text-3);">${formatNumber(c.posts_count)} پست</span>
                    </div>
                `).join('');
            }
        } else if (type === 'reports') {
            const res = await fetch('/api/admin/reports?status=pending', { headers: { 'userId': 'admin_milad' } });
            const reports = await res.json();
            const container = document.getElementById('adminReportsList');
            if (container) {
                const labels = { user: '👤 کاربر', post: '📝 پست', comment: '💬 کامنت' };
                container.innerHTML = reports.length ? reports.map(r => `
                    <div class="admin-post-item">
                        <span>${labels[r.target_type] || r.target_type} — ${escapeHtml(r.reason)}</span>
                        <span style="font-size:10px;color:var(--text-3);">شناسه هدف: ${escapeHtml(r.target_id || '')}</span>
                        <span style="font-size:10px;color:var(--text-3);">${timeAgo(r.created_at)}</span>
                        <div class="actions">
                            <button class="btn-success" onclick="resolveReport('${r.id}')">✅ بررسی شد</button>
                            <button class="btn-secondary" onclick="dismissReport('${r.id}')">رد کردن</button>
                        </div>
                    </div>
                `).join('') : `<p style="font-size:12px;color:var(--text-3);text-align:center;padding:20px;">گزارش در انتظاری وجود ندارد 🎉</p>`;
            }
        } else if (type === 'ads') {
            const res = await fetch('/api/admin/ads', { headers: { 'userId': 'admin_milad' } });
            const ads = await res.json();
            const container = document.getElementById('adminAdsList');
            if (container) {
                container.innerHTML = ads.map(a => `
                    <div class="admin-post-item">
                        <span>${escapeHtml(a.title)}</span>
                        <span style="font-size:10px;color:var(--text-3);">${a.is_active ? '🟢 فعال' : '⚪ غیرفعال'} — ${formatNumber(a.views || 0)} بازدید</span>
                        <div class="actions">
                            <button class="btn-secondary" onclick="toggleAd('${a.id}', ${a.is_active ? 0 : 1})">${a.is_active ? 'غیرفعال کردن' : 'فعال کردن'}</button>
                            <button class="btn-danger" onclick="deleteAd('${a.id}')">🗑️</button>
                        </div>
                    </div>
                `).join('') || `<p style="font-size:12px;color:var(--text-3);text-align:center;padding:20px;">هنوز تبلیغی ساخته نشده</p>`;
            }
        }
    } catch (e) { console.error(e); }
}

async function adminAction(type, id, action) {
    if (!confirm(`آیا از انجام این عملیات مطمئن هستید؟`)) return;
    try {
        const res = await fetch(`/api/admin/${type}/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
            body: JSON.stringify({ 
                userId: type === 'user' ? id : undefined,
                postId: type === 'post' ? id : undefined
            })
        });
        const data = await res.json();
        if (data.success) {
            showNotification('✅ عملیات با موفقیت انجام شد');
            const activeTab = document.querySelector('.admin-tab.active');
            if (activeTab) loadAdminData(activeTab.dataset.tab);
        }
    } catch (e) { showNotification('خطا: ' + e.message); }
}

async function resolveReport(reportId) {
    try {
        const res = await fetch('/api/admin/report/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
            body: JSON.stringify({ reportId })
        });
        const data = await res.json();
        if (data.success) { showNotification('✅ گزارش بررسی شد'); loadAdminData('reports'); }
    } catch (e) { showNotification('خطا: ' + e.message); }
}

async function dismissReport(reportId) {
    try {
        const res = await fetch('/api/admin/report/dismiss', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
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
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
            body: JSON.stringify({ title, content, linkUrl })
        });
        const data = await res.json();
        if (data.success) {
            showNotification('✅ تبلیغ ساخته شد');
            document.getElementById('adTitle').value = '';
            document.getElementById('adContent').value = '';
            document.getElementById('adLink').value = '';
            loadAdminData('ads');
        } else {
            showNotification('خطا: ' + data.error);
        }
    } catch (e) { showNotification('خطا: ' + e.message); }
}

async function toggleAd(adId, active) {
    try {
        const res = await fetch('/api/admin/ads/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
            body: JSON.stringify({ adId, active })
        });
        const data = await res.json();
        if (data.success) loadAdminData('ads');
    } catch (e) { showNotification('خطا: ' + e.message); }
}

async function deleteAd(adId) {
    if (!confirm('این تبلیغ حذف بشه؟')) return;
    try {
        const res = await fetch('/api/admin/ads/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'userId': 'admin_milad' },
            body: JSON.stringify({ adId })
        });
        const data = await res.json();
        if (data.success) loadAdminData('ads');
    } catch (e) { showNotification('خطا: ' + e.message); }
}

async function sendBroadcast() {
    const title = document.getElementById('broadcastTitle').value.trim();
    const message = document.getElementById('broadcastMessage').value.trim();
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
            document.getElementById('broadcastTitle').value = '';
            document.getElementById('broadcastMessage').value = '';
        }
    } catch (e) { showNotification('خطا: ' + e.message); }
}

// ============================================
// گزارش (پست/کاربر/کامنت) - مودال مشترک
// ============================================
function openReportModal(targetType, targetId) {
    document.querySelectorAll('.post-menu-dropdown.open').forEach(d => d.classList.remove('open'));
    document.getElementById('reportModal')?.remove();

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'reportModal';
    modal.style.zIndex = '400';
    modal.innerHTML = `
        <div class="modal-content" style="max-width:340px;">
            <h2>🚩 گزارش</h2>
            <p style="color:var(--text-2);font-size:13px;margin-bottom:12px;">دلیل گزارشت رو بنویس</p>
            <textarea id="reportReasonInput" class="name-input" style="min-height:80px;resize:vertical;width:100%;" placeholder="مثلاً: محتوای نامناسب، اسپم، آزار..." maxlength="500"></textarea>
            <div style="display:flex;gap:8px;margin-top:10px;">
                <button class="btn-secondary" style="flex:1;" onclick="document.getElementById('reportModal').remove()">انصراف</button>
                <button class="btn-danger" style="flex:1;" onclick="submitReport('${targetType}','${targetId}')">ارسال گزارش</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
}

async function submitReport(targetType, targetId) {
    const reason = document.getElementById('reportReasonInput')?.value.trim();
    if (!reason) { showNotification('دلیل گزارش رو بنویس'); return; }
    try {
        const res = await fetch('/api/report', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reporterId: currentUser.id, targetId, targetType, reason })
        });
        const data = await res.json();
        if (data.success) {
            showNotification('✅ گزارش شما ثبت شد، ممنون از همکاریت');
            document.getElementById('reportModal')?.remove();
        } else {
            showNotification('خطا: ' + data.error);
        }
    } catch (e) { showNotification('خطا در ارتباط با سرور'); }
}

function pfOpenReport() {
    if (!pfCurrentPostId) return;
    openReportModal('post', pfCurrentPostId);
}

// ============================================
// منوی سه‌نقطه‌ی چت - گزارش و مسدود کردن کاربر
// ============================================
function toggleChatMenu() {
    const dropdown = document.getElementById('chatThreadMenu');
    const wasOpen = dropdown?.classList.contains('open');
    document.querySelectorAll('.post-menu-dropdown.open').forEach(d => d.classList.remove('open'));
    if (dropdown && !wasOpen) dropdown.classList.add('open');
}

function reportChatUser() {
    if (!currentChatUser) return;
    document.getElementById('chatThreadMenu')?.classList.remove('open');
    openReportModal('user', currentChatUser.id);
}

function updateChatBlockBtn(blocked) {
    const btn = document.getElementById('chatBlockBtn');
    if (!btn) return;
    btn.innerHTML = blocked ? '<i class="fas fa-unlock"></i> رفع مسدودیت' : '<i class="fas fa-ban"></i> مسدود کردن';
    btn.dataset.blocked = blocked ? '1' : '0';
}

async function toggleBlockChatUser() {
    if (!currentChatUser) return;
    document.getElementById('chatThreadMenu')?.classList.remove('open');
    const btn = document.getElementById('chatBlockBtn');
    const isBlocked = btn?.dataset.blocked === '1';

    if (!isBlocked && !confirm(`${currentChatUser.name} مسدود بشه؟ دیگه نمی‌تونید برای هم پیام بفرستید.`)) return;

    try {
        const res = await fetch(isBlocked ? '/api/user/unblock' : '/api/user/block', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ blockerId: currentUser.id, blockedId: currentChatUser.id })
        });
        const data = await res.json();
        if (data.success) {
            updateChatBlockBtn(!isBlocked);
            showNotification(isBlocked ? '🔓 رفع مسدودیت شد' : '🚫 کاربر مسدود شد');
        }
    } catch (e) { showNotification('خطا در ارتباط با سرور'); }
}

// ============================================
// شروع برنامه
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    initApp();
    
    // Auto-refresh chat list
    setInterval(() => {
        if (document.getElementById('chatPage').classList.contains('active')) {
            loadChatList();
        }
    }, 30000);
});