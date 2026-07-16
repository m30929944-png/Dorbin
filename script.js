// ============================================
// script.js - کلاینت کامل پلتفرم اجتماعی
// ============================================

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

// ============================================
// متغیرهای سراسری
// ============================================
let currentUser = null;
let currentChatUser = null;
let viewingProfileId = null;
let viewingProfileFollowing = false;
let pendingMediaUrl = null;
let pendingMediaType = null;
let isAdmin = false;
let exploreCursor = null;
let exploreLoading = false;
let exploreEnd = false;
let chatFileUploading = false;

// ============================================
// تم
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

// ============================================
// توابع کمکی
// ============================================
function defaultAvatar(seed) {
    return `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(seed || 'user')}`;
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
    if (diff < 31536000) return Math.floor(diff / 2592000) + ' ماه پیش';
    return new Date(dateStr).toLocaleDateString('fa-IR');
}

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num;
}

function showToast(text, type = 'info') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    
    const toast = document.createElement('div');
    toast.className = 'toast';
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    toast.innerHTML = `${icons[type] || 'ℹ️'} ${text}`;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translate(-50%, -20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function closeModal() {
    const m = document.querySelector('.modal');
    if (m) m.remove();
}

function appendChatMessage(containerId, text, who, media) {
    const c = document.getElementById(containerId);
    if (!c) return;
    const div = document.createElement('div');
    div.className = 'message ' + who;
    let content = escapeHtml(text);
    if (media) {
        if (media.type === 'image') {
            content += `<div class="media-preview-msg"><img src="${media.url}" loading="lazy"></div>`;
        } else if (media.type === 'video') {
            content += `<div class="media-preview-msg"><video src="${media.url}" controls preload="metadata"></video></div>`;
        } else if (media.type === 'document') {
            content += `<div class="media-preview-msg"><a href="${media.url}" target="_blank" style="color:var(--primary);">📄 ${escapeHtml(media.name)}</a></div>`;
        }
    }
    content += `<span class="time">${new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}</span>`;
    div.innerHTML = content;
    c.appendChild(div);
    c.scrollTop = c.scrollHeight;
}

// ============================================
// ورود / ثبت‌نام
// ============================================
async function initApp() {
    const savedId = localStorage.getItem('yareman_user_id');
    const savedToken = localStorage.getItem('yareman_token');
    
    if (savedId && savedToken) {
        try {
            const res = await fetch(`/api/user/${savedId}`, {
                headers: { 'Authorization': `Bearer ${savedToken}` }
            });
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

function showRegisterModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'registerModal';
    modal.innerHTML = `
        <div class="modal-content">
            <h2>👋 خوش اومدی!</h2>
            <p style="color:var(--text-secondary);font-size:12px;margin-bottom:10px;">
                یه اسم برای خودت انتخاب کن
            </p>
            <div class="avatar-upload">
                <img id="regAvatarPreview" src="${defaultAvatar('guest')}">
                <label><i class="fas fa-camera"></i><input type="file" id="regAvatarInput" accept="image/*"></label>
            </div>
            <input type="text" id="regNameInput" class="modal-input" placeholder="اسمت چیه؟" maxlength="30">
            <input type="email" id="regEmailInput" class="modal-input" placeholder="ایمیل (اختیاری)">
            <input type="password" id="regPasswordInput" class="modal-input" placeholder="رمز عبور (اختیاری)">
            <button class="modal-btn modal-btn-primary" onclick="registerUser()">
                <i class="fas fa-rocket"></i> ورود به یارِ من
            </button>
            <p style="font-size:9px;color:var(--text-muted);margin-top:6px;">
                با ثبت‌نام، قوانین را می‌پذیرید
            </p>
        </div>`;
    document.body.appendChild(modal);

    document.getElementById('regAvatarInput').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                document.getElementById('regAvatarPreview').src = ev.target.result;
            };
            reader.readAsDataURL(file);
        }
    });
}

async function registerUser() {
    const name = document.getElementById('regNameInput').value.trim();
    const email = document.getElementById('regEmailInput').value.trim();
    const password = document.getElementById('regPasswordInput').value;
    const avatar = document.getElementById('regAvatarPreview').src;
    
    if (!name) { showToast('اسمت رو بنویس!'); return; }

    try {
        const res = await fetch('/api/user/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password, avatar })
        });
        const data = await res.json();
        if (data.success) {
            currentUser = data.user;
            localStorage.setItem('yareman_user_id', currentUser.id);
            localStorage.setItem('yareman_token', data.token);
            document.getElementById('registerModal').remove();
            
            if (currentUser.id === 'admin_milad') {
                isAdmin = true;
                document.getElementById('adminBtn').classList.add('show');
            }
            afterLogin();
            showToast('✨ خوش آمدی ' + currentUser.name, 'success');
        } else {
            showToast('خطا: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('خطا در ارتباط با سرور', 'error');
    }
}

function afterLogin() {
    document.getElementById('userName').textContent = currentUser.name;
    document.getElementById('avatarImg').src = currentUser.avatar || defaultAvatar(currentUser.name);
    document.getElementById('composerAvatar').src = currentUser.avatar || defaultAvatar(currentUser.name);
    document.getElementById('composerName').textContent = currentUser.name;
    document.getElementById('userScore').textContent = `🏆 ${formatNumber(currentUser.score || 0)}`;
    
    socket.emit('join', currentUser.id);
    setupNav();
    loadPageData('channel');
    
    socket.on('broadcast', (data) => {
        showToast(`📢 ${data.title || 'اعلان'}: ${data.message}`, 'info');
    });
    
    socket.on('notification', (data) => {
        showToast(`🔔 ${data.title}: ${data.message}`, 'info');
    });
    
    socket.on('message_sent', (data) => {
        if (!data.success) {
            showToast('❌ ' + (data.error || 'پیام ارسال نشد'), 'error');
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
        case 'explore': await loadExplore(); break;
        case 'chat': await loadChatList(); break;
        case 'assistant': await loadAssistantData(); break;
    }
}

// ============================================
// پروفایل
// ============================================
document.getElementById('profileBtn').addEventListener('click', showProfileModal);

async function showProfileModal() {
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(`/api/user/${currentUser.id}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
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
            <h3 style="font-size:16px;">${escapeHtml(currentUser.name)}</h3>
            ${currentUser.bio ? `<p style="color:var(--text-secondary);font-size:12px;">${escapeHtml(currentUser.bio)}</p>` : ''}
            <div class="profile-stats">
                <div><b>${formatNumber(currentUser.followers || 0)}</b><span>فالوور</span></div>
                <div><b>${formatNumber(currentUser.score || 0)}</b><span>امتیاز</span></div>
            </div>
            <div class="profile-actions">
                <button class="btn btn-secondary" onclick="document.querySelector('[data-page=assistant]').click(); closeModal();">
                    <i class="fas fa-robot"></i> دستیار
                </button>
                <button class="btn btn-secondary" onclick="closeModal()">بستن</button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    document.getElementById('myAvatarInput').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = async (ev) => {
                const b64 = ev.target.result;
                document.getElementById('myAvatarPreview').src = b64;
                document.getElementById('avatarImg').src = b64;
                document.getElementById('composerAvatar').src = b64;
                currentUser.avatar = b64;
                try {
                    const token = localStorage.getItem('yareman_token');
                    await fetch('/api/user/avatar', {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({ userId: currentUser.id, avatar: b64 })
                    });
                    showToast('✅ عکس پروفایل به‌روز شد', 'success');
                } catch (e) { showToast('خطا', 'error'); }
            };
            reader.readAsDataURL(file);
        }
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
    const maxMb = type === 'video' ? 500 : 50;
    if (file.size > maxMb * 1024 * 1024) {
        showToast(`حجم فایل نباید بیشتر از ${maxMb} مگابایت باشه`, 'error');
        return;
    }
    uploadMediaFile(file, type);
}

function uploadMediaFile(file, type) {
    const container = document.getElementById('mediaPreview');
    const content = document.getElementById('mediaPreviewContent');
    if (!container || !content) return;

    container.style.display = 'block';
    pendingMediaUrl = null;
    pendingMediaType = null;
    content.innerHTML = `
        <div class="upload-progress">
            <i class="fas fa-spinner fa-spin"></i>
            <div class="progress-bar-track"><div class="progress-bar-fill" id="mediaProgressFill" style="width:0%"></div></div>
            <span id="mediaProgressText">در حال آپلود... ۰٪</span>
        </div>`;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('userId', currentUser.id);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Authorization', `Bearer ${localStorage.getItem('yareman_token')}`);
    
    xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        const fill = document.getElementById('mediaProgressFill');
        const text = document.getElementById('mediaProgressText');
        if (fill) fill.style.width = pct + '%';
        if (text) text.textContent = `در حال آپلود... ${pct}٪`;
    };
    
    xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && data && data.success) {
            // بررسی وضعیت پردازش
            checkUploadStatus(data.jobId);
        } else {
            showToast('❌ ' + (data?.error || 'آپلود ناموفق بود'), 'error');
            removeMedia();
        }
    };
    
    xhr.onerror = () => {
        showToast('❌ خطا در ارتباط با سرور', 'error');
        removeMedia();
    };
    xhr.send(formData);
}

async function checkUploadStatus(jobId) {
    try {
        const res = await fetch(`/api/upload/status/${jobId}`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('yareman_token')}` }
        });
        const data = await res.json();
        
        if (data.state === 'completed' && data.result) {
            pendingMediaUrl = data.result.url;
            pendingMediaType = data.result.mediaType || 
                (data.result.format === 'mp4' ? 'video' : 'image');
            showMediaPreview(data.result.url, pendingMediaType);
            showToast('✅ فایل با موفقیت آپلود شد', 'success');
        } else if (data.state === 'failed') {
            showToast('❌ پردازش فایل ناموفق بود', 'error');
            removeMedia();
        } else {
            // ادامه بررسی
            setTimeout(() => checkUploadStatus(jobId), 2000);
        }
    } catch (e) {
        showToast('❌ خطا در بررسی وضعیت', 'error');
        removeMedia();
    }
}

function showMediaPreview(url, type) {
    const container = document.getElementById('mediaPreview');
    const content = document.getElementById('mediaPreviewContent');
    if (!container || !content) return;
    container.style.display = 'block';
    if (type === 'video') {
        content.innerHTML = `<video src="${url}" controls preload="metadata"></video>`;
    } else {
        content.innerHTML = `<img src="${url}" loading="lazy">`;
    }
}

function removeMedia() {
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
    if (!content) { showToast('یه متنی برای پست بنویس!', 'warning'); return; }
    
    const btn = document.getElementById('publishBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> در حال ارسال...';

    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch('/api/post/create', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
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
            showToast('✅ پست منتشر شد', 'success');
            if (data.boost) updateBoostBadge(data.boost.boostLevel);
            await loadChannelPosts();
        } else {
            showToast('خطا: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('خطا در ارتباط با سرور', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-paper-plane"></i> انتشار';
    }
}

async function loadChannelPosts() {
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(`/api/channel/${currentUser.id}/posts`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        const container = document.getElementById('channelPosts');
        if (!container) return;

        const posts = data.posts || data;
        if (!posts.length) {
            container.innerHTML = `<div class="empty-state">
                <i class="fas fa-pen-fancy"></i>
                هنوز پستی منتشر نکردی.<br>اولین پستت رو بنویس! ✍️
            </div>`;
        } else {
            let html = '';
            let ads = [];
            try {
                const adsRes = await fetch('/api/ads/active');
                ads = await adsRes.json();
            } catch (e) {}
            
            posts.forEach((p, i) => {
                html += renderPostCard(p);
                if (ads.length && (i + 1) % 5 === 0) {
                    const ad = ads[i % ads.length];
                    html += renderAdCard(ad);
                }
            });
            container.innerHTML = html;
        }

        const ures = await fetch(`/api/user/${currentUser.id}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const u = await ures.json();
        document.getElementById('followersCount').textContent = `${formatNumber(u.followers || 0)} فالوور`;
    } catch (e) {
        console.error(e);
    }
}

function renderAdCard(ad) {
    return `
    <div class="post-card ad-card" style="border-color:var(--pistachio);">
        <div class="post-head">
            <span class="name">🎯 ${escapeHtml(ad.title)}</span>
            <span class="time" style="background:var(--pistachio-dark);color:#fff;padding:0 8px;border-radius:var(--radius-full);font-size:9px;">تبلیغ</span>
        </div>
        ${ad.content ? `<p class="content">${escapeHtml(ad.content)}</p>` : ''}
        ${ad.media_url ? `<div class="media-wrapper">${ad.media_type === 'video' ?
            `<video src="${ad.media_url}" controls preload="metadata"></video>` :
            `<img src="${ad.media_url}" loading="lazy">`}</div>` : ''}
        ${ad.link_url ? `<a href="${ad.link_url}" target="_blank" rel="noopener" style="display:block;text-align:center;padding:8px;background:var(--primary);color:#fff;border-radius:0 0 var(--radius) var(--radius);font-size:12px;font-weight:600;">مشاهده</a>` : ''}
    </div>`;
}

function renderPostCard(post) {
    const name = post.channel_name || 'کاربر';
    const avatar = post.avatar || defaultAvatar(name);
    const mediaHtml = post.media_url ? `
        <div class="media-wrapper">
            ${post.media_type === 'video' ? 
                `<video src="${post.media_url}" controls preload="metadata" poster="${post.thumbnail_url || ''}"></video>` : 
                `<img src="${post.media_url}" loading="lazy">`}
        </div>` : '';
    
    return `
    <div class="post-card" data-post-id="${post.id}">
        <div class="post-head" onclick="openProfile('${post.user_id || currentUser.id}')">
            <img src="${avatar}" loading="lazy">
            <span class="name">${escapeHtml(name)}</span>
            <span class="time">${timeAgo(post.created_at)}</span>
            <button class="post-menu-btn" onclick="event.stopPropagation();togglePostMenu('${post.id}')">
                <i class="fas fa-ellipsis-vertical"></i>
            </button>
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
                <i class="far fa-share-from-square"></i>
            </button>
            <span style="margin-right:auto;font-size:10px;color:var(--text-muted);">
                <i class="far fa-eye"></i> ${formatNumber(post.views || 0)}
            </span>
        </div>
        <div class="comments-box" id="comments-${post.id}"></div>
    </div>`;
}

function togglePostMenu(postId) {
    const dropdown = document.getElementById(`postMenu-${postId}`);
    if (dropdown) {
        dropdown.classList.toggle('open');
    } else {
        // ایجاد منو
        const btn = document.querySelector(`[data-post-id="${postId}"] .post-menu-btn`);
        if (btn) {
            const menu = document.createElement('div');
            menu.className = 'post-menu-dropdown';
            menu.id = `postMenu-${postId}`;
            menu.style.cssText = `
                position:absolute;top:100%;right:0;z-index:20;
                background:var(--bg-card);border:1px solid var(--border-color);
                border-radius:var(--radius-sm);box-shadow:var(--shadow);
                min-width:120px;overflow:hidden;
            `;
            menu.innerHTML = `
                <button onclick="openReportModal('post','${postId}')" style="width:100%;text-align:right;background:none;border:none;color:var(--danger);padding:8px 12px;font-size:11px;display:flex;align-items:center;gap:6px;cursor:pointer;">
                    <i class="fas fa-flag"></i> گزارش
                </button>
            `;
            btn.parentElement.style.position = 'relative';
            btn.parentElement.appendChild(menu);
            setTimeout(() => menu.classList.add('open'), 10);
        }
    }
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.post-menu-btn') && !e.target.closest('.post-menu-dropdown')) {
        document.querySelectorAll('.post-menu-dropdown.open').forEach(d => d.classList.remove('open'));
    }
});

async function toggleLike(postId, btn) {
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(`/api/post/${postId}/like`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ userId: currentUser.id })
        });
        const data = await res.json();
        if (data.success) {
            btn.classList.toggle('liked', data.liked);
            btn.querySelector('i').className = data.liked ? 'fas fa-heart' : 'far fa-heart';
            btn.querySelector('.like-count').textContent = formatNumber(data.likes);
        }
    } catch (e) {
        showToast('خطا', 'error');
    }
}

async function toggleComments(postId, btn) {
    const box = document.getElementById(`comments-${postId}`);
    if (!box) return;
    box.classList.toggle('open');
    if (box.classList.contains('open') && !box.dataset.loaded) {
        box.dataset.loaded = '1';
        try {
            const token = localStorage.getItem('yareman_token');
            const res = await fetch(`/api/post/${postId}/comments`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const comments = await res.json();
            const commentsData = comments.comments || comments;
            box.innerHTML = (commentsData.map(c => `
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
                    <button onclick="submitComment('${postId}')">ارسال</button>
                </div>`;
        } catch (e) { showToast('خطا', 'error'); }
    }
}

async function submitComment(postId) {
    const input = document.getElementById(`commentInput-${postId}`);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(`/api/post/${postId}/comment`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
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
    } catch (e) { showToast('خطا', 'error'); }
}

async function sharePost(postId) {
    const shareUrl = `${location.origin}${location.pathname}?post=${postId}`;
    try {
        if (navigator.share) {
            await navigator.share({ title: 'یارِ من', text: 'یه پست جالب', url: shareUrl });
        } else {
            await navigator.clipboard.writeText(shareUrl);
            showToast('🔗 لینک پست کپی شد', 'success');
        }
    } catch (e) {}
}

// ============================================
// اکسپلور با Infinite Scroll
// ============================================
async function loadExplore(reset = true) {
    if (reset) {
        exploreCursor = null;
        exploreEnd = false;
        document.getElementById('exploreContent').innerHTML = '';
    }
    if (exploreEnd || exploreLoading) return;
    
    exploreLoading = true;
    document.getElementById('exploreLoading').style.display = 'block';

    try {
        const token = localStorage.getItem('yareman_token');
        const url = `/api/explore?limit=20${exploreCursor ? '&cursor=' + encodeURIComponent(exploreCursor) : ''}`;
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        const data = await res.json();
        
        const container = document.getElementById('exploreContent');
        const items = data.items || [];
        
        if (!items.length) {
            if (reset) {
                container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">
                    <i class="fas fa-compass"></i>
                    هنوز پستی در اکسپلور وجود نداره.<br>اولین پست رو تو منتشر کن! 🚀
                </div>`;
            }
            exploreEnd = true;
            return;
        }

        let html = '';
        items.forEach(item => {
            const posts = item.recent_posts || [];
            posts.forEach(p => {
                if (p.media_url) {
                    html += `
                        <div class="explore-tile" onclick="openPostDetail('${p.id}')">
                            ${p.media_type === 'video' ?
                                `<video src="${p.media_url}" muted preload="metadata"></video>
                                 <i class="fas fa-play tile-badge"></i>` :
                                `<img src="${p.media_url}" loading="lazy">`}
                            <div class="tile-overlay">
                                <span><i class="fas fa-heart"></i>${formatNumber(p.likes || 0)}</span>
                                <span><i class="fas fa-comment"></i>${formatNumber(p.comments || 0)}</span>
                            </div>
                        </div>
                    `;
                } else {
                    html += `
                        <div class="explore-tile no-media" onclick="openPostDetail('${p.id}')">
                            <p>${escapeHtml((p.content || '').substring(0, 80))}</p>
                            <div class="tile-overlay">
                                <span><i class="fas fa-heart"></i>${formatNumber(p.likes || 0)}</span>
                                <span><i class="fas fa-comment"></i>${formatNumber(p.comments || 0)}</span>
                            </div>
                        </div>
                    `;
                }
            });
        });

        if (reset) {
            container.innerHTML = html;
        } else {
            container.insertAdjacentHTML('beforeend', html);
        }

        exploreCursor = data.nextCursor || null;
        exploreEnd = !exploreCursor;

    } catch (e) {
        console.error(e);
        showToast('خطا در بارگذاری اکسپلور', 'error');
    } finally {
        exploreLoading = false;
        document.getElementById('exploreLoading').style.display = 'none';
    }
}

// Infinite Scroll
let scrollTimeout;
window.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
        const explorePage = document.getElementById('explorePage');
        if (!explorePage.classList.contains('active')) return;
        
        const scrollBottom = window.innerHeight + window.scrollY;
        const docHeight = document.documentElement.scrollHeight;
        if (scrollBottom >= docHeight - 200) {
            loadExplore(false);
        }
    }, 200);
});

// ============================================
// جزئیات پست (تمام‌صفحه)
// ============================================
let currentDetailPostId = null;
let detailPostData = null;

async function openPostDetail(postId) {
    currentDetailPostId = postId;
    
    // پیدا کردن پست از داده‌های اکسپلور
    const tiles = document.querySelectorAll('.explore-tile');
    let found = false;
    for (const tile of tiles) {
        const onclick = tile.getAttribute('onclick');
        if (onclick && onclick.includes(postId)) {
            // استخراج داده از tile
            break;
        }
    }

    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(`/api/post/${postId}/detail`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        detailPostData = data;
        showPostDetailModal(data);
    } catch (e) {
        showToast('خطا در بارگذاری پست', 'error');
    }
}

function showPostDetailModal(post) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'postDetailModal';
    modal.style.alignItems = 'flex-end';
    modal.style.padding = '0';
    modal.innerHTML = `
        <div class="modal-content" style="max-width:100%;border-radius:24px 24px 0 0;max-height:92vh;padding:0;overflow:hidden;">
            <div style="padding:12px 14px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border-color);position:sticky;top:0;background:var(--bg-card);z-index:2;">
                <img src="${post.avatar || defaultAvatar(post.user_name)}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:2px solid var(--primary);cursor:pointer;" onclick="closeModal();openProfile('${post.user_id}')">
                <div style="flex:1;cursor:pointer;" onclick="closeModal();openProfile('${post.user_id}')">
                    <strong style="font-size:14px;">${escapeHtml(post.user_name)}</strong>
                    <span style="font-size:10px;color:var(--text-muted);display:block;">${timeAgo(post.created_at)}</span>
                </div>
                <button class="header-btn" onclick="closeModal()"><i class="fas fa-times"></i></button>
            </div>
            ${post.media_url ? `<div style="background:#000;display:flex;align-items:center;justify-content:center;max-height:50vh;overflow:hidden;">
                ${post.media_type === 'video' ? 
                    `<video src="${post.media_url}" controls preload="metadata" style="width:100%;max-height:50vh;object-fit:contain;"></video>` : 
                    `<img src="${post.media_url}" style="width:100%;max-height:50vh;object-fit:contain;">`}
            </div>` : ''}
            <div style="padding:12px 14px;">
                <p style="font-size:13px;line-height:1.8;">${escapeHtml(post.content)}</p>
                <div style="display:flex;gap:16px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border-color);">
                    <button onclick="toggleLike('${post.id}', this)" class="like-btn" style="background:none;border:none;color:var(--text-secondary);font-size:13px;display:flex;align-items:center;gap:4px;cursor:pointer;font-family:inherit;">
                        <i class="far fa-heart"></i> <span class="like-count">${formatNumber(post.likes || 0)}</span>
                    </button>
                    <button onclick="toggleCommentsDetail('${post.id}')" style="background:none;border:none;color:var(--text-secondary);font-size:13px;display:flex;align-items:center;gap:4px;cursor:pointer;font-family:inherit;">
                        <i class="far fa-comment"></i> <span>${formatNumber(post.comments || 0)}</span>
                    </button>
                    <button onclick="sharePost('${post.id}')" style="background:none;border:none;color:var(--text-secondary);font-size:13px;display:flex;align-items:center;gap:4px;cursor:pointer;font-family:inherit;">
                        <i class="far fa-share-from-square"></i>
                    </button>
                    <button onclick="openReportModal('post','${post.id}');closeModal();" style="background:none;border:none;color:var(--text-muted);font-size:13px;cursor:pointer;margin-right:auto;font-family:inherit;">
                        <i class="fas fa-flag"></i>
                    </button>
                </div>
                <div id="detailComments" style="margin-top:10px;max-height:200px;overflow-y:auto;"></div>
                <div class="comment-form" style="margin-top:8px;">
                    <input type="text" id="detailCommentInput" placeholder="کامنت بنویس..." style="flex:1;background:var(--bg-input);border:1px solid var(--border-color);border-radius:var(--radius-full);padding:6px 12px;color:var(--text-primary);font-size:12px;outline:none;font-family:inherit;">
                    <button onclick="submitDetailComment('${post.id}')" style="padding:6px 14px;border-radius:var(--radius-full);border:none;background:linear-gradient(135deg,var(--primary),var(--primary-dark));color:#fff;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;">ارسال</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

async function toggleCommentsDetail(postId) {
    const container = document.getElementById('detailComments');
    if (!container) return;
    if (container.dataset.loaded) {
        container.style.display = container.style.display === 'none' ? 'block' : 'none';
        return;
    }
    container.dataset.loaded = '1';
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(`/api/post/${postId}/comments`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const comments = await res.json();
        const commentsData = comments.comments || comments;
        container.innerHTML = commentsData.map(c => `
            <div class="comment-item">
                <img src="${c.avatar || defaultAvatar(c.name)}" loading="lazy">
                <div>
                    <b>${escapeHtml(c.name)}</b>
                    <span class="comment-text">${escapeHtml(c.text)}</span>
                </div>
            </div>
        `).join('') || '<p style="color:var(--text-muted);font-size:11px;">هنوز کامنتی وجود ندارد</p>';
        container.style.display = 'block';
    } catch (e) { showToast('خطا', 'error'); }
}

async function submitDetailComment(postId) {
    const input = document.getElementById('detailCommentInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(`/api/post/${postId}/comment`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ userId: currentUser.id, text })
        });
        const data = await res.json();
        if (data.success) {
            input.value = '';
            const container = document.getElementById('detailComments');
            if (container) {
                const item = document.createElement('div');
                item.className = 'comment-item';
                item.innerHTML = `
                    <img src="${data.comment.avatar || defaultAvatar(data.comment.name)}" loading="lazy">
                    <div>
                        <b>${escapeHtml(data.comment.name)}</b>
                        <span class="comment-text">${escapeHtml(data.comment.text)}</span>
                    </div>
                `;
                container.insertBefore(item, container.firstChild);
                container.style.display = 'block';
                // به‌روزرسانی شمارنده
                const countEl = document.querySelector('#postDetailModal .fa-comment + span');
                if (countEl) countEl.textContent = formatNumber(parseInt(countEl.textContent.replace(/,/g, '')) + 1);
            }
        }
    } catch (e) { showToast('خطا', 'error'); }
}

// ============================================
// پروفایل عمومی
// ============================================
async function openProfile(userId) {
    viewingProfileId = userId;
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(`/api/profile/${userId}?viewerId=${currentUser.id}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();

        document.getElementById('viewAvatar').src = data.user.avatar || defaultAvatar(data.user.name);
        document.getElementById('viewName').textContent = data.user.name;
        document.getElementById('viewBio').textContent = data.user.bio || '';
        document.getElementById('viewFollowers').textContent = formatNumber(data.channel?.followers_count || 0);
        document.getElementById('viewPosts').textContent = formatNumber(data.channel?.posts_count || 0);
        document.getElementById('viewScore').textContent = formatNumber(data.user.score || 0);

        viewingProfileFollowing = data.isFollowing;
        const followBtn = document.getElementById('viewFollowBtn');
        followBtn.textContent = viewingProfileFollowing ? 'فالو شده ✓' : 'فالو';

        const container = document.getElementById('viewPostsContainer');
        container.innerHTML = data.posts.length ?
            data.posts.map(p => renderPostCard({ ...p, user_id: userId, avatar: data.user.avatar })).join('') :
            `<div class="empty-state"><i class="fas fa-pen-fancy"></i>این کاربر هنوز پستی منتشر نکرده.</div>`;

        document.getElementById('viewAssistantChat').innerHTML = '';

        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById('profilePage').classList.add('active');
    } catch (e) {
        showToast('خطا در بارگذاری پروفایل', 'error');
    }
}

function backFromProfile() {
    document.querySelector('[data-page="explore"]').click();
}

async function toggleFollowView() {
    if (!viewingProfileId) return;
    const endpoint = viewingProfileFollowing ? '/api/unfollow' : '/api/follow';
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ followerId: currentUser.id, followingId: viewingProfileId })
        });
        const data = await res.json();
        if (data.success) {
            viewingProfileFollowing = !viewingProfileFollowing;
            const followBtn = document.getElementById('viewFollowBtn');
            followBtn.textContent = viewingProfileFollowing ? 'فالو شده ✓' : 'فالو';
            const count = document.getElementById('viewFollowers');
            count.textContent = formatNumber(parseInt(count.textContent.replace(/,/g, '')) + (viewingProfileFollowing ? 1 : -1));
            showToast(viewingProfileFollowing ? '✅ فالو شد' : '❌ آنفالو شد', 'success');
        }
    } catch (e) { showToast('خطا', 'error'); }
}

async function askOtherAssistant() {
    const input = document.getElementById('viewAssistantInput');
    const msg = input.value.trim();
    if (!msg || !viewingProfileId) return;
    appendChatMessage('viewAssistantChat', msg, 'sent');
    input.value = '';

    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(`/api/assistant/chat/${viewingProfileId}`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ message: msg, userId: currentUser.id })
        });
        const data = await res.json();
        appendChatMessage('viewAssistantChat', data.reply || 'دستیار هنوز جوابی نداره 🤖', 'received');
    } catch (e) { showToast('خطا', 'error'); }
}

function openChatFromProfile() {
    document.querySelector('[data-page="chat"]').click();
    const name = document.getElementById('viewName').textContent;
    const avatar = document.getElementById('viewAvatar').src;
    openChat(viewingProfileId, name, avatar);
}

function openProfileFromChat() {
    if (currentChatUser) {
        const userId = currentChatUser.id;
        closeChatWindow();
        openProfile(userId);
    }
}

// ============================================
// چت خصوصی
// ============================================
async function loadChatList() {
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(`/api/chat/list/${currentUser.id}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const chats = await res.json();
        const container = document.getElementById('chatList');
        if (!container) return;
        
        if (!chats.length) {
            container.innerHTML = `<div class="empty-state">
                <i class="fas fa-message"></i>
                هنوز چتی نداری.<br>از اکسپلور یکی رو پیدا کن و پیام بده! 💬
            </div>`;
            return;
        }
        
        container.innerHTML = chats.map(c => `
            <button class="chat-item" onclick="openChat('${c.id}', '${escapeHtml(c.name)}', '${c.avatar || defaultAvatar(c.name)}')">
                <img src="${c.avatar || defaultAvatar(c.name)}" loading="lazy">
                <div class="info">
                    <strong>${escapeHtml(c.name)}</strong>
                    <p>${c.lastMediaType ? '📎 ' : ''}${escapeHtml(c.lastMessage || '')}</p>
                    <span class="last-time">${timeAgo(c.lastTime)}</span>
                </div>
                ${c.unreadCount > 0 ? `<span class="unread">${c.unreadCount}</span>` : ''}
            </button>
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
    document.getElementById('chatMessages').innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> بارگذاری...</div>';
    document.getElementById('chatThreadOverlay').classList.add('open');

    // بررسی مسدودیت
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(`/api/user/${currentUser.id}/is-blocked/${userId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        document.getElementById('chatStatus').textContent = data.blocked ? '⛔ مسدود شده' : 'آفلاین';
    } catch (e) {}

    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(`/api/chat/history/${currentUser.id}/${userId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        const messages = data.messages || data;
        renderChatMessages(messages);
    } catch (e) { showToast('خطا', 'error'); }
}

function renderChatMessages(messages) {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    container.innerHTML = '';
    messages.forEach(m => {
        const isSent = m.from_user === currentUser.id;
        const div = document.createElement('div');
        div.className = `message ${isSent ? 'sent' : 'received'}`;
        let content = escapeHtml(m.message || '');
        if (m.media_url) {
            if (m.media_type === 'image') {
                content += `<div class="media-preview-msg"><img src="${m.media_url}" loading="lazy"></div>`;
            } else if (m.media_type === 'video') {
                content += `<div class="media-preview-msg"><video src="${m.media_url}" controls preload="metadata"></video></div>`;
            } else if (m.media_type === 'document') {
                content += `<div class="media-preview-msg"><a href="${m.media_url}" target="_blank" style="color:var(--primary);">📄 ${escapeHtml(m.file_name || 'فایل')}</a></div>`;
            }
        }
        content += `<span class="time">${new Date(m.created_at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}</span>`;
        div.innerHTML = content;
        container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
}

function closeChatWindow() {
    document.getElementById('chatThreadOverlay').classList.remove('open');
    currentChatUser = null;
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    if (!message || !currentChatUser || chatFileUploading) return;

    input.value = '';
    appendChatMessage('chatMessages', message, 'sent');

    socket.emit('private_message', {
        from: currentUser.id,
        to: currentChatUser.id,
        message,
        timestamp: Date.now()
    });
}

async function sendChatFile(input) {
    const file = input.files[0];
    if (!file || !currentChatUser) return;
    if (chatFileUploading) return;
    
    const maxMb = 100;
    if (file.size > maxMb * 1024 * 1024) {
        showToast(`حجم فایل نباید بیشتر از ${maxMb} مگابایت باشه`, 'error');
        input.value = '';
        return;
    }

    chatFileUploading = true;
    showToast('⏳ در حال آپلود فایل...', 'info');

    const formData = new FormData();
    formData.append('file', file);
    formData.append('userId', currentUser.id);

    try {
        const xhr = new XMLHttpRequest();
        const uploadPromise = new Promise((resolve, reject) => {
            xhr.open('POST', '/api/upload');
            xhr.setRequestHeader('Authorization', `Bearer ${localStorage.getItem('yareman_token')}`);
            xhr.onload = () => {
                try {
                    const data = JSON.parse(xhr.responseText);
                    if (data.success) {
                        resolve(data.jobId);
                    } else {
                        reject(new Error(data.error || 'Upload failed'));
                    }
                } catch (e) {
                    reject(e);
                }
            };
            xhr.onerror = () => reject(new Error('Network error'));
            xhr.send(formData);
        });

        const jobId = await uploadPromise;
        
        // انتظار برای پردازش
        let result = null;
        let attempts = 0;
        while (!result && attempts < 30) {
            await new Promise(r => setTimeout(r, 2000));
            const statusRes = await fetch(`/api/upload/status/${jobId}`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('yareman_token')}` }
            });
            const statusData = await statusRes.json();
            if (statusData.state === 'completed') {
                result = statusData.result;
                break;
            } else if (statusData.state === 'failed') {
                throw new Error('Processing failed');
            }
            attempts++;
        }

        if (!result) throw new Error('Timeout');

        const mediaType = result.format === 'mp4' || result.format === 'video' ? 'video' : 
                         result.format === 'image' || result.format === 'webp' ? 'image' : 'document';

        // ارسال پیام با مدیا
        const sendData = {
            from: currentUser.id,
            to: currentChatUser.id,
            message: '',
            mediaUrl: result.url,
            mediaType: mediaType,
            fileName: file.name,
            fileSize: file.size,
            timestamp: Date.now()
        };

        socket.emit('private_message', sendData);
        appendChatMessage('chatMessages', '', 'sent', { 
            url: result.url, 
            type: mediaType, 
            name: file.name 
        });

        showToast('✅ فایل ارسال شد', 'success');

    } catch (e) {
        showToast('❌ خطا در ارسال فایل: ' + e.message, 'error');
    } finally {
        chatFileUploading = false;
        input.value = '';
    }
}

function toggleChatMenu() {
    // منوی چت
    showToast('گزینه‌های چت در حال توسعه', 'info');
}

// Socket events for chat
socket.on('new_message', (data) => {
    if (currentChatUser && data.from === currentChatUser.id) {
        appendChatMessage('chatMessages', data.message || '', 'received', 
            data.mediaUrl ? { url: data.mediaUrl, type: data.mediaType, name: data.fileName } : null
        );
        // Mark as read
        socket.emit('read_messages', { userId: currentUser.id, fromUser: data.from });
    } else {
        showToast(`📩 پیام جدید از ${data.from}`, 'info');
        loadChatList();
    }
});

socket.on('user_typing', (data) => {
    if (currentChatUser && data.from === currentChatUser.id) {
        document.getElementById('chatStatus').textContent = 'در حال تایپ...';
        clearTimeout(window.typingTimeout);
        window.typingTimeout = setTimeout(() => {
            document.getElementById('chatStatus').textContent = 'آفلاین';
        }, 3000);
    }
});

// ============================================
// دستیار
// ============================================
async function loadAssistantData() {
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(`/api/assistant/${currentUser.id}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();

        document.getElementById('astPosts').textContent = formatNumber(data.stats?.totalPosts ?? 0);
        document.getElementById('astTrain').textContent = formatNumber(data.stats?.totalTrainings ?? 0);
        document.getElementById('astFollowers').textContent = formatNumber(data.stats?.followers ?? 0);
        document.getElementById('astEngagement').textContent = data.stats?.engagementRate ?? '0%';

        const qaList = document.getElementById('qaList');
        qaList.innerHTML = data.qa?.length ? data.qa.map(q => `
            <div style="padding:4px 0;border-bottom:1px solid var(--border-color);font-size:11px;">
                <span style="color:var(--text-secondary);">❓ ${escapeHtml(q.question)}</span>
                <span style="color:var(--text-primary);display:block;">💬 ${escapeHtml(q.answer)}</span>
            </div>
        `).join('') : '<p style="color:var(--text-muted);font-size:11px;padding:4px 0;">هنوز آموزشی ثبت نشده.</p>';

        const keywordList = document.getElementById('keywordList');
        keywordList.innerHTML = data.keywords?.length ? data.keywords.map(k => `
            <div style="padding:4px 0;border-bottom:1px solid var(--border-color);font-size:11px;">
                <span style="color:var(--text-secondary);">🔑 ${escapeHtml(k.keyword)}</span>
                <span style="color:var(--text-primary);display:block;">💬 ${escapeHtml(k.response)}</span>
            </div>
        `).join('') : '<p style="color:var(--text-muted);font-size:11px;padding:4px 0;">هنوز کلمه کلیدی ثبت نشده.</p>';

        const scheduledList = document.getElementById('scheduledPostsList');
        if (data.posts?.length) {
            scheduledList.innerHTML = data.posts.map(p => `
                <div style="font-size:10px;color:var(--text-secondary);padding:4px 0;border-bottom:1px solid var(--border-color);display:flex;justify-content:space-between;align-items:center;">
                    <span>📅 ${escapeHtml(p.content?.substring(0, 30) || '')}...</span>
                    <span style="font-size:9px;color:var(--text-muted);">${new Date(p.scheduled_time).toLocaleString('fa-IR')}</span>
                </div>
            `).join('');
        } else {
            scheduledList.innerHTML = '<p style="color:var(--text-muted);font-size:11px;padding:4px 0;">هیچ پست زمان‌بندی شده‌ای وجود ندارد.</p>';
        }
    } catch (e) { console.error(e); }
}

async function trainAssistant() {
    const question = document.getElementById('questionInput').value.trim();
    const answer = document.getElementById('answerInput').value.trim();
    if (!question || !answer) { showToast('سوال و جواب رو کامل کن!', 'warning'); return; }

    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch('/api/assistant/train', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ userId: currentUser.id, question, answer })
        });
        const data = await res.json();
        if (data.success) {
            showToast('✅ دستیار یاد گرفت', 'success');
            document.getElementById('questionInput').value = '';
            document.getElementById('answerInput').value = '';
            if (data.boost) updateBoostBadge(data.boost.boostLevel);
            await loadAssistantData();
        }
    } catch (e) { showToast('خطا', 'error'); }
}

async function trainKeyword() {
    const keyword = document.getElementById('keywordInput').value.trim();
    const response = document.getElementById('keywordResponseInput').value.trim();
    if (!keyword || !response) { showToast('کلمه کلیدی و پاسخ رو کامل کن!', 'warning'); return; }

    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch('/api/assistant/keyword', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ userId: currentUser.id, keyword, response })
        });
        const data = await res.json();
        if (data.success) {
            showToast('✅ کلمه کلیدی ثبت شد', 'success');
            document.getElementById('keywordInput').value = '';
            document.getElementById('keywordResponseInput').value = '';
            if (data.boost) updateBoostBadge(data.boost.boostLevel);
            await loadAssistantData();
        }
    } catch (e) { showToast('خطا', 'error'); }
}

function toggleAutoPost() {
    const panel = document.getElementById('autoPostPanel');
    if (panel) {
        panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    }
}

async function askAssistant() {
    const input = document.getElementById('assistantInput');
    const msg = input.value.trim();
    if (!msg) return;
    appendChatMessage('assistantChat', msg, 'sent');
    input.value = '';

    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(`/api/assistant/chat/${currentUser.id}`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ message: msg, userId: currentUser.id })
        });
        const data = await res.json();
        appendChatMessage('assistantChat', data.reply || 'دستیار هنوز جوابی نداره 🤖', 'received');
    } catch (e) { showToast('خطا', 'error'); }
}

async function schedulePosts() {
    const count = parseInt(document.getElementById('postCount').value);
    const descriptions = document.getElementById('postDescriptions').value.split('\n').filter(s => s.trim());
    const time = document.getElementById('postTime').value;
    const interval = parseInt(document.getElementById('postInterval').value) || 1;

    if (!count || count < 1) { showToast('تعداد پست‌ها رو مشخص کن!', 'warning'); return; }
    if (descriptions.length < count) { showToast(`حداقل ${count} توضیح وارد کن.`, 'warning'); return; }

    const posts = [];
    const baseDate = new Date();
    const [hours, minutes] = time.split(':').map(Number);
    baseDate.setHours(hours || 9, minutes || 0, 0, 0);

    for (let i = 0; i < count; i++) {
        const postDate = new Date(baseDate);
        postDate.setDate(postDate.getDate() + (i * interval));
        posts.push({
            content: descriptions[i] || `پست شماره ${i + 1}`,
            scheduledTime: postDate.toISOString()
        });
    }

    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch('/api/assistant/schedule', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ userId: currentUser.id, posts })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`✅ ${count} پست زمان‌بندی شد`, 'success');
            await loadAssistantData();
        } else {
            showToast('خطا: ' + data.error, 'error');
        }
    } catch (e) { showToast('خطا', 'error'); }
}

// ============================================
// جستجو
// ============================================
document.getElementById('searchInput').addEventListener('input', debounce(async function(e) {
    const q = e.target.value.trim();
    const container = document.getElementById('searchResults');
    if (q.length < 2) {
        if (container) container.remove();
        return;
    }
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
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
            border: 1px solid var(--border-color);
            border-radius: var(--radius-sm);
            margin-top: 4px;
            max-height: 250px;
            overflow-y: auto;
            z-index: 50;
            display: none;
            box-shadow: var(--shadow);
        `;
        document.querySelector('.search-box').appendChild(container);
    }
    
    if (!results.length) {
        container.style.display = 'none';
        return;
    }
    
    container.style.display = 'block';
    container.innerHTML = results.map(r => `
        <div style="padding:6px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border-color);transition:var(--transition);"
             onclick="openProfile('${r.id}')" 
             onmouseover="this.style.background='var(--bg-card-hover)'"
             onmouseout="this.style.background=''">
            <i class="fas fa-${r.type === 'user' ? 'user' : 'bullhorn'}" style="color:var(--text-muted);"></i>
            <span style="font-size:12px;">${escapeHtml(r.name)}</span>
            <span style="font-size:9px;color:var(--text-muted);margin-right:auto;">${r.type === 'user' ? 'کاربر' : 'کانال'}</span>
            ${r.is_verified ? '<i class="fas fa-check-circle" style="color:var(--info);font-size:10px;"></i>' : ''}
        </div>
    `).join('');
}

function debounce(fn, wait) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

// ============================================
// گزارش
// ============================================
function openReportModal(targetType, targetId) {
    document.querySelectorAll('.post-menu-dropdown.open').forEach(d => d.classList.remove('open'));
    document.getElementById('reportModal')?.remove();

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'reportModal';
    modal.innerHTML = `
        <div class="modal-content" style="max-width:340px;">
            <h2>🚩 گزارش</h2>
            <p style="color:var(--text-secondary);font-size:12px;margin-bottom:10px;">دلیل گزارشت رو بنویس</p>
            <textarea id="reportReasonInput" class="modal-input" style="min-height:60px;resize:vertical;text-align:right;" placeholder="مثلاً: محتوای نامناسب، اسپم، آزار..." maxlength="500"></textarea>
            <div style="display:flex;gap:6px;margin-top:8px;">
                <button class="modal-btn" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-color);flex:1;" onclick="document.getElementById('reportModal').remove()">انصراف</button>
                <button class="modal-btn modal-btn-primary" style="flex:1;" onclick="submitReport('${targetType}','${targetId}')">ارسال</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
}

async function submitReport(targetType, targetId) {
    const reason = document.getElementById('reportReasonInput')?.value.trim();
    if (!reason) { showToast('دلیل گزارش رو بنویس', 'warning'); return; }
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch('/api/report', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ reporterId: currentUser.id, targetId, targetType, reason })
        });
        const data = await res.json();
        if (data.success) {
            showToast('✅ گزارش شما ثبت شد', 'success');
            document.getElementById('reportModal')?.remove();
        } else {
            showToast('خطا: ' + data.error, 'error');
        }
    } catch (e) { showToast('خطا', 'error'); }
}

// ============================================
// مدیریت
// ============================================
function toggleAdmin() {
    if (!isAdmin) return;
    const adminPage = document.getElementById('adminPage');
    if (adminPage.classList.contains('active')) {
        document.querySelector('[data-page="channel"]').click();
    } else {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        adminPage.classList.add('active');
        loadAdminData('stats');
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
        const token = localStorage.getItem('yareman_token');
        const headers = { 
            'Authorization': `Bearer ${token}`,
            'userId': 'admin_milad'
        };

        if (type === 'stats') {
            const res = await fetch('/api/admin/stats', { headers });
            const stats = await res.json();
            const container = document.getElementById('adminStatsContent');
            container.innerHTML = `
                <div class="stats-grid">
                    <div class="stat-item"><b>${formatNumber(stats.users)}</b><span>کاربران</span></div>
                    <div class="stat-item"><b>${formatNumber(stats.posts)}</b><span>پست‌ها</span></div>
                    <div class="stat-item"><b>${formatNumber(stats.channels)}</b><span>کانال‌ها</span></div>
                    <div class="stat-item"><b>${formatNumber(stats.messages)}</b><span>پیام‌ها</span></div>
                    <div class="stat-item"><b>${formatNumber(stats.follows)}</b><span>فالوها</span></div>
                    <div class="stat-item"><b>${formatNumber(stats.comments)}</b><span>کامنت‌ها</span></div>
                    <div class="stat-item"><b>${formatNumber(stats.pendingReports)}</b><span>گزارش</span></div>
                    <div class="stat-item"><b>${formatNumber(stats.todayPosts || 0)}</b><span>پست امروز</span></div>
                </div>
            `;
        } else if (type === 'users') {
            const res = await fetch('/api/admin/users', { headers });
            const users = await res.json();
            const container = document.getElementById('adminUsersList');
            container.innerHTML = users.map(u => `
                <div class="admin-item">
                    <span>${escapeHtml(u.name)}${u.is_verified ? ' ✔️' : ''}</span>
                    <span style="font-size:9px;color:var(--text-muted);">${u.role === 'banned' ? '⛔ مسدود' : (u.restricted ? '🔒 محدود' : (u.role || 'user'))}</span>
                    <span style="font-size:9px;color:var(--text-muted);">${formatNumber(u.followers_count || 0)} فالوور</span>
                    <div class="actions">
                        ${u.role !== 'admin' ? `
                            ${u.is_verified ? `<button class="btn-sm-secondary" onclick="adminAction('user','${u.id}','unverify')">✗ تیک</button>`
                                : `<button class="btn-sm-success" onclick="adminAction('user','${u.id}','verify')">✓ تیک</button>`}
                            ${u.restricted ? `<button class="btn-sm-secondary" onclick="adminAction('user','${u.id}','unrestrict')">🔓</button>`
                                : `<button class="btn-sm-secondary" onclick="adminAction('user','${u.id}','restrict')">🔒</button>`}
                            ${u.role === 'banned' ? `<button class="btn-sm-success" onclick="adminAction('user','${u.id}','unban')">✅</button>`
                                : `<button class="btn-sm-danger" onclick="adminAction('user','${u.id}','ban')">⛔</button>`}
                        ` : ''}
                    </div>
                </div>
            `).join('');
        } else if (type === 'posts') {
            const res = await fetch('/api/admin/posts', { headers });
            const posts = await res.json();
            const container = document.getElementById('adminPostsList');
            container.innerHTML = posts.map(p => `
                <div class="admin-item">
                    <span>${escapeHtml((p.content || '').substring(0, 30))}...</span>
                    <span style="font-size:9px;color:var(--text-muted);">${escapeHtml(p.user_name)}</span>
                    <span style="font-size:9px;color:var(--text-muted);">${timeAgo(p.created_at)}</span>
                    <button class="btn-sm-danger" onclick="adminAction('post','${p.id}','delete')">🗑️</button>
                </div>
            `).join('');
        } else if (type === 'reports') {
            const res = await fetch('/api/admin/reports?status=pending', { headers });
            const reports = await res.json();
            const container = document.getElementById('adminReportsList');
            const labels = { user: '👤 کاربر', post: '📝 پست', comment: '💬 کامنت' };
            container.innerHTML = reports.length ? reports.map(r => `
                <div class="admin-item">
                    <span>${labels[r.target_type] || r.target_type}</span>
                    <span style="font-size:9px;color:var(--text-muted);">${escapeHtml(r.reason?.substring(0, 30) || '')}...</span>
                    <span style="font-size:9px;color:var(--text-muted);">${timeAgo(r.created_at)}</span>
                    <div class="actions">
                        <button class="btn-sm-success" onclick="resolveReport('${r.id}')">✅</button>
                        <button class="btn-sm-secondary" onclick="dismissReport('${r.id}')">رد</button>
                    </div>
                </div>
            `).join('') : `<p style="color:var(--text-muted);font-size:12px;text-align:center;padding:10px;">گزارش در انتظاری وجود ندارد 🎉</p>`;
        } else if (type === 'ads') {
            const res = await fetch('/api/admin/ads', { headers });
            const ads = await res.json();
            const container = document.getElementById('adminAdsList');
            container.innerHTML = ads.map(a => `
                <div class="admin-item">
                    <span>${escapeHtml(a.title)}</span>
                    <span style="font-size:9px;color:var(--text-muted);">${a.is_active ? '🟢 فعال' : '⚪ غیرفعال'}</span>
                    <div class="actions">
                        <button class="btn-sm-secondary" onclick="toggleAd('${a.id}', ${a.is_active ? 0 : 1})">${a.is_active ? 'غیرفعال' : 'فعال'}</button>
                        <button class="btn-sm-danger" onclick="deleteAd('${a.id}')">🗑️</button>
                    </div>
                </div>
            `).join('') || `<p style="color:var(--text-muted);font-size:12px;text-align:center;padding:10px;">هنوز تبلیغی ساخته نشده</p>`;
        }
    } catch (e) { console.error(e); showToast('خطا', 'error'); }
}

async function adminAction(type, id, action) {
    if (!confirm(`آیا از انجام این عملیات مطمئن هستید؟`)) return;
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch(`/api/admin/${type}/${action}`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'userId': 'admin_milad'
            },
            body: JSON.stringify({ 
                userId: type === 'user' ? id : undefined,
                postId: type === 'post' ? id : undefined
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast('✅ عملیات موفق', 'success');
            const activeTab = document.querySelector('.admin-tab.active');
            if (activeTab) loadAdminData(activeTab.dataset.tab);
        }
    } catch (e) { showToast('خطا: ' + e.message, 'error'); }
}

async function resolveReport(reportId) {
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch('/api/admin/report/resolve', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'userId': 'admin_milad'
            },
            body: JSON.stringify({ reportId })
        });
        const data = await res.json();
        if (data.success) { showToast('✅ گزارش بررسی شد', 'success'); loadAdminData('reports'); }
    } catch (e) { showToast('خطا', 'error'); }
}

async function dismissReport(reportId) {
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch('/api/admin/report/dismiss', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'userId': 'admin_milad'
            },
            body: JSON.stringify({ reportId })
        });
        const data = await res.json();
        if (data.success) { showToast('گزارش رد شد', 'info'); loadAdminData('reports'); }
    } catch (e) { showToast('خطا', 'error'); }
}

async function createAd() {
    const title = document.getElementById('adTitle').value.trim();
    const content = document.getElementById('adContent').value.trim();
    const linkUrl = document.getElementById('adLink').value.trim();
    if (!title) { showToast('عنوان تبلیغ رو بنویس!', 'warning'); return; }

    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch('/api/admin/ads/create', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'userId': 'admin_milad'
            },
            body: JSON.stringify({ title, content, linkUrl })
        });
        const data = await res.json();
        if (data.success) {
            showToast('✅ تبلیغ ساخته شد', 'success');
            document.getElementById('adTitle').value = '';
            document.getElementById('adContent').value = '';
            document.getElementById('adLink').value = '';
            loadAdminData('ads');
        } else {
            showToast('خطا: ' + data.error, 'error');
        }
    } catch (e) { showToast('خطا', 'error'); }
}

async function toggleAd(adId, active) {
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch('/api/admin/ads/toggle', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'userId': 'admin_milad'
            },
            body: JSON.stringify({ adId, active })
        });
        const data = await res.json();
        if (data.success) loadAdminData('ads');
    } catch (e) { showToast('خطا', 'error'); }
}

async function deleteAd(adId) {
    if (!confirm('این تبلیغ حذف بشه؟')) return;
    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch('/api/admin/ads/delete', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'userId': 'admin_milad'
            },
            body: JSON.stringify({ adId })
        });
        const data = await res.json();
        if (data.success) loadAdminData('ads');
    } catch (e) { showToast('خطا', 'error'); }
}

async function sendBroadcast() {
    const title = document.getElementById('broadcastTitle').value.trim();
    const message = document.getElementById('broadcastMessage').value.trim();
    if (!message) { showToast('متن پیام رو بنویس!', 'warning'); return; }

    try {
        const token = localStorage.getItem('yareman_token');
        const res = await fetch('/api/admin/broadcast', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'userId': 'admin_milad'
            },
            body: JSON.stringify({ title: title || 'اعلان سیستمی', message })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`✅ ${data.message}`, 'success');
            document.getElementById('broadcastTitle').value = '';
            document.getElementById('broadcastMessage').value = '';
        }
    } catch (e) { showToast('خطا', 'error'); }
}

// ============================================
// آپدیت Boost Badge
// ============================================
function updateBoostBadge(level) {
    const badge = document.getElementById('boostBadge');
    if (!badge) return;
    const labels = { 
        normal: 'عادی', 
        high: '🔥 داغ', 
        viral: '🚀 وایرال', 
        superstar: '⭐ ستاره',
        legend: '👑 افسانه'
    };
    badge.textContent = labels[level] || 'عادی';
    badge.className = 'boost-badge boost-' + level;
}

// ============================================
// شروع برنامه
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    initApp();
    
    // به‌روزرسانی دوره‌ای
    setInterval(() => {
        if (document.getElementById('chatPage').classList.contains('active')) {
            loadChatList();
        }
    }, 30000);

    // پیش‌بارگذاری اکسپلور
    setTimeout(() => {
        if (document.getElementById('explorePage').classList.contains('active')) {
            loadExplore();
        }
    }, 1000);
});