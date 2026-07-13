// ================================================================
// encryption.js - رمزنگاری AES-256-GCM
// ================================================================

const crypto = require('crypto');

class EncryptionManager {
  constructor() {
    this.key = Buffer.from(process.env.ENCRYPTION_KEY || 'default_32_byte_key_for_encryption!!', 'utf8');
    if (this.key.length < 32) {
      this.key = crypto.pbkdf2Sync(this.key, 'salt', 100000, 32, 'sha256');
    }
  }

  encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    let encrypted = cipher.update(text, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();
    return { encrypted, iv: iv.toString('base64'), authTag: authTag.toString('base64') };
  }

  decrypt(encryptedData, ivBase64, authTagBase64) {
    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}

module.exports = new EncryptionManager();