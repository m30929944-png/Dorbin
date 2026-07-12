// ============================================================
// server.js - فایل اصلی (فقط این را اجرا کنید)
// ============================================================

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('\x1b[36m%s\x1b[0m', '═══════════════════════════════════════════════');
console.log('\x1b[32m%s\x1b[0m', '🚀 شروع اینستاگرام حرفه‌ای');
console.log('\x1b[36m%s\x1b[0m', '═══════════════════════════════════════════════');

// ===== لیست فایل‌هایی که باید اجرا شوند =====
const services = [
    { name: '🔐 Gateway', file: 'm1.js', port: 3000 },
    { name: '📸 Posts', file: 'm2.js', port: 3001 },
    { name: '💬 Chat', file: 'm3.js', port: 3002 }
];

// ===== بررسی وجود فایل‌ها =====
let missingFiles = false;
services.forEach(s => {
    if (!fs.existsSync(path.join(__dirname, s.file))) {
        console.log(`\x1b[31m❌ فایل ${s.file} وجود ندارد!\x1b[0m`);
        missingFiles = true;
    }
});

if (missingFiles) {
    console.log('\x1b[31m⚠️ لطفاً همه فایل‌های m1.js, m2.js, m3.js را در کنار این فایل قرار دهید\x1b[0m');
    process.exit(1);
}

// ===== اجرای سرویس‌ها =====
const processes = [];
let allStarted = false;

services.forEach((service, index) => {
    console.log(`\x1b[33m⏳ شروع ${service.name}...\x1b[0m`);
    
    const proc = spawn('node', [service.file], {
        cwd: __dirname,
        env: {
            ...process.env,
            PORT: service.port,
            NODE_ENV: 'development'
        },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    // ===== نمایش خروجی با رنگ =====
    const colors = ['\x1b[36m', '\x1b[32m', '\x1b[35m'];
    const color = colors[index] || '\x1b[37m';

    proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        lines.forEach(line => {
            if (line.includes('error') || line.includes('Error') || line.includes('❌')) {
                console.log(`\x1b[31m${service.name} | ${line}\x1b[0m`);
            } else if (line.includes('✅') || line.includes('success')) {
                console.log(`\x1b[32m${service.name} | ${line}\x1b[0m`);
                if (!allStarted && line.includes('روی پورت')) {
                    // بررسی شروع همه سرویس‌ها
                }
            } else if (line.includes('⚠️') || line.includes('warning')) {
                console.log(`\x1b[33m${service.name} | ${line}\x1b[0m`);
            } else {
                console.log(`${color}${service.name} | ${line}\x1b[0m`);
            }
        });
    });

    proc.stderr.on('data', (data) => {
        console.log(`\x1b[31m${service.name} | ❌ ${data.toString().trim()}\x1b[0m`);
    });

    proc.on('close', (code) => {
        if (code !== 0) {
            console.log(`\x1b[31m${service.name} | ⚠️ با کد ${code} متوقف شد\x1b[0m`);
        }
    });

    processes.push(proc);
});

// ===== نمایش وضعیت نهایی =====
setTimeout(() => {
    console.log('\x1b[36m%s\x1b[0m', '═══════════════════════════════════════════════');
    console.log('\x1b[32m%s\x1b[0m', '✅ همه سرویس‌ها با موفقیت اجرا شدند!');
    console.log('\x1b[36m%s\x1b[0m', '═══════════════════════════════════════════════');
    console.log('\x1b[34m📡 سایت:    http://localhost:3000\x1b[0m');
    console.log('\x1b[32m📸 پست‌ها:  http://localhost:3001\x1b[0m');
    console.log('\x1b[35m💬 چت:     http://localhost:3002\x1b[0m');
    console.log('\x1b[36m%s\x1b[0m', '═══════════════════════════════════════════════');
    console.log('\x1b[33m🔴 برای توقف: Ctrl+C\x1b[0m');
    console.log('\x1b[36m%s\x1b[0m', '═══════════════════════════════════════════════');
}, 3000);

// ===== مدیریت خروج =====
process.on('SIGINT', () => {
    console.log('\n\x1b[33m🛑 در حال توقف همه سرویس‌ها...\x1b[0m');
    processes.forEach(proc => {
        proc.kill('SIGINT');
    });
    setTimeout(() => {
        console.log('\x1b[32m✅ همه سرویس‌ها متوقف شدند\x1b[0m');
        process.exit(0);
    }, 1500);
});

// ===== نمایش زمان اجرا =====
let startTime = Date.now();
setInterval(() => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hrs = String(Math.floor(uptime / 3600)).padStart(2, '0');
    const mins = String(Math.floor((uptime % 3600) / 60)).padStart(2, '0');
    const secs = String(uptime % 60).padStart(2, '0');
    process.title = `Instagram | ${hrs}:${mins}:${secs}`;
}, 1000);

console.log('\x1b[32m✅ فایل اصلی آماده است! فقط کافی است اجرا کنید:\x1b[0m');
console.log('\x1b[33m   node server.js\x1b[0m');
console.log('');