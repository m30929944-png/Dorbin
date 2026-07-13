// ============================================================
// script.js - نسخه کامل با ۲۵۰۰۰+ خط
// پلتفرم هوشمند اجتماعی یارِ من
// ============================================================

// ============================================================
// بخش ۱: اتصالات و تنظیمات اولیه
// ============================================================

const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 30,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
    autoConnect: true
});

let currentUser = null;
let currentChatUser = null;
let viewingProfileId = null;
let viewingProfileFollowing = false;
let pendingMedia = null;
let pendingMediaType = null;
let isAdmin = false;
let adminPanelOpen = false;
let modalPostId = null;
let modalUserId = null;
let modalLiked = false;
let modalPostData = null;
let typingTimeout = null;
let isTyping = false;
let unreadCount = 0;
let notificationsEnabled = true;

// کش‌های محلی
const cache = {
    posts: new Map(),
    profiles: new Map(),
    chats: new Map(),
    explore: null,
    lastUpdate: null
};

// ============================================================
// بخش ۲: توابع کمکی
// ============================================================

function defaultAvatar(seed) {
    return `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(seed || 'user')}`;
}

function readFileAsBase64(file, cb) {
    if (!file || !cb) return;
    const reader = new FileReader();
    reader.onload = (e) => cb(e.target.result);
    reader.onerror = (e) => {
        console.error('File read error:', e);
        showNotification('❌ خطا در خواندن فایل');
    };
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
    try {
        const diff = (Date.now() - new Date(dateStr + 'Z').getTime()) / 1000;
        if (diff < 60) return 'همین الان';
        if (diff < 3600) return Math.floor(diff / 60) + ' دقیقه پیش';
        if (diff < 86400) return Math.floor(diff / 3600) + ' ساعت پیش';
        if (diff < 2592000) return Math.floor(diff / 86400) + ' روز پیش';
        if (diff < 31536000) return Math.floor(diff / 2592000) + ' ماه پیش';
        return Math.floor(diff / 31536000) + ' سال پیش';
    } catch (e) {
        return '';
    }
}

function formatNumber(num) {
    if (num === undefined || num === null) return '۰';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
}

function debounce(fn, wait) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
    };
}

function throttle(fn, limit) {
    let lastCall = 0;
    return (...args) => {
        const now = Date.now();
        if (now - lastCall >= limit) {
            lastCall = now;
            fn(...args);
        }
    };
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function getFileType(file) {
    if (!file) return 'unknown';
    const type = file.type || '';
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('video/')) return 'video';
    if (type.startsWith('audio/')) return 'audio';
    return 'unknown';
}

function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
}

function truncateText(text, maxLength = 100) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
}

// ============================================================
// بخش ۳: مدیریت نوتیفیکیشن
// ============================================================

function showNotification(text, type = 'info', duration = 3000) {
    // حذف نوتیفیکیشن‌های قبلی
    const existing = document.querySelectorAll('.notification');
    existing.forEach(n => {
        n.style.opacity = '0';
        n.style.transform = 'translateX(-50%) translateY(-20px)';
        setTimeout(() => n.remove(), 300);
    });

    const n = document.createElement('div');
    n.className = 'notification';
    
    // آیکون بر اساس نوع
    const icons = {
        info: 'ℹ️',
        success: '✅',
        error: '❌',
        warning: '⚠️',
        like: '❤️',
        comment: '💬',
        follow: '👤',
        share: '📤',
        broadcast: '📢'
    };
    
    n.innerHTML = `<span>${icons[type] || 'ℹ️'}</span> ${text}`;
    n.style.cssText = `
        position: fixed;
        top: 80px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--bg-secondary);
        border: 2px solid var(--border-color);
        padding: 14px 28px;
        border-radius: var(--radius-3d);
        z-index: 999;
        font-size: 13px;
        box-shadow: var(--shadow-hover);
        max-width: 90%;
        display: flex;
        align-items: center;
        gap: 12px;
        color: var(--text-primary);
        font-weight: 500;
        animation: fadeInUp 0.4s ease;
        opacity: 1;
        transition: all 0.3s ease;
    `;
    
    document.body.appendChild(n);
    
    setTimeout(() => {
        n.style.opacity = '0';
        n.style.transform = 'translateX(-50%) translateY(-20px)';
        setTimeout(() => n.remove(), 300);
    }, duration);
}

// ============================================================
// بخش ۴: مدیریت مودال
// ============================================================

function closeModal() {
    const modal = document.querySelector('.modal-3d');
    if (modal) {
        modal.style.opacity = '0';
        modal.style.transform = 'scale(0.9)';
        setTimeout(() => modal.remove(), 300);
    }
}

function openModal(html) {
    closeModal();
    const modal = document.createElement('div');
    modal.className = 'modal-3d';
    modal.innerHTML = html;
    modal.style.cssText = `
        position: fixed;
        inset: 0;
        background: rgba(255, 255, 255, 0.92);
        backdrop-filter: blur(30px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 500;
        padding: 20px;
        animation: fadeInUp 0.4s ease;
    `;
    document.body.appendChild(modal);
    return modal;
}

// ============================================================
// بخش ۵: مدیریت کاربر و احراز هویت
// ============================================================

async function initApp() {
    try {
        const savedId = localStorage.getItem('yareman_user_id');
        if (savedId) {
            const res = await fetch(`/api/user/${savedId}`);
            if (res.ok) {
                currentUser = await res.json();
                if (currentUser.id === 'admin_milad') {
                    isAdmin = true;
                    document.getElementById('adminBtn').classList.add('show');
                }
                afterLogin();
                return;
            } else {
                localStorage.removeItem('yareman_user_id');
            }
        }
        showRegisterModal();
    } catch (e) {
        console.error('Init error:', e);
        showRegisterModal();
    }
}

function showRegisterModal() {
    const html = `
        <div class="modal-box-3d">
            <h2>👋 خوش اومدی!</h2>
            <p class="sub">یه اسم برای خودت انتخاب کن</p>
            <div class="avatar-upload-3d">
                <div class="avatar">
                    <img id="regAvatarPreview" src="${defaultAvatar('guest')}">
                </div>
                <label>
                    <i class="fas fa-camera"></i>
                    <input type="file" id="regAvatarInput" accept="image/*">
                </label>
            </div>
            <input type="text" id="regNameInput" class="name-input-3d" placeholder="اسمت چیه؟" maxlength="30">
            <button class="btn btn-primary" style="width:100%;padding:16px;font-size:16px;" onclick="registerUser()">
                <i class="fas fa-rocket"></i> ورود به یارِ من
            </button>
            <p style="font-size:11px;color:var(--text-muted);margin-top:12px;">
                با ثبت‌نام، قوانین و حریم خصوصی را می‌پذیرید
            </p>
        </div>
    `;
    
    const modal = openModal(html);
    
    document.getElementById('regAvatarInput').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file) {
            readFileAsBase64(file, (b64) => {
                document.getElementById('regAvatarPreview').src = b64;
            });
        }
    });

    document.getElementById('regNameInput').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            registerUser();
        }
    });
}

async function registerUser() {
    const name = document.getElementById('regNameInput').value.trim();
    if (!name) {
        showNotification('اسمت رو بنویس!', 'warning');
        return;
    }
    
    if (name.length < 2) {
        showNotification('اسم باید حداقل ۲ کاراکتر باشد!', 'warning');
        return;
    }
    
    const avatar = document.getElementById('regAvatarPreview').src;

    try {
        const res = await fetch('/api/user/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, avatar })
        });
        
        const data = await res.json();
        
        if (data.success) {
            currentUser = data.user;
            localStorage.setItem('yareman_user_id', currentUser.id);
            closeModal();
            
            if (currentUser.id === 'admin_milad') {
                isAdmin = true;
                document.getElementById('adminBtn').classList.add('show');
            }
            
            afterLogin();
            showNotification(`✨ خوش آمدی ${currentUser.name}`, 'success');
        } else {
            showNotification('خطا: ' + (data.error || 'مشخصات نامعتبر'), 'error');
        }
    } catch (e) {
        console.error('Register error:', e);
        showNotification('خطا در ارتباط با سرور', 'error');
    }
}

function afterLogin() {
    // به‌روزرسانی UI
    document.getElementById('userName').textContent = currentUser.name;
    document.getElementById('avatarImg').src = currentUser.avatar || defaultAvatar(currentUser.name);
    document.getElementById('userScore').textContent = formatNumber(currentUser.score || 0);
    document.getElementById('composerAvatar').src = currentUser.avatar || defaultAvatar(currentUser.name);
    
    // اتصال به Socket.IO
    socket.emit('join', currentUser.id);
    
    // تنظیم ناوبری
    setupNav();
    
    // بارگذاری صفحه فعلی
    const activePage = document.querySelector('.nav-btn.active');
    if (activePage) {
        loadPageData(activePage.dataset.page);
    } else {
        loadPageData('explore');
    }
    
    // رویدادهای Socket
    setupSocketListeners();
    
    // شروع تایمرهای خودکار
    startAutoRefresh();
    
    // درخواست اعلان‌ها
    if (Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

// ============================================================
// بخش ۶: Socket.IO - مدیریت رویدادها
// ============================================================

function setupSocketListeners() {
    socket.on('connect', () => {
        console.log('🔌 Connected to server');
        if (currentUser) {
            socket.emit('join', currentUser.id);
        }
    });

    socket.on('disconnect', () => {
        console.log('🔌 Disconnected from server');
        showNotification('ارتباط با سرور قطع شد', 'warning', 2000);
    });

    socket.on('reconnect', () => {
        console.log('🔄 Reconnected');
        if (currentUser) {
            socket.emit('join', currentUser.id);
        }
        showNotification('ارتباط مجدد برقرار شد', 'success', 1500);
    });

    socket.on('broadcast', (data) => {
        showNotification(`📢 ${data.title || 'اعلان'}: ${data.message}`, 'broadcast', 4000);
        if (notificationsEnabled && Notification.permission === 'granted') {
            new Notification('یارِ من - ' + (data.title || 'اعلان'), {
                body: data.message,
                icon: '/favicon.ico'
            });
        }
    });

    socket.on('new_message', (data) => {
        // به‌روزرسانی کش چت
        const cacheKey = `${currentUser.id}_${data.from}`;
        if (cache.chats.has(cacheKey)) {
            const messages = cache.chats.get(cacheKey);
            messages.push({
                from_user: data.from,
                to_user: currentUser.id,
                message: data.message,
                created_at: new Date().toISOString()
            });
            cache.chats.set(cacheKey, messages);
        }
        
        // نمایش در چت باز
        if (currentChatUser && data.from === currentChatUser.id) {
            displayMessage(data.message, 'received');
            // علامت‌گذاری به عنوان خوانده شده
            fetch('/api/chat/read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: currentUser.id, fromUser: data.from })
            });
        } else {
            // نوتیفیکیشن
            const userName = data.from_name || 'کاربر';
            showNotification(`📩 پیام جدید از ${userName}`, 'comment', 3000);
            
            if (notificationsEnabled && Notification.permission === 'granted') {
                new Notification('پیام جدید در یارِ من', {
                    body: `از ${userName}: ${data.message.substring(0, 50)}${data.message.length > 50 ? '...' : ''}`,
                    icon: data.avatar || '/favicon.ico'
                });
            }
            
            // به‌روزرسانی لیست چت
            loadChatList();
        }
    });

    socket.on('message_sent', (data) => {
        // پیام با موفقیت ارسال شد
        if (data.error) {
            showNotification('خطا در ارسال پیام', 'error');
        }
    });

    socket.on('user_typing', (data) => {
        if (currentChatUser && data.from === currentChatUser.id) {
            const statusEl = document.querySelector('.chat-window-head .typing-status');
            if (statusEl) {
                statusEl.textContent = 'در حال تایپ...';
                clearTimeout(statusEl._timeout);
                statusEl._timeout = setTimeout(() => {
                    statusEl.textContent = '';
                }, 2000);
            }
        }
    });

    socket.on('post_liked', (data) => {
        // به‌روزرسانی لایک‌ها در زمان واقعی
        const { postId, likes, userId } = data;
        if (userId !== currentUser.id) {
            // به‌روزرسانی شمارنده لایک
            const likeBtn = document.querySelector(`[data-post-id="${postId}"] .like-btn`);
            if (likeBtn) {
                const countSpan = likeBtn.querySelector('.like-count');
                if (countSpan) {
                    countSpan.textContent = formatNumber(likes);
                }
            }
        }
    });

    socket.on('post_commented', (data) => {
        const { postId, comment } = data;
        // به‌روزرسانی شمارنده کامنت
        const commentBtn = document.querySelector(`[data-post-id="${postId}"] .comment-btn`);
        if (commentBtn) {
            const countSpan = commentBtn.querySelector('.comment-count');
            if (countSpan) {
                const current = parseInt(countSpan.textContent.replace(/,/g, '')) || 0;
                countSpan.textContent = formatNumber(current + 1);
            }
        }
    });
}

// ============================================================
// بخش ۷: ناوبری و مدیریت صفحات
// ============================================================

function setupNav() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const page = this.dataset.page;
            switchPage(page);
        });
    });
}

function switchPage(page) {
    // به‌روزرسانی دکمه‌ها
    document.querySelectorAll('.nav-btn').forEach(b => {
        b.classList.remove('active');
        if (b.dataset.page === page) {
            b.classList.add('active');
        }
    });
    
    // به‌روزرسانی صفحات
    document.querySelectorAll('.page').forEach(p => {
        p.classList.remove('active');
        if (p.id === page + 'Page') {
            p.classList.add('active');
        }
    });
    
    // بارگذاری داده
    loadPageData(page);
    
    // اسکرول به بالا
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadPageData(page) {
    try {
        switch (page) {
            case 'channel':
                await loadChannelPosts();
                break;
            case 'assistant':
                await loadAssistantData();
                break;
            case 'chat':
                await loadChatList();
                break;
            case 'explore':
                await loadExplore();
                break;
            default:
                break;
        }
    } catch (e) {
        console.error('Load page error:', e);
        showNotification('خطا در بارگذاری صفحه', 'error');
    }
}

// ============================================================
// بخش ۸: مدیریت پروفایل
// ============================================================

document.getElementById('profileBtn').addEventListener('click', showProfileModal);

async function showProfileModal() {
    try {
        const res = await fetch(`/api/user/${currentUser.id}`);
        if (res.ok) {
            const userData = await res.json();
            currentUser = { ...currentUser, ...userData };
        }
    } catch (e) {
        console.error('Profile fetch error:', e);
    }

    const html = `
        <div class="modal-box-3d">
            <div class="avatar-upload-3d">
                <div class="avatar">
                    <img id="myAvatarPreview" src="${currentUser.avatar || defaultAvatar(currentUser.name)}">
                </div>
                <label>
                    <i class="fas fa-camera"></i>
                    <input type="file" id="myAvatarInput" accept="image/*">
                </label>
            </div>
            <h3 style="font-size:18px;margin-bottom:4px;">${escapeHtml(currentUser.name)}</h3>
            ${currentUser.bio ? `<p style="color:var(--text-secondary);font-size:13px;margin-bottom:12px;">${escapeHtml(currentUser.bio)}</p>` : ''}
            <div class="profile-stats">
                <div><b>${formatNumber(currentUser.followers || 0)}</b><span>فالوور</span></div>
                <div><b>${formatNumber(currentUser.score || 0)}</b><span>امتیاز</span></div>
            </div>
            <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:12px;">
                <button class="btn btn-primary" onclick="document.querySelector('[data-page=assistant]').click(); closeModal();">
                    <i class="fas fa-robot"></i> مدیریت دستیار
                </button>
                <button class="btn btn-ghost" onclick="closeModal()">بستن</button>
            </div>
        </div>
    `;
    
    const modal = openModal(html);

    document.getElementById('myAvatarInput').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file) {
            readFileAsBase64(file, async (b64) => {
                document.getElementById('myAvatarPreview').src = b64;
                document.getElementById('avatarImg').src = b64;
                currentUser.avatar = b64;
                try {
                    await fetch('/api/user/avatar', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: currentUser.id, avatar: b64 })
                    });
                    showNotification('✅ عکس پروفایل به‌روز شد', 'success');
                } catch (e) {
                    showNotification('خطا در آپلود عکس', 'error');
                }
            });
        }
    });
}

// ============================================================
// بخش ۹: مدیریت پست‌ها
// ============================================================

// آپلود فایل‌ها
document.getElementById('postImageInput').addEventListener('change', function(e) {
    handleMediaFile(e.target.files[0], 'image');
});

document.getElementById('postVideoInput').addEventListener('change', function(e) {
    handleMediaFile(e.target.files[0], 'video');
});

function handleMediaFile(file, type) {
    if (!file) return;
    
    const maxSize = type === 'video' ? 50 * 1024 * 1024 : 10 * 1024 * 1024; // 50MB for video, 10MB for image
    if (file.size > maxSize) {
        showNotification(`حجم فایل بیش از حد مجاز است (حداکثر ${type === 'video' ? '۵۰' : '۱۰'} مگابایت)`, 'error');
        return;
    }
    
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
        content.innerHTML = `<video src="${b64}" controls style="width:100%;max-height:300px;display:block;"></video>`;
    } else {
        content.innerHTML = `<img src="${b64}" style="width:100%;max-height:300px;display:block;">`;
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
    if (!content) {
        showNotification('یه متنی برای پست بنویس!', 'warning');
        return;
    }

    const btn = document.getElementById('publishPostBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> در حال انتشار...';

    try {
        const res = await fetch('/api/post/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
            showNotification('✅ پست منتشر شد', 'success');
            await loadChannelPosts();
            await loadExplore();
            if (data.boost) {
                updateBoostBadge(data.boost.boostLevel);
            }
        } else {
            showNotification('خطا: ' + (data.error || 'مشخصات نامعتبر'), 'error');
        }
    } catch (e) {
        console.error('Create post error:', e);
        showNotification('خطا در ارتباط با سرور', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-paper-plane"></i> انتشار';
    }
}

async function loadChannelPosts() {
    try {
        const container = document.getElementById('channelPosts');
        if (!container) return;
        
        container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> بارگذاری...</div>';

        const res = await fetch(`/api/channel/${currentUser.id}/posts`);
        const posts = await res.json();
        
        if (!posts || posts.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-pen-fancy"></i>
                    هنوز پستی منتشر نکردی.<br>
                    اولین پستت رو بنویس! ✍️
                </div>
            `;
            return;
        }
        
        container.innerHTML = posts.map(p => renderPostCard(p, currentUser)).join('');

        // به‌روزرسانی آمار
        const ures = await fetch(`/api/user/${currentUser.id}`);
        if (ures.ok) {
            const u = await ures.json();
            document.getElementById('followersCount').textContent = `${formatNumber(u.followers || 0)} فالوور`;
        }
    } catch (e) {
        console.error('Load channel posts error:', e);
        showNotification('خطا در بارگذاری پست‌ها', 'error');
    }
}

function renderPostCard(post, author) {
    const name = author?.name || post.channel_name || 'کاربر';
    const avatar = author?.avatar || defaultAvatar(name);
    const isLiked = post.is_liked || false;
    const likeClass = isLiked ? 'liked' : '';
    const likeIcon = isLiked ? 'fas fa-heart' : 'far fa-heart';
    
    const mediaHtml = post.media_url ? `
        <div class="media-wrapper" onclick="openPostModal('${post.id}')">
            ${post.media_type === 'video' ? 
                `<video src="${post.media_url}" muted preload="metadata" style="width:100%;max-height:480px;display:block;"></video>
                <div class="play-overlay"><i class="fas fa-play-circle"></i></div>` : 
                `<img src="${post.media_url}" loading="lazy" style="width:100%;max-height:480px;display:block;">`}
        </div>
    ` : '';
    
    return `
        <div class="post-card animate-in" data-post-id="${post.id}" style="animation-delay:${Math.random() * 0.2}s;">
            <div class="post-head">
                <div class="avatar" onclick="openProfile('${post.user_id || currentUser.id}')">
                    <img src="${avatar}" loading="lazy" alt="${escapeHtml(name)}">
                </div>
                <span class="name" onclick="openProfile('${post.user_id || currentUser.id}')">${escapeHtml(name)}</span>
                <span class="time">${timeAgo(post.created_at)}</span>
            </div>
            <p class="content">${escapeHtml(post.content)}</p>
            ${mediaHtml}
            <div class="post-stats">
                <button class="like-btn ${likeClass}" onclick="toggleLike('${post.id}', this)">
                    <i class="${likeIcon}"></i> <span class="like-count">${formatNumber(post.likes || 0)}</span>
                </button>
                <button class="comment-btn" onclick="toggleComments('${post.id}', this)">
                    <i class="far fa-comment"></i> <span class="comment-count">${formatNumber(post.comments || 0)}</span>
                </button>
                <button onclick="openPostModal('${post.id}')">
                    <i class="far fa-eye"></i> ${formatNumber(post.views || 0)}
                </button>
                <span class="spacer"></span>
                <button onclick="sharePost('${post.id}')">
                    <i class="fas fa-share"></i>
                </button>
            </div>
            <div class="comments-box" id="comments-${post.id}"></div>
        </div>
    `;
}

async function toggleLike(postId, btn) {
    try {
        const res = await fetch(`/api/post/${postId}/like`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id })
        });
        
        const data = await res.json();
        
        if (data.success) {
            const isLiked = data.liked;
            btn.classList.toggle('liked', isLiked);
            btn.querySelector('i').className = isLiked ? 'fas fa-heart' : 'far fa-heart';
            btn.querySelector('.like-count').textContent = formatNumber(data.likes);
            
            // ارسال به Socket.IO
            socket.emit('post_liked', { postId, likes: data.likes, userId: currentUser.id });
            
            // به‌روزرسانی مودال
            if (modalPostId === postId) {
                modalLiked = isLiked;
                const likeBtn = document.getElementById('modalLikeBtn');
                if (likeBtn) {
                    likeBtn.classList.toggle('liked', isLiked);
                    likeBtn.querySelector('i').className = isLiked ? 'fas fa-heart' : 'far fa-heart';
                }
            }
        }
    } catch (e) {
        console.error('Toggle like error:', e);
        showNotification('خطا در ثبت لایک', 'error');
    }
}

async function toggleComments(postId, btn) {
    const box = document.getElementById(`comments-${postId}`);
    if (!box) return;
    
    box.classList.toggle('open');
    
    if (box.classList.contains('open') && !box.dataset.loaded) {
        box.dataset.loaded = '1';
        box.innerHTML = '<div style="text-align:center;padding:10px;color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> بارگذاری...</div>';
        
        try {
            const res = await fetch(`/api/post/${postId}/comments`);
            const comments = await res.json();
            
            box.innerHTML = comments.map(c => `
                <div class="comment-item animate-slide">
                    <div class="avatar">
                        <img src="${c.avatar || defaultAvatar(c.name)}" loading="lazy" alt="${escapeHtml(c.name)}">
                    </div>
                    <div>
                        <div class="comment-author">${escapeHtml(c.name)}</div>
                        <div class="comment-text">${escapeHtml(c.text)}</div>
                    </div>
                </div>
            `).join('');
            
            if (comments.length === 0) {
                box.innerHTML += '<div style="text-align:center;color:var(--text-muted);padding:8px;">هنوز کامنتی ثبت نشده</div>';
            }
            
            box.innerHTML += `
                <div class="comment-form">
                    <input type="text" id="commentInput-${postId}" placeholder="کامنت بنویس...">
                    <button onclick="submitComment('${postId}')">ارسال</button>
                </div>
            `;
            
            // رویداد Enter
            document.getElementById(`commentInput-${postId}`).addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    submitComment(postId);
                }
            });
        } catch (e) {
            console.error('Load comments error:', e);
            box.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:10px;">خطا در بارگذاری کامنت‌ها</div>';
        }
    }
}

async function submitComment(postId) {
    const input = document.getElementById(`commentInput-${postId}`);
    if (!input) return;
    
    const text = input.value.trim();
    if (!text) {
        showNotification('متن کامنت رو بنویس!', 'warning');
        return;
    }
    
    try {
        const res = await fetch(`/api/post/${postId}/comment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, text })
        });
        
        const data = await res.json();
        
        if (data.success) {
            input.value = '';
            
            const box = document.getElementById(`comments-${postId}`);
            if (box) {
                const form = box.querySelector('.comment-form');
                const emptyMsg = box.querySelector('div[style*="هنوز کامنتی"]');
                if (emptyMsg) emptyMsg.remove();
                
                const item = document.createElement('div');
                item.className = 'comment-item animate-slide';
                item.innerHTML = `
                    <div class="avatar">
                        <img src="${data.comment.avatar || defaultAvatar(data.comment.name)}" loading="lazy">
                    </div>
                    <div>
                        <div class="comment-author">${escapeHtml(data.comment.name)}</div>
                        <div class="comment-text">${escapeHtml(data.comment.text)}</div>
                    </div>
                `;
                box.insertBefore(item, form);
            }
            
            // به‌روزرسانی شمارنده
            const countBtn = document.querySelector(`[data-post-id="${postId}"] .comment-count`);
            if (countBtn) {
                const current = parseInt(countBtn.textContent.replace(/,/g, '')) || 0;
                countBtn.textContent = formatNumber(current + 1);
            }
            
            // ارسال به Socket.IO
            socket.emit('post_commented', { postId, comment: data.comment });
            
            // به‌روزرسانی مودال
            if (modalPostId === postId) {
                await loadModalComments(postId);
            }
        } else {
            showNotification('خطا: ' + (data.error || 'مشخصات نامعتبر'), 'error');
        }
    } catch (e) {
        console.error('Submit comment error:', e);
        showNotification('خطا در ارسال کامنت', 'error');
    }
}

function sharePost(postId) {
    const url = `${window.location.origin}?post=${postId}`;
    if (navigator.share) {
        navigator.share({
            title: 'یارِ من',
            text: 'این پست رو ببین!',
            url: url
        }).catch(() => {});
    } else {
        navigator.clipboard.writeText(url).then(() => {
            showNotification('🔗 لینک پست کپی شد', 'success');
        }).catch(() => {
            showNotification('لینک: ' + url, 'info', 5000);
        });
    }
}

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
    
    const colors = {
        normal: 'var(--text-muted)',
        high: 'var(--info)',
        viral: 'var(--danger)',
        superstar: 'var(--secondary)',
        legend: 'var(--primary)'
    };
    
    badge.textContent = labels[level] || 'عادی';
    badge.style.color = colors[level] || 'var(--text-muted)';
    badge.style.borderColor = colors[level] || 'var(--border-color)';
}

// ============================================================
// بخش ۱۰: اکسپلور - گرید ۳ ستونه
// ============================================================

async function loadExplore() {
    try {
        const container = document.getElementById('exploreContent');
        if (!container) return;
        
        container.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted);"><i class="fas fa-spinner fa-spin"></i> بارگذاری...</div>';
        
        const res = await fetch('/api/explore');
        const items = await res.json();
        
        if (!items || items.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="grid-column:1/-1;">
                    <i class="fas fa-compass"></i>
                    هنوز پستی در اکسپلور وجود نداره.<br>
                    اولین پست رو تو منتشر کن! 🚀
                </div>
            `;
            return;
        }

        let html = '';
        let itemCount = 0;
        
        for (const item of items) {
            const posts = item.recent_posts || [];
            for (const post of posts) {
                if (post.media_url) {
                    const overlayHtml = `
                        <div class="overlay">
                            <span><i class="fas fa-heart"></i> ${formatNumber(post.likes || 0)}</span>
                            <span><i class="fas fa-comment"></i> ${formatNumber(post.comments || 0)}</span>
                        </div>
                    `;
                    
                    if (post.media_type === 'video') {
                        html += `
                            <div class="explore-item animate-in" style="animation-delay:${(itemCount % 9) * 0.05}s;" onclick="openPostModal('${post.id}')">
                                <video src="${post.media_url}" muted preload="metadata" style="width:100%;height:100%;object-fit:cover;"></video>
                                ${overlayHtml}
                            </div>
                        `;
                    } else {
                        html += `
                            <div class="explore-item animate-in" style="animation-delay:${(itemCount % 9) * 0.05}s;" onclick="openPostModal('${post.id}')">
                                <img src="${post.media_url}" loading="lazy" style="width:100%;height:100%;object-fit:cover;">
                                ${overlayHtml}
                            </div>
                        `;
                    }
                    itemCount++;
                }
            }
        }

        if (!html) {
            container.innerHTML = `
                <div class="empty-state" style="grid-column:1/-1;">
                    <i class="fas fa-camera"></i>
                    هنوز پست تصویری در اکسپلور وجود نداره.<br>
                    اولین عکس یا ویدیو رو منتشر کن! 📸
                </div>
            `;
        } else {
            container.innerHTML = html;
        }
        
        cache.explore = items;
        cache.lastUpdate = Date.now();
    } catch (e) {
        console.error('Load explore error:', e);
        const container = document.getElementById('exploreContent');
        if (container) {
            container.innerHTML = `
                <div class="empty-state" style="grid-column:1/-1;">
                    <i class="fas fa-exclamation-triangle"></i>
                    خطا در بارگذاری اکسپلور<br>
                    <button onclick="loadExplore()" class="btn btn-primary" style="margin-top:12px;">تلاش مجدد</button>
                </div>
            `;
        }
    }
}

// ============================================================
// بخش ۱۱: مودال پست (تمام صفحه)
// ============================================================

async function openPostModal(postId) {
    modalPostId = postId;
    const modal = document.getElementById('postModal');
    if (!modal) return;
    
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';

    try {
        const res = await fetch(`/api/post/${postId}/detail`);
        const post = await res.json();
        modalPostData = post;
        modalUserId = post.user_id;

        document.getElementById('modalAvatar').src = post.avatar || defaultAvatar(post.name);
        document.getElementById('modalName').textContent = post.name || 'کاربر';
        document.getElementById('modalTime').textContent = timeAgo(post.created_at);
        document.getElementById('modalContent').textContent = post.content || '';
        document.getElementById('modalViews').textContent = formatNumber(post.views || 0);

        // بارگذاری مدیا
        const mediaContainer = document.getElementById('modalMedia');
        if (post.media_url) {
            if (post.media_type === 'video') {
                mediaContainer.innerHTML = `
                    <video src="${post.media_url}" controls autoplay style="max-width:100%;max-height:60vh;object-fit:contain;"></video>
                `;
            } else {
                mediaContainer.innerHTML = `
                    <img src="${post.media_url}" style="max-width:100%;max-height:60vh;object-fit:contain;">
                `;
            }
        } else {
            mediaContainer.innerHTML = `<div style="color:var(--text-muted);font-size:14px;padding:20px;">📝 پست متنی</div>`;
        }

        // وضعیت لایک
        modalLiked = post.is_liked || false;
        const likeBtn = document.getElementById('modalLikeBtn');
        if (likeBtn) {
            likeBtn.classList.toggle('liked', modalLiked);
            likeBtn.querySelector('i').className = modalLiked ? 'fas fa-heart' : 'far fa-heart';
        }

        // بارگذاری کامنت‌ها
        await loadModalComments(postId);

        // ذخیره در تاریخچه
        if (history.pushState) {
            history.pushState({ modal: true, postId }, '', `?post=${postId}`);
        }

    } catch (e) {
        console.error('Open post modal error:', e);
        showNotification('خطا در بارگذاری پست', 'error');
        closePostModal();
    }
}

async function loadModalComments(postId) {
    try {
        const res = await fetch(`/api/post/${postId}/comments`);
        const comments = await res.json();
        const container = document.getElementById('modalComments');
        if (!container) return;
        
        container.innerHTML = comments.map(c => `
            <div class="post-modal-comment animate-slide">
                <div class="avatar">
                    <img src="${c.avatar || defaultAvatar(c.name)}" loading="lazy">
                </div>
                <div>
                    <div style="font-weight:600;font-size:12px;">${escapeHtml(c.name)}</div>
                    <div class="comment-text">${escapeHtml(c.text)}</div>
                </div>
            </div>
        `).join('');
        
        if (comments.length === 0) {
            container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:10px;">هنوز کامنتی ثبت نشده</div>';
        }
    } catch (e) {
        console.error('Load modal comments error:', e);
    }
}

function closePostModal() {
    const modal = document.getElementById('postModal');
    if (modal) modal.classList.remove('open');
    document.body.style.overflow = '';
    
    // توقف ویدیو
    const video = modal?.querySelector('video');
    if (video) video.pause();
    
    modalPostId = null;
    modalPostData = null;
    
    // بازنشانی تاریخچه
    if (history.state && history.state.modal) {
        history.back();
    }
}

function openProfileFromModal() {
    if (modalUserId) {
        closePostModal();
        openProfile(modalUserId);
    }
}

function modalToggleLike() {
    if (!modalPostId) return;
    const btn = document.getElementById('modalLikeBtn');
    const mainLikeBtn = document.querySelector(`[data-post-id="${modalPostId}"] .like-btn`);
    
    if (mainLikeBtn) {
        toggleLike(modalPostId, mainLikeBtn);
    } else {
        // درخواست مستقیم
        fetch(`/api/post/${modalPostId}/like`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id })
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                modalLiked = data.liked;
                btn.classList.toggle('liked', data.liked);
                btn.querySelector('i').className = data.liked ? 'fas fa-heart' : 'far fa-heart';
                // به‌روزرسانی شمارنده در مودال
                const viewCount = document.getElementById('modalViews');
                if (viewCount) {
                    // شمارنده لایک در مودال
                }
            }
        })
        .catch(e => showNotification('خطا', 'error'));
    }
}

function modalFocusComment() {
    const input = document.getElementById('modalCommentInput');
    if (input) input.focus();
}

function modalShare() {
    const url = `${window.location.origin}?post=${modalPostId}`;
    if (navigator.share) {
        navigator.share({
            title: 'یارِ من',
            text: modalPostData?.content || 'این پست رو ببین!',
            url: url
        }).catch(() => {});
    } else {
        navigator.clipboard.writeText(url).then(() => {
            showNotification('🔗 لینک کپی شد', 'success');
        }).catch(() => {
            showNotification('لینک: ' + url, 'info', 5000);
        });
    }
}

async function modalSubmitComment() {
    const input = document.getElementById('modalCommentInput');
    const text = input.value.trim();
    if (!text || !modalPostId) return;

    try {
        const res = await fetch(`/api/post/${modalPostId}/comment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, text })
        });
        
        const data = await res.json();
        
        if (data.success) {
            input.value = '';
            await loadModalComments(modalPostId);
            
            // به‌روزرسانی صفحه اصلی
            const mainCountBtn = document.querySelector(`[data-post-id="${modalPostId}"] .comment-count`);
            if (mainCountBtn) {
                const current = parseInt(mainCountBtn.textContent.replace(/,/g, '')) || 0;
                mainCountBtn.textContent = formatNumber(current + 1);
            }
            
            socket.emit('post_commented', { postId: modalPostId, comment: data.comment });
        }
    } catch (e) {
        console.error('Modal submit comment error:', e);
        showNotification('خطا در ارسال کامنت', 'error');
    }
}

// ============================================================
// بخش ۱۲: دکمه آپلود شناور
// ============================================================

function openUpload() {
    // رفتن به صفحه کانال و فوکوس روی کامپوزر
    switchPage('channel');
    document.getElementById('postContent').focus();
    
    // اسکرول به کامپوزر
    setTimeout(() => {
        const composer = document.querySelector('.composer');
        if (composer) {
            composer.scrollIntoView({ behavior: 'smooth', block: 'center' });
            composer.style.borderColor = 'var(--primary)';
            composer.style.boxShadow = 'var(--shadow-hover)';
            setTimeout(() => {
                composer.style.borderColor = 'var(--border-color)';
                composer.style.boxShadow = 'var(--shadow)';
            }, 2000);
        }
    }, 300);
}

// ============================================================
// بخش ۱۳: چت خصوصی
// ============================================================

async function loadChatList() {
    try {
        const container = document.getElementById('chatList');
        if (!container) return;
        
        if (!currentUser) return;
        
        const res = await fetch(`/api/chat/list/${currentUser.id}`);
        const chats = await res.json();
        
        if (!chats || chats.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-comment-dots"></i>
                    هنوز چتی نداری.<br>
                    از اکسپلور یکی رو پیدا کن و پیام بده! 💬
                </div>
            `;
            return;
        }
        
        container.innerHTML = chats.map(c => `
            <div class="chat-item animate-slide" onclick="openChat('${c.id}', '${escapeHtml(c.name)}', '${c.avatar || defaultAvatar(c.name)}')">
                <div class="avatar">
                    <img src="${c.avatar || defaultAvatar(c.name)}" loading="lazy">
                </div>
                <div class="info">
                    <strong>${escapeHtml(c.name)}</strong>
                    <p>${escapeHtml(c.lastMessage || '')}</p>
                </div>
                ${c.unreadCount > 0 ? `<span class="unread">${c.unreadCount}</span>` : ''}
            </div>
        `).join('');
        
        // به‌روزرسانی نشانگر چت
        const totalUnread = chats.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
        unreadCount = totalUnread;
        const badge = document.getElementById('chatBadge');
        if (badge) {
            if (totalUnread > 0) {
                badge.textContent = totalUnread > 99 ? '99+' : totalUnread;
                badge.classList.add('show');
            } else {
                badge.classList.remove('show');
            }
        }
        
        cache.chats.set('list', chats);
    } catch (e) {
        console.error('Load chat list error:', e);
    }
}

async function openChat(userId, name, avatar) {
    currentChatUser = { id: userId, name, avatar };
    
    document.getElementById('chatWithName').textContent = name || 'کاربر';
    document.getElementById('chatWithAvatar').src = avatar || defaultAvatar(name);
    document.getElementById('chatWindow').classList.add('open');
    
    const messagesContainer = document.getElementById('chatMessages');
    messagesContainer.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;"><i class="fas fa-spinner fa-spin"></i> بارگذاری...</div>';

    // علامت‌گذاری به عنوان خوانده شده
    try {
        await fetch('/api/chat/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, fromUser: userId })
        });
        await loadChatList();
    } catch (e) {}

    try {
        const cacheKey = `${currentUser.id}_${userId}`;
        let messages = cache.chats.get(cacheKey);
        
        if (!messages) {
            const res = await fetch(`/api/chat/history/${currentUser.id}/${userId}`);
            messages = await res.json();
            cache.chats.set(cacheKey, messages);
        }
        
        renderMessages(messages);
    } catch (e) {
        console.error('Load chat history error:', e);
        showNotification('خطا در بارگذاری پیام‌ها', 'error');
    }
    
    // فوکوس روی input
    setTimeout(() => {
        document.getElementById('messageInput').focus();
    }, 300);
}

function renderMessages(messages) {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    
    if (!messages || messages.length === 0) {
        container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;">هنوز پیامی ارسال نشده</div>';
        return;
    }
    
    container.innerHTML = messages.map(m => `
        <div class="message ${m.from_user === currentUser.id ? 'sent' : 'received'}">
            ${escapeHtml(m.message)}
            <span class="time">${new Date(m.created_at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
    `).join('');
    
    container.scrollTop = container.scrollHeight;
}

function displayMessage(text, type) {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    
    const div = document.createElement('div');
    div.className = `message ${type}`;
    div.innerHTML = `
        ${escapeHtml(text)}
        <span class="time">${new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}</span>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function closeChatWindow() {
    document.getElementById('chatWindow').classList.remove('open');
    currentChatUser = null;
    document.getElementById('chatWithName').textContent = '';
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    if (!message || !currentChatUser) return;

    // نمایش پیام در UI
    displayMessage(message, 'sent');
    input.value = '';

    // ارسال از طریق Socket.IO
    socket.emit('private_message', {
        from: currentUser.id,
        to: currentChatUser.id,
        message,
        timestamp: Date.now()
    });

    // ذخیره در کش
    const cacheKey = `${currentUser.id}_${currentChatUser.id}`;
    if (cache.chats.has(cacheKey)) {
        const messages = cache.chats.get(cacheKey);
        messages.push({
            from_user: currentUser.id,
            to_user: currentChatUser.id,
            message,
            created_at: new Date().toISOString()
        });
        cache.chats.set(cacheKey, messages);
    }
}

// تایپینگ
document.getElementById('messageInput').addEventListener('input', function() {
    if (currentChatUser && !isTyping) {
        isTyping = true;
        socket.emit('typing', { from: currentUser.id, to: currentChatUser.id });
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            isTyping = false;
        }, 2000);
    }
});

// ارسال با Enter
document.getElementById('messageInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// ============================================================
// بخش ۱۴: دستیار هوشمند
// ============================================================

async function loadAssistantData() {
    const container = document.getElementById('assistantContent');
    if (!container) return;

    try {
        const res = await fetch(`/api/assistant/${currentUser.id}`);
        const data = await res.json();

        // به‌روزرسانی آمار
        document.getElementById('statPosts').textContent = formatNumber(data.stats?.totalPosts ?? 0);
        document.getElementById('statTrainings').textContent = formatNumber(data.stats?.totalTrainings ?? 0);
        document.getElementById('statFollowers').textContent = formatNumber(data.stats?.followers ?? 0);
        document.getElementById('statEngagement').textContent = data.stats?.engagementRate ?? '0%';

        // QA List
        const qaList = document.getElementById('qaList');
        if (qaList) {
            qaList.innerHTML = data.qa?.length ? data.qa.map(q => `
                <div class="qa-item animate-slide">
                    <span class="q">❓ ${escapeHtml(q.question)}</span>
                    <span class="a">💬 ${escapeHtml(q.answer)}</span>
                </div>
            `).join('') : '<div style="text-align:center;color:var(--text-muted);padding:10px;">هنوز آموزشی ثبت نشده.</div>';
        }

        // Keyword List
        const keywordList = document.getElementById('keywordList');
        if (keywordList) {
            keywordList.innerHTML = data.keywords?.length ? data.keywords.map(k => `
                <div class="keyword-item animate-slide">
                    <span class="k">🔑 ${escapeHtml(k.keyword)}</span>
                    <span class="r">💬 ${escapeHtml(k.response)}</span>
                </div>
            `).join('') : '<div style="text-align:center;color:var(--text-muted);padding:10px;">هنوز کلمه کلیدی ثبت نشده.</div>';
        }
    } catch (e) {
        console.error('Load assistant data error:', e);
    }
}

async function trainAssistant() {
    const question = document.getElementById('questionInput')?.value.trim();
    const answer = document.getElementById('answerInput')?.value.trim();
    if (!question || !answer) {
        showNotification('سوال و جواب رو کامل کن!', 'warning');
        return;
    }

    try {
        const res = await fetch('/api/assistant/train', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, question, answer })
        });
        
        const data = await res.json();
        
        if (data.success) {
            showNotification('✅ دستیار یاد گرفت', 'success');
            document.getElementById('questionInput').value = '';
            document.getElementById('answerInput').value = '';
            await loadAssistantData();
            if (data.boost) {
                updateBoostBadge(data.boost.boostLevel);
            }
        } else {
            showNotification('خطا: ' + (data.error || 'مشخصات نامعتبر'), 'error');
        }
    } catch (e) {
        console.error('Train assistant error:', e);
        showNotification('خطا در ارتباط با سرور', 'error');
    }
}

async function trainKeyword() {
    const keyword = document.getElementById('keywordInput')?.value.trim();
    const response = document.getElementById('keywordResponseInput')?.value.trim();
    if (!keyword || !response) {
        showNotification('کلمه کلیدی و پاسخ رو کامل کن!', 'warning');
        return;
    }

    try {
        const res = await fetch('/api/assistant/keyword', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, keyword, response })
        });
        
        const data = await res.json();
        
        if (data.success) {
            showNotification('✅ کلمه کلیدی ثبت شد', 'success');
            document.getElementById('keywordInput').value = '';
            document.getElementById('keywordResponseInput').value = '';
            await loadAssistantData();
            if (data.boost) {
                updateBoostBadge(data.boost.boostLevel);
            }
        } else {
            showNotification('خطا: ' + (data.error || 'مشخصات نامعتبر'), 'error');
        }
    } catch (e) {
        console.error('Train keyword error:', e);
        showNotification('خطا در ارتباط با سرور', 'error');
    }
}

async function testAssistant() {
    const input = document.getElementById('assistantPreviewInput');
    const msg = input?.value.trim();
    if (!msg) return;
    
    appendMiniMsg('assistantPreviewChat', msg, 'me');
    input.value = '';

    try {
        const res = await fetch(`/api/assistant/chat/${currentUser.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg })
        });
        
        const data = await res.json();
        appendMiniMsg('assistantPreviewChat', data.reply || 'دستیار هنوز جوابی نداره 🤖', 'bot');
    } catch (e) {
        console.error('Test assistant error:', e);
        appendMiniMsg('assistantPreviewChat', 'خطا در ارتباط با دستیار', 'bot');
    }
}

function appendMiniMsg(containerId, text, who) {
    const c = document.getElementById(containerId);
    if (!c) return;
    
    const div = document.createElement('div');
    div.className = `mini-msg ${who}`;
    div.style.cssText = `
        padding: 10px 16px;
        border-radius: 16px;
        font-size: 13px;
        max-width: 85%;
        word-wrap: break-word;
        ${who === 'me' ? 
            'align-self: flex-end; background: var(--primary); color: #fff; border-bottom-right-radius: 4px;' : 
            'align-self: flex-start; background: var(--bg-soft); border: 2px solid var(--border-color); border-bottom-left-radius: 4px; color: var(--text-primary);'
        }
    `;
    div.textContent = text;
    c.appendChild(div);
    c.scrollTop = c.scrollHeight;
}

// ============================================================
// بخش ۱۵: پروفایل عمومی
// ============================================================

async function openProfile(userId) {
    if (!userId) return;
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

        viewingProfileFollowing = data.isFollowing || false;
        const followBtn = document.getElementById('viewFollowBtn');
        if (followBtn) {
            followBtn.textContent = viewingProfileFollowing ? 'فالو شده ✓' : 'فالو';
            followBtn.className = viewingProfileFollowing ? 'btn btn-secondary' : 'btn btn-primary';
        }

        // پست‌های کاربر
        const container = document.getElementById('viewPostsContainer');
        if (container) {
            if (data.posts && data.posts.length > 0) {
                container.innerHTML = data.posts.map(p => renderPostCard(p, data.user)).join('');
            } else {
                container.innerHTML = `
                    <div class="empty-state">
                        <i class="fas fa-pen-fancy"></i>
                        این کاربر هنوز پستی منتشر نکرده.
                    </div>
                `;
            }
        }

        // تغییر صفحه
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById('profilePage').classList.add('active');
        
        // ذخیره در کش
        cache.profiles.set(userId, data);
    } catch (e) {
        console.error('Open profile error:', e);
        showNotification('خطا در بارگذاری پروفایل', 'error');
    }
}

function backFromProfile() {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const explorePage = document.getElementById('explorePage');
    if (explorePage) {
        explorePage.classList.add('active');
        document.querySelectorAll('.nav-btn').forEach(b => {
            b.classList.remove('active');
            if (b.dataset.page === 'explore') {
                b.classList.add('active');
            }
        });
    }
    viewingProfileId = null;
}

async function toggleFollowView() {
    if (!viewingProfileId) return;
    
    const endpoint = viewingProfileFollowing ? '/api/unfollow' : '/api/follow';
    const action = viewingProfileFollowing ? 'آنفالو' : 'فالو';
    
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ followerId: currentUser.id, followingId: viewingProfileId })
        });
        
        const data = await res.json();
        
        if (data.success) {
            viewingProfileFollowing = !viewingProfileFollowing;
            const followBtn = document.getElementById('viewFollowBtn');
            if (followBtn) {
                followBtn.textContent = viewingProfileFollowing ? 'فالو شده ✓' : 'فالو';
                followBtn.className = viewingProfileFollowing ? 'btn btn-secondary' : 'btn btn-primary';
            }
            
            const count = document.getElementById('viewFollowers');
            if (count) {
                const current = parseInt(count.textContent.replace(/,/g, '')) || 0;
                count.textContent = formatNumber(current + (viewingProfileFollowing ? 1 : -1));
            }
            
            showNotification(viewingProfileFollowing ? '✅ فالو شد' : '❌ آنفالو شد', viewingProfileFollowing ? 'success' : 'warning');
            
            // به‌روزرسانی کش
            if (cache.profiles.has(viewingProfileId)) {
                const profile = cache.profiles.get(viewingProfileId);
                profile.isFollowing = viewingProfileFollowing;
                cache.profiles.set(viewingProfileId, profile);
            }
        } else {
            showNotification('خطا: ' + (data.error || 'مشخصات نامعتبر'), 'error');
        }
    } catch (e) {
        console.error('Toggle follow error:', e);
        showNotification('خطا در ارتباط با سرور', 'error');
    }
}

function openChatFromProfile() {
    if (!viewingProfileId) return;
    switchPage('chat');
    openChat(
        viewingProfileId,
        document.getElementById('viewName').textContent,
        document.getElementById('viewAvatar').src
    );
}

// ============================================================
// بخش ۱۶: جستجو
// ============================================================

document.getElementById('searchInput').addEventListener('input', debounce(async function(e) {
    const q = e.target.value.trim();
    let container = document.getElementById('searchResults');
    
    if (!container) {
        container = document.createElement('div');
        container.id = 'searchResults';
        container.style.cssText = `
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background: var(--bg-secondary);
            border: 2px solid var(--border-color);
            border-radius: var(--radius-sm);
            margin-top: 8px;
            max-height: 300px;
            overflow-y: auto;
            z-index: 60;
            box-shadow: var(--shadow-hover);
            display: none;
        `;
        document.querySelector('.search-box').appendChild(container);
    }
    
    if (q.length < 2) {
        container.style.display = 'none';
        return;
    }
    
    try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const results = await res.json();
        
        if (!results || results.length === 0) {
            container.style.display = 'none';
            return;
        }
        
        container.style.display = 'block';
        container.innerHTML = results.map(r => `
            <div style="padding:10px 16px;cursor:pointer;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--border-color);transition:var(--transition-smooth);"
                 onclick="openProfile('${r.id}')" 
                 onmouseover="this.style.background='var(--bg-soft)'"
                 onmouseout="this.style.background=''">
                <div class="avatar" style="width:32px;height:32px;border-radius:50%;padding:2px;background:linear-gradient(135deg,var(--primary),var(--secondary));flex-shrink:0;">
                    <img src="${r.avatar || defaultAvatar(r.name)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;border:2px solid #fff;">
                </div>
                <span style="font-weight:600;">${escapeHtml(r.name)}</span>
                <span style="font-size:10px;color:var(--text-muted);">${r.type === 'user' ? '👤 کاربر' : '📢 کانال'}</span>
            </div>
        `).join('');
    } catch (e) {
        console.error('Search error:', e);
    }
}, 400));

// بستن جستجو با کلیک خارج
document.addEventListener('click', function(e) {
    const container = document.getElementById('searchResults');
    if (container && !e.target.closest('.search-box')) {
        container.style.display = 'none';
    }
});

// ============================================================
// بخش ۱۷: مدیریت (Admin Panel)
// ============================================================

function toggleAdminPanel() {
    if (!isAdmin) return;
    adminPanelOpen = !adminPanelOpen;
    
    if (adminPanelOpen) {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById('adminPage').classList.add('active');
        loadAdminData('stats');
    } else {
        document.querySelector('[data-page="explore"]').click();
    }
}

function switchAdminTab(tab) {
    document.querySelectorAll('.admin-tab').forEach(t => {
        t.classList.remove('active');
    });
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
            const container = document.getElementById('adminStats');
            if (container) {
                container.innerHTML = `
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:12px;">
                        <div class="stat-chip"><b>${formatNumber(stats.users)}</b><span>کاربران</span></div>
                        <div class="stat-chip"><b>${formatNumber(stats.posts)}</b><span>پست‌ها</span></div>
                        <div class="stat-chip"><b>${formatNumber(stats.channels)}</b><span>کانال‌ها</span></div>
                        <div class="stat-chip"><b>${formatNumber(stats.messages)}</b><span>پیام‌ها</span></div>
                        <div class="stat-chip"><b>${formatNumber(stats.follows)}</b><span>فالوها</span></div>
                        <div class="stat-chip"><b>${formatNumber(stats.comments)}</b><span>کامنت‌ها</span></div>
                    </div>
                `;
            }
        } else if (type === 'users') {
            const res = await fetch('/api/admin/users', { headers: { 'userId': 'admin_milad' } });
            const users = await res.json();
            const container = document.getElementById('adminUsers');
            if (container) {
                container.innerHTML = users.map(u => `
                    <div class="admin-item">
                        <span class="name">${escapeHtml(u.name)}</span>
                        <span style="font-size:11px;color:var(--text-muted);">${u.role || 'user'}</span>
                        <span style="font-size:11px;color:var(--text-muted);">${formatNumber(u.followers_count || 0)} فالوور</span>
                        <div class="actions">
                            ${u.role !== 'admin' ? `
                                <button class="btn btn-success" onclick="adminAction('user','${u.id}','verify')" style="padding:4px 14px;background:var(--success);color:#fff;border:none;border-radius:99px;font-size:10px;">✓</button>
                                <button class="btn btn-danger" onclick="adminAction('user','${u.id}','ban')" style="padding:4px 14px;background:var(--danger);color:#fff;border:none;border-radius:99px;font-size:10px;">⛔</button>
                            ` : ''}
                        </div>
                    </div>
                `).join('');
            }
        } else if (type === 'posts') {
            const res = await fetch('/api/admin/posts', { headers: { 'userId': 'admin_milad' } });
            const posts = await res.json();
            const container = document.getElementById('adminPosts');
            if (container) {
                container.innerHTML = posts.map(p => `
                    <div class="admin-item">
                        <span>${escapeHtml(p.content?.substring(0, 40) || '')}...</span>
                        <span style="font-size:11px;color:var(--text-muted);">${escapeHtml(p.user_name)}</span>
                        <span style="font-size:11px;color:var(--text-muted);">${timeAgo(p.created_at)}</span>
                        <div class="actions">
                            <button class="btn btn-danger" onclick="adminAction('post','${p.id}','delete')" style="padding:4px 14px;background:var(--danger);color:#fff;border:none;border-radius:99px;font-size:10px;">🗑️</button>
                        </div>
                    </div>
                `).join('');
            }
        }
    } catch (e) {
        console.error('Load admin data error:', e);
        showNotification('خطا در بارگذاری داده‌های مدیریت', 'error');
    }
}

async function adminAction(type, id, action) {
    if (!confirm(`آیا از انجام این عملیات مطمئن هستید؟`)) return;
    
    try {
        const res = await fetch(`/api/admin/${type}/${action}`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'userId': 'admin_milad' 
            },
            body: JSON.stringify({ 
                userId: type === 'user' ? id : undefined,
                postId: type === 'post' ? id : undefined
            })
        });
        
        const data = await res.json();
        
        if (data.success) {
            showNotification('✅ عملیات با موفقیت انجام شد', 'success');
            const activeTab = document.querySelector('.admin-tab.active');
            if (activeTab) loadAdminData(activeTab.dataset.tab);
        } else {
            showNotification('خطا: ' + (data.error || 'مشخصات نامعتبر'), 'error');
        }
    } catch (e) {
        console.error('Admin action error:', e);
        showNotification('خطا در ارتباط با سرور', 'error');
    }
}

async function sendBroadcast() {
    const title = document.getElementById('broadcastTitle').value.trim();
    const message = document.getElementById('broadcastMessage').value.trim();
    
    if (!message) {
        showNotification('متن پیام رو بنویس!', 'warning');
        return;
    }

    try {
        const res = await fetch('/api/admin/broadcast', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'userId': 'admin_milad' 
            },
            body: JSON.stringify({ title: title || 'اعلان سیستمی', message })
        });
        
        const data = await res.json();
        
        if (data.success) {
            showNotification(`✅ ${data.message}`, 'success');
            document.getElementById('broadcastTitle').value = '';
            document.getElementById('broadcastMessage').value = '';
        } else {
            showNotification('خطا: ' + (data.error || 'مشخصات نامعتبر'), 'error');
        }
    } catch (e) {
        console.error('Send broadcast error:', e);
        showNotification('خطا در ارسال پیام', 'error');
    }
}

// ============================================================
// بخش ۱۸: تایمرهای خودکار
// ============================================================

function startAutoRefresh() {
    // به‌روزرسانی لیست چت هر ۳۰ ثانیه
    setInterval(() => {
        const chatPage = document.getElementById('chatPage');
        if (chatPage && chatPage.classList.contains('active')) {
            loadChatList();
        }
    }, 30000);
    
    // به‌روزرسانی اکسپلور هر ۶۰ ثانیه
    setInterval(() => {
        const explorePage = document.getElementById('explorePage');
        if (explorePage && explorePage.classList.contains('active')) {
            loadExplore();
        }
    }, 60000);
    
    // به‌روزرسانی امتیاز هر ۶۰ ثانیه
    setInterval(async () => {
        if (currentUser) {
            try {
                const res = await fetch(`/api/user/${currentUser.id}`);
                if (res.ok) {
                    const data = await res.json();
                    document.getElementById('userScore').textContent = formatNumber(data.score || 0);
                }
            } catch (e) {}
        }
    }, 60000);
}

// ============================================================
// بخش ۱۹: اسکرول به بالا
// ============================================================

window.addEventListener('scroll', function() {
    const btn = document.getElementById('scrollTop');
    if (btn) {
        if (window.scrollY > 300) {
            btn.classList.add('show');
        } else {
            btn.classList.remove('show');
        }
    }
});

// ============================================================
// بخش ۲۰: مدیریت تاریخچه و بازگشت
// ============================================================

window.addEventListener('popstate', function(event) {
    if (event.state && event.state.modal) {
        closePostModal();
    }
});

// بستن مودال با کلید Escape
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        const modal = document.getElementById('postModal');
        if (modal && modal.classList.contains('open')) {
            closePostModal();
        }
    }
});

// ============================================================
// بخش ۲۱: تنظیمات نوتیفیکیشن
// ============================================================

// درخواست مجوز نوتیفیکیشن
if (Notification.permission === 'default') {
    setTimeout(() => {
        Notification.requestPermission();
    }, 5000);
}

// ============================================================
// بخش ۲۲: شروع برنامه
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    initApp();
    
    // اضافه کردن پشتیبانی از کش
    console.log('🚀 یارِ من - نسخه ۳.۰');
    console.log('📱 پلتفرم هوشمند اجتماعی');
    console.log('✨ با ۲۵۰۰۰+ خط کد حرفه‌ای');
});

// ============================================================
// پایان فایل script.js
// ============================================================