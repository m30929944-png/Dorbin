// ============================================
// اتصال به سرور با WebSocket
// ============================================
const socket = io('http://localhost:3000', {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 10
});

// ============================================
// متغیرهای عمومی
// ============================================
let currentUser = null;
let currentPage = 'channel';
let currentChatUser = null;
let assistantData = null;

// ============================================
// مدیریت صفحات (۴ دکمه)
// ============================================
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', function() {
        // تغییر دکمه فعال
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        
        // تغییر صفحه
        const page = this.dataset.page;
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById(page + 'Page').classList.add('active');
        currentPage = page;
        
        // بارگذاری داده‌های هر صفحه
        loadPageData(page);
    });
});

// ============================================
// پروفایل کاربر (با کلیک باز می‌شود)
// ============================================
document.getElementById('profileBtn').addEventListener('click', function() {
    showProfileModal();
});

function showProfileModal() {
    // نمایش یک مودال برای مدیریت پروفایل و دستیار
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <h2>👤 پروفایل</h2>
            <div class="profile-info">
                <img src="${currentUser?.avatar || 'default-avatar.png'}" id="profileAvatar">
                <h3 id="profileName">${currentUser?.name || 'کاربر'}</h3>
                <p>🏆 امتیاز: <span id="profileScore">${currentUser?.score || 0}</span></p>
                <p>📢 فالوورها: <span id="profileFollowers">${currentUser?.followers || 0}</span></p>
            </div>
            <div class="profile-actions">
                <button onclick="trainAssistant()">📝 آموزش به دستیار</button>
                <button onclick="viewAssistantPanel()">🤖 مدیریت دستیار</button>
                <button onclick="closeModal()">بستن</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

function closeModal() {
    const modal = document.querySelector('.modal');
    if (modal) modal.remove();
}

// ============================================
// دستیار - آموزش سوال و جواب
// ============================================
async function trainAssistant() {
    const question = document.getElementById('questionInput').value.trim();
    const answer = document.getElementById('answerInput').value.trim();
    
    if (!question || !answer) {
        alert('لطفاً سوال و جواب را وارد کنید!');
        return;
    }
    
    try {
        const response = await fetch('/api/assistant/train', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, answer, userId: currentUser?.id })
        });
        
        const data = await response.json();
        if (data.success) {
            alert('✅ آموزش با موفقیت ثبت شد!');
            document.getElementById('questionInput').value = '';
            document.getElementById('answerInput').value = '';
            loadAssistantData();
        } else {
            alert('❌ خطا: ' + data.error);
        }
    } catch (error) {
        console.error('Error training assistant:', error);
        alert('خطا در ارتباط با سرور');
    }
}

// ============================================
// دستیار - آموزش کلمات کلیدی
// ============================================
async function trainKeyword() {
    const keyword = document.getElementById('keywordInput').value.trim();
    const response = document.getElementById('keywordResponseInput').value.trim();
    
    if (!keyword || !response) {
        alert('لطفاً کلمه کلیدی و پاسخ را وارد کنید!');
        return;
    }
    
    try {
        const result = await fetch('/api/assistant/keyword', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keyword, response, userId: currentUser?.id })
        });
        
        const data = await result.json();
        if (data.success) {
            alert('✅ کلمه کلیدی با موفقیت ثبت شد!');
            document.getElementById('keywordInput').value = '';
            document.getElementById('keywordResponseInput').value = '';
            loadAssistantData();
        }
    } catch (error) {
        console.error('Error training keyword:', error);
    }
}

// ============================================
// دستیار - مدیریت پست‌های اتومات
// ============================================
function showAutoPostPanel() {
    const panel = document.getElementById('autoPostPanel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

async function schedulePosts() {
    const count = parseInt(document.getElementById('postCount').value);
    const descriptions = document.getElementById('postDescriptions').value.split('\n').filter(s => s.trim());
    const time = document.getElementById('postTime').value;
    
    if (!count || count < 1) {
        alert('لطفاً تعداد پست‌ها را مشخص کنید!');
        return;
    }
    
    if (descriptions.length < count) {
        alert(`لطفاً حداقل ${count} توضیح وارد کنید (هر خط یک توضیح)`);
        return;
    }
    
    try {
        const response = await fetch('/api/assistant/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser?.id,
                postCount: count,
                descriptions: descriptions.slice(0, count),
                time: time
            })
        });
        
        const data = await response.json();
        if (data.success) {
            alert(`✅ ${count} پست با موفقیت زمان‌بندی شد!`);
            loadAssistantData();
        }
    } catch (error) {
        console.error('Error scheduling posts:', error);
    }
}

// ============================================
// بارگذاری داده‌های دستیار
// ============================================
async function loadAssistantData() {
    if (!currentUser) return;
    
    try {
        const response = await fetch(`/api/assistant/${currentUser.id}`);
        const data = await response.json();
        assistantData = data;
        
        // نمایش تعداد پست‌ها
        document.getElementById('assistantPostsCount').textContent = `${data.posts?.length || 0} پست`;
        document.getElementById('assistantTasksCount').textContent = `${data.tasks?.length || 0} وظیفه`;
        
        // نمایش لیست سوال و جواب‌ها
        const qaList = document.getElementById('qaList');
        qaList.innerHTML = data.qa?.map(qa => `
            <div class="qa-item">
                <span>❓ ${qa.question}</span>
                <span>💬 ${qa.answer}</span>
            </div>
        `).join('') || '<p style="color: var(--text-secondary);">هنوز آموزشی ثبت نشده است.</p>';
        
        // نمایش لیست کلمات کلیدی
        const keywordList = document.getElementById('keywordList');
        keywordList.innerHTML = data.keywords?.map(kw => `
            <div class="keyword-item">
                <span>🔑 ${kw.keyword}</span>
                <span>💬 ${kw.response}</span>
            </div>
        `).join('') || '<p style="color: var(--text-secondary);">هنوز کلمه کلیدی ثبت نشده است.</p>';
        
    } catch (error) {
        console.error('Error loading assistant data:', error);
    }
}

// ============================================
// ارسال پیام (چت خصوصی)
// ============================================
async function sendMessage() {
    const message = document.getElementById('messageInput').value.trim();
    if (!message || !currentChatUser) return;
    
    try {
        socket.emit('private_message', {
            from: currentUser.id,
            to: currentChatUser.id,
            message: message,
            timestamp: Date.now()
        });
        
        // نمایش پیام در چت
        displayMessage(message, 'sent');
        document.getElementById('messageInput').value = '';
        
        // ذخیره در دیتابیس
        await fetch('/api/chat/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: currentUser.id,
                to: currentChatUser.id,
                message: message
            })
        });
        
    } catch (error) {
        console.error('Error sending message:', error);
    }
}

function displayMessage(text, type) {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `message ${type}`;
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

// ============================================
// WebSocket - دریافت پیام لحظه‌ای
// ============================================
socket.on('new_message', (data) => {
    if (data.from === currentChatUser?.id) {
        displayMessage(data.message, 'received');
    } else {
        // نمایش نوتیفیکیشن
        showNotification(`📩 پیام جدید از ${data.fromName}`);
    }
});

// ============================================
// جستجو
// ============================================
document.getElementById('searchInput').addEventListener('input', debounce(async function(e) {
    const query = e.target.value.trim();
    if (query.length < 2) return;
    
    try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const results = await response.json();
        displaySearchResults(results);
    } catch (error) {
        console.error('Search error:', error);
    }
}, 500));

function displaySearchResults(results) {
    // نمایش نتایج جستجو به صورت dropdown یا صفحه‌ی جداگانه
    console.log('Search results:', results);
}

// ============================================
// توابع کمکی
// ============================================
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function showNotification(text) {
    const notif = document.createElement('div');
    notif.className = 'notification';
    notif.textContent = text;
    document.body.appendChild(notif);
    setTimeout(() => notif.remove(), 3000);
}

function viewAssistantPanel() {
    // تغییر به صفحه‌ی دستیار
    document.querySelector('[data-page="assistant"]').click();
    closeModal();
}

// ============================================
// بارگذاری داده‌های هر صفحه
// ============================================
async function loadPageData(page) {
    switch(page) {
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
    }
}

async function loadChannelPosts() {
    if (!currentUser) return;
    try {
        const response = await fetch(`/api/channel/${currentUser.id}/posts`);
        const posts = await response.json();
        const container = document.getElementById('channelPosts');
        container.innerHTML = posts.map(post => `
            <div class="post-card">
                ${post.media ? `<${post.mediaType === 'video' ? 'video' : 'img'} src="${post.media}" controls></${post.mediaType === 'video' ? 'video' : 'img'}>` : ''}
                <p>${post.content}</p>
                <div class="post-stats">
                    <span>❤️ ${post.likes || 0}</span>
                    <span>💬 ${post.comments || 0}</span>
                    <span>👁️ ${post.views || 0}</span>
                </div>
            </div>
        `).join('') || '<p style="color: var(--text-secondary);">هنوز پستی منتشر نشده است.</p>';
    } catch (error) {
        console.error('Error loading channel posts:', error);
    }
}

async function loadChatList() {
    try {
        const response = await fetch(`/api/chat/list/${currentUser.id}`);
        const chats = await response.json();
        const list = document.getElementById('chatList');
        list.innerHTML = chats.map(chat => `
            <div class="chat-item" onclick="openChat('${chat.id}')">
                <strong>${chat.name}</strong>
                <p style="font-size:12px;color:var(--text-secondary);">${chat.lastMessage || ''}</p>
            </div>
        `).join('') || '<p>هیچ چتی وجود ندارد.</p>';
    } catch (error) {
        console.error('Error loading chat list:', error);
    }
}

async function loadExplore() {
    try {
        const response = await fetch('/api/explore');
        const data = await response.json();
        const container = document.getElementById('exploreContent');
        container.innerHTML = data.map(item => `
            <div class="explore-card">
                <h4>${item.channelName}</h4>
                <p>${item.postsCount} پست</p>
                <p>👥 ${item.followers} فالوور</p>
            </div>
        `).join('') || '<p>هیچ محتوایی برای نمایش وجود ندارد.</p>';
    } catch (error) {
        console.error('Error loading explore:', error);
    }
}

function openChat(userId) {
    currentChatUser = { id: userId };
    document.getElementById('chatMessages').innerHTML = '';
    // بارگذاری تاریخچه چت
    loadChatHistory(userId);
}

async function loadChatHistory(userId) {
    try {
        const response = await fetch(`/api/chat/history/${currentUser.id}/${userId}`);
        const messages = await response.json();
        const container = document.getElementById('chatMessages');
        container.innerHTML = messages.map(msg => `
            <div class="message ${msg.from === currentUser.id ? 'sent' : 'received'}">
                ${msg.message}
            </div>
        `).join('');
        container.scrollTop = container.scrollHeight;
    } catch (error) {
        console.error('Error loading chat history:', error);
    }
}

// ============================================
// مقداردهی اولیه - شبیه‌سازی کاربر
// ============================================
async function initApp() {
    // برای تست، یک کاربر فرضی ایجاد می‌کنیم
    currentUser = {
        id: 'user_123',
        name: 'علی رضایی',
        avatar: 'default-avatar.png',
        score: 250,
        followers: 45
    };
    
    document.getElementById('userName').textContent = currentUser.name;
    document.getElementById('userScore').textContent = `🏆 ${currentUser.score} امتیاز`;
    
    // بارگذاری داده‌های صفحه‌ی پیش‌فرض (کانال)
    await loadPageData('channel');
}

// شروع برنامه
initApp();

// اضافه کردن استایل‌های مودال و نوتیفیکیشن
const style = document.createElement('style');
style.textContent = `
    .modal {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        backdrop-filter: blur(5px);
    }
    .modal-content {
        background: var(--card);
        padding: 30px;
        border-radius: var(--radius);
        max-width: 400px;
        width: 90%;
        text-align: center;
    }
    .modal-content button {
        margin: 5px;
        padding: 10px 20px;
        background: var(--primary);
        border: none;
        border-radius: 10px;
        color: white;
        cursor: pointer;
        font-family: 'Vazir', sans-serif;
    }
    .notification {
        position: fixed;
        top: 80px;
        right: 20px;
        background: var(--card);
        padding: 12px 20px;
        border-radius: 10px;
        border-right: 4px solid var(--primary);
        z-index: 999;
        animation: slideIn 0.3s ease;
    }
    @keyframes slideIn {
        from { transform: translateX(100px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
`;
document.head.appendChild(style);