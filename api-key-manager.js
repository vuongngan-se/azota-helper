// API Key Manager cho À Zố Tà
class ApiKeyManager {
  constructor() {
    this.apiKeys = [];
    this.currentKeyIndex = 0;
    this.maxRetries = 3;
    this.retryCount = 0;
    this.init();
  }

  async init() {
    await this.loadApiKeys();
    await this.loadCurrentKeyIndex();
  }

  async loadApiKeys() {
    try {
      console.log('Attempting to load API keys from file...');
      
      // Đọc file api-keys.txt
      const response = await fetch(chrome.runtime.getURL('api-keys.txt'));
      
      if (!response.ok) {
        throw new Error(`Failed to fetch api-keys.txt: ${response.status} ${response.statusText}`);
      }
      
      const text = await response.text();
      console.log('Raw file content length:', text.length);
      
      // Parse các dòng, loại bỏ comment và dòng trống
      this.apiKeys = text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && !line.startsWith('//'))
        .filter(line => line.startsWith('AIzaSy')); // Chỉ lấy các key hợp lệ
      
      console.log('Loaded API keys:', this.apiKeys.length);
      console.log('API keys:', this.apiKeys);
      
      if (this.apiKeys.length === 0) {
        console.error('No valid API keys found in api-keys.txt');
        console.error('File content:', text);
        throw new Error('No API keys found in api-keys.txt file');
      }
    } catch (error) {
      console.error('Error loading API keys:', error);
      throw error; // Không fallback, báo lỗi rõ ràng
    }
  }

  async loadCurrentKeyIndex() {
    try {
      const result = await new Promise(resolve => 
        chrome.storage.local.get(['currentKeyIndex'], resolve)
      );
      this.currentKeyIndex = result.currentKeyIndex || 0;
      
      // Đảm bảo index không vượt quá số lượng key
      if (this.currentKeyIndex >= this.apiKeys.length) {
        this.currentKeyIndex = 0;
        await this.saveCurrentKeyIndex();
      }
    } catch (error) {
      console.error('Error loading current key index:', error);
      this.currentKeyIndex = 0;
    }
  }

  async saveCurrentKeyIndex() {
    try {
      await new Promise(resolve => 
        chrome.storage.local.set({ currentKeyIndex: this.currentKeyIndex }, resolve)
      );
    } catch (error) {
      console.error('Error saving current key index:', error);
    }
  }

  getCurrentApiKey() {
    if (this.apiKeys.length === 0) {
      throw new Error('Không có API key. Vui lòng thêm API key vào file api-keys.txt');
    }
    return this.apiKeys[this.currentKeyIndex];
  }

  async rotateToNextKey() {
    this.retryCount++;
    
    if (this.retryCount >= this.maxRetries) {
      console.error('Max retries reached, cannot rotate to next key');
      return false;
    }

    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    await this.saveCurrentKeyIndex();
    
    console.log(`Rotated to API key index: ${this.currentKeyIndex}`);
    return true;
  }

  async handleApiError(error) {
    console.log('API Error detected:', error);
    
    // Kiểm tra nếu là lỗi API key (400, 403, 429)
    if (error.message.includes('API Error: 400') || 
        error.message.includes('API Error: 403') || 
        error.message.includes('API Error: 429')) {
      
      console.log('API key error detected, attempting to rotate...');
      
      const rotated = await this.rotateToNextKey();
      if (rotated) {
        console.log('Successfully rotated to next API key');
        return true; // Đã chuyển key, có thể thử lại
      }
    }
    
    return false; // Không thể chuyển key hoặc không phải lỗi key
  }

  resetRetryCount() {
    this.retryCount = 0;
  }

  formatApiKey(key) {
    if (!key || key.length < 20) {
      return key || 'Unknown';
    }
    // Hiển thị 8 ký tự đầu + ... + 8 ký tự cuối
    const start = key.substring(0, 8);
    const end = key.substring(key.length - 8);
    return `${start}...${end}`;
  }

  getKeyInfo() {
    return {
      totalKeys: this.apiKeys.length,
      currentIndex: this.currentKeyIndex,
      currentKey: this.formatApiKey(this.getCurrentApiKey()),
      retryCount: this.retryCount
    };
  }
}

// Export cho sử dụng trong content script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ApiKeyManager;
} else {
  window.ApiKeyManager = ApiKeyManager;
}
