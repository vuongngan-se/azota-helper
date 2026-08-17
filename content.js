// Simple API Key Manager embedded in content script
class SimpleApiKeyManager {
  constructor() {
    this.apiKeys = [];
    this.currentKeyIndex = 0;
    this.maxRetries = 3;
    this.retryCount = 0;
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
      console.log('Raw file content:', text);
      
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
      throw error;
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

// Content script cho À Zố Tà
class AzotaGeminiHelper {
  constructor() {
    this.apiKeyManager = null;
    this.isProcessing = false;
    this.currentQuestionId = null;
    this.isPaused = false;
    this.pauseIndicator = null;
    this.minimalMode = false;
    this.submitButtonElement = null; // Element button "Nộp bài"
    this.websiteType = null; // 'azota' hoặc 'el2'
    this.azotaMode = true; // Mặc định bật Azota
    this.el2Mode = false; // Mặc định tắt EL2
    this.markedEL2Elements = []; // Lưu các element đã được đánh dấu trong EL2
    this.styleObserver = null; // MutationObserver để theo dõi style changes
    this.isRemovingStyles = false; // Flag để tránh vòng lặp vô hạn
    this.init();
  }

  async init() {
    console.log('🔵 [INIT] Starting initialization...');
    console.log('🔵 [INIT] Document ready state:', document.readyState);
    console.log('🔵 [INIT] URL:', window.location.href);
    
    // Với file local, có thể cần đợi DOM load xong
    if (document.readyState === 'loading') {
      console.log('🔵 [INIT] DOM đang loading, đợi DOMContentLoaded...');
      await new Promise(resolve => {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', resolve, { once: true });
        } else {
          resolve();
        }
      });
      console.log('🔵 [INIT] DOM đã load xong');
    }
    
    // Với file local, đợi lâu hơn để đảm bảo DOM đã render hoàn toàn
    const isFileLocal = window.location.href.startsWith('file://');
    const waitTime = isFileLocal ? 1000 : 500;
    console.log(`🔵 [INIT] Waiting ${waitTime}ms for DOM to render...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    // Detect website type (có thể retry nhiều lần nếu là file local)
    this.detectWebsite();
    
    // Nếu là file local và chưa detect được, thử lại nhiều lần
    if (isFileLocal && this.websiteType === 'unknown') {
      console.log('🔵 [INIT] File local chưa detect được structure, sẽ retry...');
      
      // Retry nhiều lần với delay tăng dần
      const retries = [1000, 2000, 3000];
      retries.forEach((delay, index) => {
        setTimeout(() => {
          console.log(`🔵 [INIT] Retry ${index + 1} detecting website type after ${delay}ms...`);
          this.detectWebsite();
          if (this.websiteType === 'el2') {
            console.log('🟢 [INIT] Detected EL2 structure after retry, continuing initialization...');
            this.continueInit();
          } else if (index === retries.length - 1) {
            // Lần retry cuối cùng, vẫn tiếp tục init để có thể bật mode sau
            console.log('🟡 [INIT] Still cannot detect structure, but continuing initialization...');
            this.continueInit();
          }
        }, delay);
      });
      
      // Nếu sau 1 giây đầu tiên vẫn không detect được, vẫn tiếp tục init
      // (có thể user sẽ bật mode thủ công)
      setTimeout(() => {
        if (this.websiteType === 'unknown' && !this._continueInitCalled) {
          console.log('🟡 [INIT] Continuing initialization even though structure not detected...');
          this._continueInitCalled = true;
          this.continueInit();
        }
      }, 1500);
      
      return; // Tạm dừng init, sẽ tiếp tục sau khi retry
    }
    
    await this.continueInit();
  }

  async continueInit() {
    console.log('🔵 [INIT] Continuing initialization with website type:', this.websiteType);
    
    // Load mode settings
    await this.loadModeSettings();
    
    // Khởi tạo API Key Manager (luôn khởi tạo để có thể toggle mode sau)
    await this.initApiKeyManager();
    
    // Kiểm tra trạng thái pause từ storage
    await this.checkPauseState();
    await this.loadMinimalMode();
    
    // Lắng nghe messages từ background script
    this.setupMessageListener();
    
    // Luôn thêm event listener (sẽ kiểm tra mode trong handler)
    console.log('🔵 [INIT] Adding answer click listeners...');
    this.addAnswerClickListener();
    
    // Tìm element button "Nộp bài" (chỉ cho Azota)
    if (this.websiteType === 'azota') {
      this.findSubmitButtonElement();
      
      // Tìm lại button mỗi 2 giây để đảm bảo tìm được button được tạo động
      setInterval(() => {
        if (!this.submitButtonElement) {
          this.findSubmitButtonElement();
        }
      }, 2000);
    }
    
    // Kiểm tra và log mode status
    console.log('🔵 [INIT] Final status:', {
      websiteType: this.websiteType,
      azotaMode: this.azotaMode,
      el2Mode: this.el2Mode,
      isPaused: this.isPaused
    });
    
    if ((this.websiteType === 'azota' && !this.azotaMode) || 
        (this.websiteType === 'el2' && !this.el2Mode)) {
      console.log(`🟡 [INIT] Extension đã khởi tạo nhưng không hoạt động cho ${this.websiteType} vì mode chưa được bật. Bật mode trong popup để sử dụng.`);
    } else if (this.websiteType === 'unknown') {
      console.log(`🟡 [INIT] Extension không thể detect website type. URL: ${window.location.href}`);
    } else {
      console.log(`🟢 [INIT] Extension đã sẵn sàng cho ${this.websiteType}!`);
    }
    
    // Debug: hiển thị tất cả element có thể click
    setTimeout(() => {
      this.debugPageElements();
    }, 2000);
    
    // Đối với EL2, kiểm tra lại marked elements sau khi trang load xong
    if (this.websiteType === 'el2') {
      // Thiết lập MutationObserver để theo dõi style changes
      this.setupStyleObserver();
      
      setTimeout(() => {
        // Tìm lại các element đã được đánh dấu và cập nhật
        this.findAndAddExistingMarkedElements();
        this.updateEL2MarkedElements().catch(err => console.error('Error updating marked elements:', err));
      }, 1000);
    }
  }

  setupStyleObserver() {
    console.log('🔵 [OBSERVER] Setting up style observer');
    // Tạo MutationObserver để theo dõi thay đổi style attribute
    this.styleObserver = new MutationObserver((mutations) => {
      // Tránh xử lý nếu đang trong quá trình xóa style
      if (this.isRemovingStyles) {
        console.log('🔵 [OBSERVER] Skipping - isRemovingStyles is true');
        return;
      }
      
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
          const element = mutation.target;
          const isMarked = this.markedEL2Elements.includes(element);
          console.log('🔵 [OBSERVER] Style changed on element, isMarked:', isMarked, 'minimalMode:', this.minimalMode);
          
          // Chỉ xử lý nếu element trong danh sách marked elements và minimalMode = true
          if (isMarked && this.minimalMode === true) {
            const style = element.getAttribute('style') || '';
            const hasMarkingStyle = style && (
              (style.includes('border') && (style.includes('76, 175, 80') || style.includes('4CAF50'))) ||
              (style.includes('background-color') && style.includes('76, 175, 80'))
            );
            
            if (hasMarkingStyle) {
              console.log('🟢 [OBSERVER] Detected marking style, removing it. Style:', style);
              this.isRemovingStyles = true;
              this.removeEL2MarkingStyles(element);
              // Reset flag sau một chút
              setTimeout(() => {
                this.isRemovingStyles = false;
                console.log('🔵 [OBSERVER] Reset isRemovingStyles flag');
              }, 50);
            }
          }
        }
      });
    });
    
    console.log('🟢 [OBSERVER] Style observer created, starting to observe');
    // Bắt đầu quan sát tất cả marked elements
    this.observeMarkedElements();
  }

  observeMarkedElements() {
    // Quan sát tất cả marked elements
    this.markedEL2Elements.forEach(element => {
      if (element && element.parentNode) {
        this.styleObserver.observe(element, {
          attributes: true,
          attributeFilter: ['style']
        });
      }
    });
  }

  detectWebsite() {
    const url = window.location.href;
    console.log('🔵 [DETECT] Detecting website type from URL:', url);
    console.log('🔵 [DETECT] Document ready state:', document.readyState);
    console.log('🔵 [DETECT] Body exists:', !!document.body);
    console.log('🔵 [DETECT] Document body children:', document.body?.children.length || 0);
    
    if (url.includes('azota.vn')) {
      this.websiteType = 'azota';
      console.log('🟢 [DETECT] Detected Azota website');
    } else if (url.includes('elearning2.vku.udn.vn')) {
      this.websiteType = 'el2';
      console.log('🟢 [DETECT] Detected Elearning 2 website');
    } else if (url.startsWith('file://') || url.includes('127.0.0.1') || url.includes('localhost')) {
      const urlType = url.startsWith('file://') ? 'File local' : 'Localhost';
      console.log(`🔵 [DETECT] ${urlType} detected, checking for EL2 structure...`);
      
      // Kiểm tra nhiều selector để tìm cấu trúc EL2
      const queElement = document.querySelector('.que.multichoice, .que');
      const qtextElement = document.querySelector('.qtext');
      const answerElement = document.querySelector('.answer');
      const radioButtons = document.querySelectorAll('input[type="radio"]');
      
      console.log('🔵 [DETECT] Structure check:', {
        hasQue: !!queElement,
        hasQtext: !!qtextElement,
        hasAnswer: !!answerElement,
        radioButtonsCount: radioButtons.length,
        queClass: queElement?.className,
        qtextContent: qtextElement?.textContent?.substring(0, 50)
      });
      
      // Nếu có bất kỳ dấu hiệu nào của EL2 structure
      if (queElement || (qtextElement && answerElement) || (radioButtons.length > 0 && answerElement)) {
        this.websiteType = 'el2';
        console.log(`🟢 [DETECT] ${urlType} detected với cấu trúc EL2!`);
        console.log('🟢 [DETECT] Found elements:', {
          que: queElement ? 'YES' : 'NO',
          qtext: qtextElement ? 'YES' : 'NO',
          answer: answerElement ? 'YES' : 'NO',
          radios: radioButtons.length
        });
      } else {
        this.websiteType = 'unknown';
        console.log(`🟡 [DETECT] ${urlType} nhưng không có cấu trúc EL2`);
        console.log('🟡 [DETECT] Available elements:', {
          allDivs: document.querySelectorAll('div').length,
          allInputs: document.querySelectorAll('input').length,
          bodyHTML: document.body?.innerHTML?.substring(0, 200) || 'No body'
        });
      }
    } else {
      this.websiteType = 'unknown';
      console.log('🟡 [DETECT] Unknown website type');
    }
    console.log('🔵 [DETECT] Final website type:', this.websiteType);
  }

  async loadModeSettings() {
    try {
      const result = await new Promise(resolve => 
        chrome.storage.local.get(['azotaMode', 'el2Mode'], resolve)
      );
      // Mặc định bật Azota, tắt EL2
      this.azotaMode = result.azotaMode ?? true;
      this.el2Mode = result.el2Mode ?? false;
      console.log('Mode settings loaded:', { azotaMode: this.azotaMode, el2Mode: this.el2Mode });
    } catch (e) {
      console.warn('Cannot load mode settings:', e);
      // Mặc định
      this.azotaMode = true;
      this.el2Mode = false;
    }
  }

  async initApiKeyManager() {
    try {
      console.log('Starting API Key Manager initialization...');
      
      // Tạo ApiKeyManager trực tiếp thay vì load script
      this.apiKeyManager = new SimpleApiKeyManager();
      await this.apiKeyManager.init();
      
      console.log('API Key Manager initialized:', this.apiKeyManager.getKeyInfo());
    } catch (error) {
      console.error('Error initializing API Key Manager:', error);
      // Không fallback, chỉ log ra console
      this.apiKeyManager = null;
      console.log('API Key Manager initialization failed, extension will not work properly');
    }
  }

  async loadMinimalMode() {
    try {
      const result = await new Promise(resolve => chrome.storage.local.get(['minimalMode'], resolve));
      // Mặc định tắt thông báo (minimalMode = true)
      this.minimalMode = result.minimalMode ?? true;
      console.log('Minimal mode loaded:', this.minimalMode);
      
      // Tìm và thêm các element đã có border xanh vào danh sách (nếu có)
      this.findAndAddExistingMarkedElements();
      
      // Cập nhật tất cả marked elements dựa trên minimalMode
      await this.updateEL2MarkedElements();
    } catch (e) {
      console.warn('Cannot load minimalMode:', e);
      // Nếu không load được, mặc định tắt thông báo
      this.minimalMode = true;
      // Vẫn cần update elements
      this.findAndAddExistingMarkedElements();
      await this.updateEL2MarkedElements();
    }
  }

  findAndAddExistingMarkedElements() {
    // Tìm tất cả các element có border xanh (đã được đánh dấu trước đó)
    // Chỉ tìm trong các container câu hỏi EL2
    const questionContainers = document.querySelectorAll('.que.multichoice, .que');
    questionContainers.forEach(container => {
      const answerElements = container.querySelectorAll('.answer .r0, .answer .r1');
      answerElements.forEach(element => {
        // Kiểm tra nếu element có border xanh hoặc background xanh nhạt
        // Kiểm tra style trực tiếp trước (nhanh hơn)
        const styleAttr = element.getAttribute('style') || '';
        const hasGreenBorder = styleAttr && (
          styleAttr.includes('#4CAF50') ||
          styleAttr.includes('4CAF50') ||
          styleAttr.includes('rgb(76, 175, 80)') ||
          styleAttr.includes('76, 175, 80')
        ) && styleAttr.includes('border');
        
        const hasGreenBackground = styleAttr && (
          styleAttr.includes('rgba(76, 175, 80') ||
          styleAttr.includes('76, 175, 80')
        ) && (styleAttr.includes('background-color') || styleAttr.includes('background'));
        
        // Nếu không tìm thấy trong style, kiểm tra computed style
        let hasGreenBorderComputed = false;
        if (!hasGreenBorder) {
          try {
            const computedStyle = window.getComputedStyle(element);
            const borderColor = computedStyle.borderColor;
            const borderWidth = computedStyle.borderWidth;
            
            // Kiểm tra nếu có border xanh
            if (borderWidth !== '0px' && borderWidth !== '0' && (
              borderColor.includes('rgb(76, 175, 80)') || 
              borderColor.includes('76, 175, 80')
            )) {
              hasGreenBorderComputed = true;
            }
          } catch (e) {
            // Ignore errors
          }
        }
        
        // Nếu có border xanh hoặc background xanh, thêm vào danh sách
        if (hasGreenBorder || hasGreenBackground || hasGreenBorderComputed) {
          // Thêm vào danh sách nếu chưa có
          if (!this.markedEL2Elements.includes(element)) {
            this.markedEL2Elements.push(element);
            console.log('Found existing marked element, added to list');
            // Thêm vào observer nếu đã được setup
            if (this.styleObserver && element.parentNode) {
              this.styleObserver.observe(element, {
                attributes: true,
                attributeFilter: ['style']
              });
            }
          }
        }
      });
    });
  }
  
  debugPageElements() {
    console.log('=== DEBUG PAGE ELEMENTS ===');
    
    // Tìm tất cả element có thể là câu hỏi
    const questionSelectors = [
      '.question-standalone-main-content',
      '.question-container', 
      '.question-item',
      '[class*="question"]',
      '.quiz-item',
      '.test-item'
    ];
    
    questionSelectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      console.log(`Selector "${selector}":`, elements.length, 'elements');
      if (elements.length > 0) {
        console.log('First element:', elements[0]);
      }
    });
    
    // Tìm tất cả element có thể là đáp án
    const answerSelectors = [
      '.item-answer',
      '.answer-item', 
      '[class*="answer"]',
      '[class*="option"]',
      '.choice',
      '.option-item'
    ];
    
    answerSelectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      console.log(`Answer selector "${selector}":`, elements.length, 'elements');
      if (elements.length > 0) {
        console.log('First answer element:', elements[0]);
      }
    });
    
    console.log('=== END DEBUG ===');
  }

  async checkPauseState() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getPauseState' });
      console.log('Initial pause state from storage:', response);
      this.isPaused = response.isPaused || false;
      console.log('Set isPaused to:', this.isPaused);
      this.updatePauseIndicator();
    } catch (error) {
      console.error('Lỗi khi kiểm tra trạng thái pause:', error);
    }
  }

  setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      console.log('Content script received message:', request);
      if (request.action === 'pauseStateChanged' || request.action === 'togglePause') {
        console.log('Updating pause state:', this.isPaused, '->', request.isPaused);
        this.isPaused = request.isPaused;
        this.updatePauseIndicator();
        this.showNotification(
          // this.isPaused ? 'Extension đã tạm dừng (Alt+3 để tiếp tục)' : 'Extension đã tiếp tục hoạt động',
          // this.isPaused ? 'warning' : 'success'
        );
        sendResponse({ success: true });
      }

      if (request.action === 'minimalModeChanged') {
        const prev = this.minimalMode;
        this.minimalMode = Boolean(request.minimalMode);
        console.log('Minimal mode changed:', prev, '->', this.minimalMode);
        // Tìm lại các element đã được đánh dấu (có thể có element mới)
        this.findAndAddExistingMarkedElements();
        // Cập nhật lại border/background của tất cả marked elements
        this.updateEL2MarkedElements().then(() => {
          sendResponse({ success: true });
        }).catch(err => {
          console.error('Error updating marked elements:', err);
          sendResponse({ success: true });
        });
        return true; // Giữ message channel mở cho async response
      }

      if (request.action === 'modeChanged') {
        const prevAzota = this.azotaMode;
        const prevEl2 = this.el2Mode;
        this.azotaMode = Boolean(request.azotaMode);
        this.el2Mode = Boolean(request.el2Mode);
        console.log('Mode changed:', { 
          azotaMode: `${prevAzota} -> ${this.azotaMode}`,
          el2Mode: `${prevEl2} -> ${this.el2Mode}`
        });
        
        // Nếu mode được bật, thêm event listener nếu chưa có
        if ((this.websiteType === 'azota' && this.azotaMode) || 
            (this.websiteType === 'el2' && this.el2Mode)) {
          // Event listener sẽ được thêm lại thông qua addAnswerClickListener
          // Nhưng vì đã có event listener rồi (nếu đã init), nên không cần thêm lại
          // Chỉ cần đảm bảo mode được cập nhật
        }
        
        sendResponse({ success: true });
      }

      if (request.action === 'getApiKeyInfo') {
        if (this.apiKeyManager) {
          sendResponse({ keyInfo: this.apiKeyManager.getKeyInfo() });
        } else {
          sendResponse({ keyInfo: { totalKeys: 0, currentIndex: 0, currentKey: 'Không có key', retryCount: 0 } });
        }
      }
    });
  }

  updatePauseIndicator() {
    console.log('updatePauseIndicator called, isPaused:', this.isPaused);
    // Xóa indicator cũ nếu có
    if (this.pauseIndicator) {
      this.pauseIndicator.remove();
      this.pauseIndicator = null;
    }

    // Tạo indicator mới nếu đang pause
    if (this.isPaused) {
      console.log('Creating pause indicator');
      this.pauseIndicator = document.createElement('div');
      this.pauseIndicator.id = 'azota-pause-indicator';
      // this.pauseIndicator.innerHTML = `
      //   <div style="
      //     position: fixed;
      //     top: 20px;
      //     right: 20px;
      //     background: #ff6b6b;
      //     color: white;
      //     padding: 10px 15px;
      //     border-radius: 8px;
      //     font-family: Arial, sans-serif;
      //     font-size: 14px;
      //     font-weight: bold;
      //     z-index: 10000;
      //     box-shadow: 0 4px 12px rgba(255, 107, 107, 0.3);
      //     border: 2px solid #ff5252;
      //   ">
      //     ⏸️ EXTENSION TẠM DỪNG
      //     <br>
      //     <small style="font-size: 11px; opacity: 0.9;">Nhấn Alt+3 để tiếp tục</small>
      //   </div>
      // `;
      document.body.appendChild(this.pauseIndicator);
      
      // Ẩn dấu chấm thứ 2 khi tạm dừng
      this.hideSecondDots();
    } else {
      console.log('Not paused, no indicator needed');
      // Hiển thị lại dấu chấm thứ 2 khi tiếp tục
      this.showSecondDots();
    }
  }

  hideSecondDots() {
    // Với ảnh, chúng ta không cần ẩn dấu chấm thứ 2 vì chỉ có 1 dấu chấm
    // Hàm này giữ lại để tương thích nhưng không làm gì
    console.log('hideSecondDots called - no action needed for image-based answers');
  }

  showSecondDots() {
    // Với ảnh, chúng ta không cần hiển thị dấu chấm thứ 2 vì chỉ có 1 dấu chấm
    // Hàm này giữ lại để tương thích nhưng không làm gì
    console.log('showSecondDots called - no action needed for image-based answers');
  }

  findSubmitButtonElement() {
    // Tìm element button "Nộp bài"
    const selectors = [
      'button:contains("Nộp bài")',
      'button[class*="btn-primary"]:contains("Nộp bài")',
      'button[class*="mat-ripple"]:contains("Nộp bài")'
    ];
    
    // Tìm bằng cách duyệt qua tất cả button elements
    const buttons = document.querySelectorAll('button');
    console.log('Total buttons found:', buttons.length);
    
    for (const button of buttons) {
      const buttonText = button.textContent || '';
      console.log('Button text:', buttonText.trim());
      
      if (buttonText.includes('Nộp bài') || buttonText.includes('Nôp bài')) {
        this.submitButtonElement = button;
        console.log('Found submit button element:', buttonText.trim());
        console.log('Button HTML:', button.outerHTML);
        return;
      }
    }
    
    console.log('Submit button element not found');
    console.log('All button texts:', Array.from(buttons).map(b => b.textContent?.trim()).filter(t => t));
  }

  updateSubmitButtonDot(isError) {
    console.log('updateSubmitButtonDot called with isError:', isError);
    console.log('submitButtonElement:', this.submitButtonElement);
    
    // Cập nhật text trong button "Nộp bài" dựa trên trạng thái API
    if (this.submitButtonElement) {
      console.log('Button HTML before change:', this.submitButtonElement.outerHTML);
      
      // Tìm thẻ span chứa text "Nộp bài"
      const spanElement = this.submitButtonElement.querySelector('span');
      console.log('Span element found:', spanElement);
      
      if (spanElement) {
        const currentText = spanElement.textContent;
        //console.log('Current span text:', currentText);
        
        if (isError) {
          // Thay đổi: "Nộp bài" → "Nôp bài"
          if (currentText.includes('Nộp bài')) {
            spanElement.textContent = 'Nôp bài';
            console.log('Changed "Nộp bài" to "Nôp bài" (error)');
          } else {
            console.log('Span text does not contain "Nộp bài"');
          }
        } else {
          // Thay đổi: "Nôp bài" → "Nộp bài"
          if (currentText.includes('Nôp bài')) {
            spanElement.textContent = 'Nộp bài';
            console.log('Changed "Nôp bài" to "Nộp bài" (success)');
          } else {
            console.log('Span text does not contain "Nôp bài"');
          }
        }
      } else {
        console.log('No span element found, trying innerHTML approach');
        // Nếu không tìm thấy span, sử dụng innerHTML để thay đổi chỉ text mà giữ nguyên icon
        const currentHTML = this.submitButtonElement.innerHTML;
        console.log('Current button innerHTML:', currentHTML);
        
        if (isError) {
          if (currentHTML.includes('>Nộp bài<')) {
            const newHTML = currentHTML.replace('>Nộp bài<', '>Nôp bài<');
            this.submitButtonElement.innerHTML = newHTML;
            console.log('Changed "Nộp bài" to "Nôp bài" in button HTML (error)');
          } else {
            console.log('Button HTML does not contain ">Nộp bài<"');
          }
        } else {
          if (currentHTML.includes('>Nôp bài<')) {
            const newHTML = currentHTML.replace('>Nôp bài<', '>Nộp bài<');
            this.submitButtonElement.innerHTML = newHTML;
            console.log('Changed "Nôp bài" to "Nộp bài" in button HTML (success)');
          } else {
            console.log('Button HTML does not contain ">Nôp bài<"');
          }
        }
      }
      
      // console.log('Button HTML after change:', this.submitButtonElement.outerHTML);
    } else {
      console.log('No submit button element found, trying to find it again');
      // Thử tìm lại element nếu chưa tìm thấy
      this.findSubmitButtonElement();
      if (this.submitButtonElement) {
        console.log('Found submit button on retry, calling updateSubmitButtonDot again');
        this.updateSubmitButtonDot(isError);
      } else {
        console.log('Still no submit button found after retry');
      }
    }
  }

  addAnswerClickListener() {
    // Xử lý theo website type
    if (this.websiteType === 'azota') {
      // Sử dụng event delegation để bắt click vào các đáp án Azota
      document.addEventListener('click', (event) => {
        // Kiểm tra nếu extension đang bị pause
        if (this.isPaused) {
          this.showNotification('Extension đang tạm dừng. Nhấn Alt+Z để tiếp tục.', 'warning');
          return;
        }

        // Kiểm tra mode
        if (!this.azotaMode) {
          return; // Không xử lý nếu Azota mode tắt
        }

        // Tìm các selector phổ biến của Azota
        const answerElement = event.target.closest('.item-answer, .answer-item, [class*="answer"], [class*="option"], .choice, .option-item');
        if (answerElement) {
          // Kiểm tra xem câu hỏi này đã được giải chưa
          const questionContainer = answerElement.closest('.question-standalone-main-content, .question-container, .question-item, [class*="question"], .quiz-item, .test-item');
          if (questionContainer && questionContainer.getAttribute('data-azota-solved') === 'true') {
            console.log('Câu hỏi này đã được giải trước đó. Cho phép click chọn tự nhiên.');
            return; // Cho phép click tự nhiên, không preventDefault và không gửi API
          }

          event.preventDefault();
          this.processQuestionFromAnswer(answerElement);
        }
      });
    } else if (this.websiteType === 'el2') {
      // Thêm event listener cho EL2 - sử dụng cả click và change event
      this.setupEL2AnswerListeners();
    }
  }

  setupEL2AnswerListeners() {
    console.log('🔵 [EL2] Setting up answer click listeners...');
    console.log('🔵 [EL2] EL2 Mode:', this.el2Mode);
    console.log('🔵 [EL2] Website Type:', this.websiteType);
    console.log('🔵 [EL2] Is Paused:', this.isPaused);
    
    // Debounce timer để tránh gửi nhiều lần khi click nhanh
    let processTimer = null;
    let lastClickTime = 0;
    const DEBOUNCE_DELAY = 300; // 300ms debounce

    const triggerProcess = (clickedElement) => {
      console.log('🟢 [EL2] triggerProcess called');
      
      // Kiểm tra nếu đang xử lý thì bỏ qua
      if (this.isProcessing) {
        console.log('🟡 [EL2] Đang xử lý câu hỏi trước đó, bỏ qua click này');
        return;
      }

      // Kiểm tra debounce - tránh click quá nhanh
      const now = Date.now();
      if (now - lastClickTime < DEBOUNCE_DELAY) {
        console.log('🟡 [EL2] Click quá nhanh, bỏ qua');
        return;
      }

      // Clear timer cũ nếu có
      if (processTimer) {
        clearTimeout(processTimer);
        console.log('🟡 [EL2] Cleared previous timer');
      }

      // Tìm container câu hỏi hiện tại
      const questionContainer = clickedElement ? clickedElement.closest('.que.multichoice, .que') : document.querySelector('.que.multichoice, .que');
      if (!questionContainer) {
        console.log('🔴 [EL2] Không tìm thấy container câu hỏi');
        return;
      }

      // Kiểm tra xem câu hỏi này đã được giải chưa
      if (questionContainer.getAttribute('data-azota-solved') === 'true') {
        console.log('🟢 [EL2] Câu hỏi này đã được giải trước đó. Bỏ qua.');
        return;
      }

      console.log('🟢 [EL2] Found question container, scheduling process...');

      // Đặt timer để xử lý sau 200ms (để đảm bảo radio button đã được chọn)
      processTimer = setTimeout(() => {
        // Kiểm tra lại xem vẫn có container câu hỏi và chưa đang xử lý
        const currentQuestionContainer = clickedElement ? clickedElement.closest('.que.multichoice, .que') : document.querySelector('.que.multichoice, .que');
        if (currentQuestionContainer && !this.isProcessing) {
          lastClickTime = Date.now();
          console.log('🟢 [EL2] Bắt đầu xử lý câu hỏi EL2');
          this.processEL2Question(currentQuestionContainer).finally(() => {
            // Reset sau khi xử lý xong để có thể xử lý lại
            processTimer = null;
            console.log('🟢 [EL2] Xử lý xong, reset timer');
          });
        } else {
          console.log('🔴 [EL2] Không thể xử lý:', {
            hasContainer: !!currentQuestionContainer,
            isProcessing: this.isProcessing
          });
          processTimer = null;
        }
      }, 200);
    };

    // Thêm event listener cho click vào radio button, label, hoặc answer container
    document.addEventListener('click', (event) => {
      const target = event.target;
      
      // Log mọi click để debug (chỉ log các click có thể liên quan)
      const isPossibleAnswer = target.closest('.que.multichoice, .que, .answer, [id$="_label"]') ||
                               target.type === 'radio' ||
                               target.closest('input[type="radio"]');
      
      if (isPossibleAnswer) {
        console.log('🔵 [EL2] Click detected on:', {
          tagName: target.tagName,
          type: target.type,
          className: target.className,
          id: target.id,
          textContent: target.textContent?.substring(0, 50)
        });
      }
      
      // Kiểm tra nếu extension đang bị pause
      if (this.isPaused) {
        if (isPossibleAnswer) {
          console.log('🟡 [EL2] Extension đang bị pause, bỏ qua');
        }
        return;
      }

      // Kiểm tra mode
      if (!this.el2Mode) {
        if (isPossibleAnswer) {
          console.log('🟡 [EL2] EL2 mode chưa được bật, bỏ qua. Vui lòng bật EL2 mode trong popup!');
        }
        return; // Không xử lý nếu EL2 mode tắt
      }

      // Tìm radio button, label, hoặc answer container
      const isRadioButton = target.type === 'radio';
      const radioElement = target.closest('input[type="radio"]');
      const answerLabel = target.closest('[id$="_label"]');
      const answerContainer = target.closest('.answer .r0, .answer .r1, .answer');
      const isInQuestion = target.closest('.que.multichoice, .que');
      
      // Kiểm tra thêm: nếu click vào text trong answer container (như "a. Nói về...")
      // Tìm parent element có chứa answer structure
      let isAnswerText = false;
      if (isInQuestion) {
        // Kiểm tra xem có phải là text trong answer không
        const parentAnswer = target.closest('.r0, .r1');
        if (parentAnswer && parentAnswer.querySelector('input[type="radio"]')) {
          isAnswerText = true;
        }
        // Hoặc nếu click vào span có class answernumber hoặc text trong answer
        if (target.closest('.answernumber') || 
            (target.tagName === 'SPAN' && target.textContent && target.textContent.match(/^[a-d]\.\s*/i))) {
          isAnswerText = true;
        }
        // Hoặc nếu click vào div flex-fill trong answer
        if (target.closest('.flex-fill') && target.closest('.answer')) {
          isAnswerText = true;
        }
      }
      
      console.log('🔵 [EL2] Checking conditions:', {
        isRadioButton,
        hasRadioElement: !!radioElement,
        hasAnswerLabel: !!answerLabel,
        hasAnswerContainer: !!answerContainer,
        isInQuestion: !!isInQuestion,
        isAnswerText,
        targetTag: target.tagName,
        targetType: target.type,
        targetText: target.textContent?.substring(0, 30),
        targetClassName: target.className
      });
      
      // Kiểm tra nếu click vào radio button, label, hoặc answer container trong câu hỏi
      // HOẶC click vào text trong answer
      if (isInQuestion && (isRadioButton || radioElement || answerLabel || answerContainer || isAnswerText)) {
        console.log('🟢 [EL2] Click vào đáp án được phát hiện! Triggering process...');
        
        // Nếu click vào text đáp án (không phải radio button), tự động chọn radio button tương ứng
        if (!isRadioButton && !radioElement && (isAnswerText || answerLabel || answerContainer)) {
          // Tìm radio button gần nhất trong cùng answer container
          const answerParent = target.closest('.r0, .r1');
          if (answerParent) {
            const radioBtn = answerParent.querySelector('input[type="radio"]');
            if (radioBtn && !radioBtn.checked) {
              console.log('🟢 [EL2] Tự động chọn radio button:', radioBtn.id);
              radioBtn.checked = true;
              // Trigger change event
              const changeEvent = new Event('change', { bubbles: true });
              radioBtn.dispatchEvent(changeEvent);
            }
          }
        }
        
        // Không preventDefault để radio button vẫn được chọn tự nhiên
        triggerProcess(target);
      } else if (isInQuestion) {
        console.log('🟡 [EL2] Click trong câu hỏi nhưng không phải đáp án:', {
          target: target.tagName,
          className: target.className,
          textContent: target.textContent?.substring(0, 50),
          parent: target.parentElement?.tagName,
          parentClass: target.parentElement?.className
        });
      }
    }, true); // Sử dụng capture phase để bắt sớm hơn

    // Thêm event listener cho change event của radio button (backup)
    document.addEventListener('change', (event) => {
      // Kiểm tra nếu extension đang bị pause
      if (this.isPaused) {
        return;
      }

      // Kiểm tra mode
      if (!this.el2Mode) {
        return;
      }

      // Kiểm tra nếu là radio button trong câu hỏi
      if (event.target && event.target.type === 'radio' && 
          event.target.closest('.que.multichoice, .que')) {
        console.log('🟢 [EL2] Radio button change event detected, triggering process...');
        triggerProcess(event.target);
      }
    });
    
    console.log('🟢 [EL2] Event listeners setup completed');
  }

  async processQuestionFromAnswer(clickedAnswerElement) {
    // Kiểm tra nếu extension đang bị pause
    if (this.isPaused) {
      this.showNotification('Extension đang tạm dừng. Nhấn Alt+Z để tiếp tục.', 'warning');
      return;
    }

    if (this.isProcessing) {
      this.showNotification('Đang xử lý câu hỏi trước đó...', 'info');
      return;
    }

    this.isProcessing = true;
    this.showNotification('Đang phân tích câu hỏi...', 'info');

    try {
      // Tìm container câu hỏi với nhiều selector khác nhau
      let questionContainer = clickedAnswerElement.closest('.question-standalone-main-content, .question-container, .question-item, [class*="question"], .quiz-item, .test-item');
      
      if (!questionContainer) {
        // Nếu không tìm thấy container, thử tìm trong toàn bộ document
        console.log('Không tìm thấy question container, thử tìm trong document...');
        
        // Tìm câu hỏi gần nhất
        const allQuestions = document.querySelectorAll('.question-standalone-main-content, .question-container, .question-item, [class*="question"], .quiz-item, .test-item');
        if (allQuestions.length > 0) {
          questionContainer = allQuestions[0];
          console.log('Tìm thấy câu hỏi:', questionContainer);
        } else {
          this.showNotification('Không tìm thấy câu hỏi trên trang', 'error');
          return;
        }
      }

      const questionId = this.getQuestionId(questionContainer);
      
      // Reset dấu chấm của câu hỏi hiện tại nếu có
      if (this.currentQuestionId && this.currentQuestionId !== questionId) {
        this.resetQuestionMarks(this.currentQuestionId);
      }

      // Reset dấu chấm của câu hỏi mới
      this.resetQuestionMarks(questionId);
      this.currentQuestionId = questionId;

      const questionData = this.extractQuestionDataFromContainer(questionContainer);
      if (!questionData || !questionData.question || questionData.answers.length === 0) {
        this.showNotification('Không tìm thấy câu hỏi hoặc đáp án', 'error');
        return;
      }

      // Gửi đến Gemini API
      const result = await this.sendToGemini(questionData);
      
      if (!result || !result.answer) {
        this.showNotification('Không thể phân tích câu hỏi', 'error');
        return;
      }
      
      console.log('API result:', result);
      console.log('Question data answers:', questionData.answers.map(ans => ans.letter));
      
      // Đánh dấu đáp án đúng bằng dấu chấm và màu sắc
      this.markCorrectAnswerWithDotAndColor(result.answer, questionData.answers);
      
      // Đánh dấu câu hỏi là đã giải thành công
      if (questionContainer) {
        questionContainer.setAttribute('data-azota-solved', 'true');
        console.log('Marked question container as solved:', questionId);
      }
      
      // Dấu chấm button "Nộp bài" đã được cập nhật trong sendToGemini
      
      this.showNotification(`Đã phân tích xong! Đáp án đúng: ${result.answer}`, 'success');
      
    } catch (error) {
      console.error('Lỗi khi xử lý câu hỏi:', error);
      
      // Dấu chấm button "Nộp bài" đã được cập nhật trong sendToGemini
      
      // Xử lý các loại lỗi khác nhau
      if (error.message.includes('API Error: 400')) {
        this.showNotification('API key không hợp lệ hoặc bị hết hạn', 'error');
      } else if (error.message.includes('API Error: 403')) {
        this.showNotification('API bị chặn hoặc không có quyền truy cập', 'error');
      } else if (error.message.includes('API Error: 429')) {
        this.showNotification('API bị giới hạn số lượng request', 'error');
      } else if (error.message.includes('Cấu trúc response không hợp lệ')) {
        this.showNotification('API trả về dữ liệu không đúng định dạng', 'error');
      } else {
        this.showNotification('Lỗi: ' + error.message, 'error');
      }
    } finally {
      this.isProcessing = false;
    }
  }

  getQuestionId(questionContainer) {
    // Tạo ID duy nhất cho câu hỏi dựa trên nội dung
    const questionText = questionContainer.querySelector('.question-standalone-content-box span')?.textContent?.trim();
    return questionText ? questionText.substring(0, 50) : Math.random().toString();
  }

  extractQuestionDataFromContainer(questionContainer) {
    console.log('Extracting question data from container:', questionContainer);
    
    // Tìm câu hỏi (có thể là text hoặc ảnh)
    const questionData = this.extractQuestionContent(questionContainer);
    if (!questionData) {
      console.log('Không tìm thấy nội dung câu hỏi');
      return null;
    }
    
    console.log('Loại câu hỏi:', questionData.type, 'Nội dung:', questionData.content);
    
    // Tìm các đáp án (có thể là text hoặc ảnh)
    const answers = this.extractAnswersContent(questionContainer);
    if (answers.length === 0) {
      console.log('Không tìm thấy đáp án hợp lệ');
      return null;
    }
    
    console.log('Kết quả extract:', { question: questionData, answers: answers.length });
    
    return {
      question: questionData,
      answers: answers
    };
  }

  extractQuestionContent(container) {
    // Tìm phần câu hỏi trước (không bao gồm đáp án)
    const questionSection = container.querySelector('.question-standalone-content-box, .question-content, [class*="question"]:not([class*="answer"]):not([class*="option"])');
    
    console.log('Question section found:', questionSection);
    
    if (questionSection) {
      // Thử tìm ảnh câu hỏi trong phần câu hỏi
      const questionImage = questionSection.querySelector('img, hook-image img');
      console.log('Question image in section:', questionImage);
      if (questionImage) {
        console.log('Question image URL:', questionImage.src);
        return {
          type: 'image',
          content: questionImage.src
        };
      }
    }
    
    // Fallback: tìm ảnh đầu tiên trong container (nhưng loại trừ đáp án)
    const allImages = container.querySelectorAll('img');
    console.log('All images in container:', allImages.length);
    for (let img of allImages) {
      // Kiểm tra xem ảnh này có nằm trong phần đáp án không
      const isInAnswer = img.closest('[class*="answer"], [class*="option"], .answer-item, .option-item');
      console.log('Image URL:', img.src, 'Is in answer:', !!isInAnswer);
      if (!isInAnswer) {
        console.log('Using fallback image for question:', img.src);
        return {
          type: 'image',
          content: img.src
        };
      }
    }
    
    // Nếu không có ảnh, tìm text câu hỏi
    if (questionSection) {
      const textContent = questionSection.textContent?.trim();
      if (textContent && textContent.length > 0) {
        return {
          type: 'text',
          content: textContent
        };
      }
    }
    
    // Fallback: tìm text câu hỏi trong toàn bộ container
    const questionTextSelectors = [
      '.question-standalone-content-box span',
      '.question-content span',
      '.question-text',
      '[class*="question"] span',
      '.question-standalone-content-box'
    ];
    
    for (const selector of questionTextSelectors) {
      const questionElement = container.querySelector(selector);
      if (questionElement && questionElement.textContent.trim()) {
        return {
          type: 'text',
          content: questionElement.textContent.trim()
        };
      }
    }
    
    return null;
  }

  extractAnswersContent(container) {
    const answerElements = container.querySelectorAll('.item-answer, .answer-item, [class*="answer"], [class*="option"], .choice, .option-item');
    console.log('Tìm thấy', answerElements.length, 'phần tử đáp án');
    
    const answers = [];
    const usedLetters = new Set();
    
    answerElements.forEach((element, index) => {
      const button = element.querySelector('button, [class*="button"], [class*="btn"]');
      if (!button) return;
      
        const letter = button.textContent.trim().match(/[A-D]/)?.[0] || String.fromCharCode(65 + index);
      
      // Chỉ thêm nếu chưa có đáp án với chữ cái này
      if (usedLetters.has(letter)) {
        console.log('Bỏ qua đáp án trùng lặp:', letter);
        return;
      }
      usedLetters.add(letter);
      
      // Thử tìm ảnh đáp án trước
      const answerImage = element.querySelector('hook-image img.img-docx, .answer-content img, [class*="answer"] img, img');
      if (answerImage) {
        answers.push({
          letter: letter,
          type: 'image',
          content: answerImage.src,
          element: element
        });
        console.log('Đáp án', letter, '(ảnh):', answerImage.src);
        return;
      }
      
      // Nếu không có ảnh, tìm text đáp án
      const answerTextSelectors = [
        '.answer-content span',
        '.answer-text',
        '[class*="answer"] span',
        'span'
      ];
      
      for (const selector of answerTextSelectors) {
        const answerElement = element.querySelector(selector);
        if (answerElement && answerElement.textContent.trim() && !answerElement.textContent.trim().match(/^[A-D]$/)) {
          answers.push({
            letter: letter,
            type: 'text',
            content: answerElement.textContent.trim(),
            element: element
          });
          console.log('Đáp án', letter, '(text):', answerElement.textContent.trim());
          return;
        }
      }
    });
    
    return answers;
  }

  createPrompt(questionData) {
    const questionType = questionData.question.type;
    const answerTypes = questionData.answers.map(a => a.type);
    
    let prompt = '';
    
    // Tạo prompt dựa trên loại câu hỏi
    if (questionType === 'image') {
      prompt += 'Xem ảnh câu hỏi';
    } else {
      prompt += `Câu hỏi: ${questionData.question.content}`;
    }
    
    // Tạo prompt dựa trên loại đáp án
    const hasImageAnswers = answerTypes.includes('image');
    const hasTextAnswers = answerTypes.includes('text');
    
    if (hasImageAnswers && hasTextAnswers) {
      prompt += ' và các đáp án (có cả ảnh và chữ). Chọn đáp án đúng.';
    } else if (hasImageAnswers) {
      prompt += ' và 4 đáp án dạng ảnh. Chọn đáp án đúng.';
    } else {
      prompt += ' và 4 đáp án dạng chữ. Chọn đáp án đúng.';
    }
    
    // Thêm thông tin đáp án text nếu có
    if (hasTextAnswers) {
      prompt += '\n\nCác đáp án:\n';
      questionData.answers.forEach(answer => {
        if (answer.type === 'text') {
          prompt += `${answer.letter}. ${answer.content}\n`;
        }
      });
    }
    
    prompt += '\nTrả lời: ĐÁP ÁN: [A/B/C/D]';
    
    console.log('Created prompt:', prompt);
    return prompt;
  }

  resetQuestionMarks(questionId) {
    // Tìm tất cả câu hỏi có ID tương tự và reset dấu chấm + màu sắc
    const questionContainers = document.querySelectorAll('.question-standalone-main-content');
    questionContainers.forEach(container => {
      const currentQuestionId = this.getQuestionId(container);
      if (currentQuestionId === questionId) {
        container.removeAttribute('data-azota-solved');
        const answerElements = container.querySelectorAll('.item-answer');
        answerElements.forEach(element => {
          // Reset border-radius của button
          const buttonElement = element.querySelector('button, [class*="button"], [class*="btn"]');
          if (buttonElement) {
            // Reset border-radius về mặc định
            buttonElement.style.borderRadius = '';
          }
          
          // Không cần reset màu sắc vì không có thêm màu
        });
      }
    });
  }

  async convertImageToBase64(imageUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      
      img.onload = function() {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        // Tối ưu kích thước ảnh để giảm dung lượng
        const maxWidth = 800;
        const maxHeight = 600;
        
        let { width, height } = img;
        
        // Tính toán kích thước mới giữ nguyên tỷ lệ
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width = Math.floor(width * ratio);
          height = Math.floor(height * ratio);
        }
        
        canvas.width = width;
        canvas.height = height;
        
        // Vẽ ảnh với kích thước đã tối ưu
        ctx.drawImage(img, 0, 0, width, height);
        
        try {
          // Sử dụng JPEG với chất lượng 0.8 để giảm dung lượng
          const dataURL = canvas.toDataURL('image/jpeg', 0.8);
          // Loại bỏ phần "data:image/jpeg;base64," để chỉ lấy base64
          const base64 = dataURL.split(',')[1];
          resolve(base64);
        } catch (error) {
          reject(error);
        }
      };
      
      img.onerror = function() {
        reject(new Error('Không thể tải ảnh: ' + imageUrl));
      };
      
      img.src = imageUrl;
    });
  }

  async sendToGemini(questionData) {
    // Kiểm tra dữ liệu trước khi sử dụng
    if (!questionData || !questionData.question || !questionData.answers || !Array.isArray(questionData.answers)) {
      throw new Error('Dữ liệu câu hỏi không hợp lệ');
    }

    // Kiểm tra API Key Manager
    if (!this.apiKeyManager) {
      console.error('API Key Manager chưa được khởi tạo. Vui lòng kiểm tra file api-keys.txt');
      throw new Error('API Key Manager not initialized');
    }
    
    // Lấy API key hiện tại
    const currentApiKey = this.apiKeyManager.getCurrentApiKey();
    
    // Chuẩn bị dữ liệu cho Gemini
    const parts = [];
    
    // Tạo prompt dựa trên loại câu hỏi và đáp án
    const prompt = this.createPrompt(questionData);
    parts.push({ text: prompt });
    
    // Thêm ảnh câu hỏi nếu có
    if (questionData.question.type === 'image') {
      try {
        const questionImageData = await this.convertImageToBase64(questionData.question.content);
        parts.push({
          inline_data: {
            mime_type: "image/jpeg",
            data: questionImageData
          }
        });
        console.log('Đã thêm ảnh câu hỏi');
      } catch (error) {
        console.error('Lỗi khi convert ảnh câu hỏi:', error);
        throw new Error('Không thể xử lý ảnh câu hỏi');
      }
    }
    
    // Thêm ảnh các đáp án (chỉ những đáp án có ảnh)
    const maxAnswers = Math.min(questionData.answers.length, 4);
    for (let i = 0; i < maxAnswers; i++) {
      const answer = questionData.answers[i];
      if (answer.type === 'image') {
        try {
          const answerImageData = await this.convertImageToBase64(answer.content);
          parts.push({
            inline_data: {
              mime_type: "image/jpeg", 
              data: answerImageData
            }
          });
          console.log(`Đã thêm ảnh đáp án ${answer.letter}`);
        } catch (error) {
          console.error(`Lỗi khi convert ảnh đáp án ${answer.letter}:`, error);
          // Tiếp tục với các đáp án khác
        }
      }
    }
    
    // Kiểm tra xem có đủ dữ liệu không
    if (parts.length < 1) {
      throw new Error('Không có dữ liệu để phân tích');
    }
    
    // Đối với câu hỏi text + đáp án text, chỉ cần prompt là đủ
    const hasImages = parts.some(part => part.inline_data);
    if (!hasImages && parts.length === 1) {
      console.log('Câu hỏi text + đáp án text, chỉ cần prompt');
    }

    // Parts đã được tạo ở trên với prompt và ảnh
    
    // Tạo AbortController để timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 giây timeout
    
    let data;
    try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${currentApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
            parts: parts
        }],
          generationConfig: {
            temperature: 0.1,
            topK: 1,
            topP: 0.8,
              maxOutputTokens: 4096,
          }
        }),
        signal: controller.signal
    });
      
      clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('API Error Response:', errorText);
        
        // Cập nhật dấu chấm button "Nộp bài" để báo lỗi ngay lập tức (chỉ cho Azota)
        if (this.websiteType === 'azota') {
          this.updateSubmitButtonDot(true);
        }
      
      // Kiểm tra xem có thể chuyển sang key khác không
      const error = new Error(`API Error: ${response.status} - ${errorText}`);
      const canRotate = await this.apiKeyManager.handleApiError(error);
      
      if (canRotate) {
        console.log('Retrying with next API key...');
        // Thử lại với key mới
        return await this.sendToGemini(questionData);
      }
      
      throw error;
    }

    try {
      data = await response.json();
      console.log('API Response:', data);
    } catch (jsonError) {
      console.error('Lỗi parse JSON:', jsonError);
      const textResponse = await response.text();
      console.error('Response text:', textResponse);
      throw new Error('API trả về dữ liệu không phải JSON: ' + textResponse);
      }
      
    } catch (error) {
      clearTimeout(timeoutId);
      
      // Cập nhật dấu chấm button "Nộp bài" để báo lỗi (chỉ cho Azota)
      if (this.websiteType === 'azota') {
        this.updateSubmitButtonDot(true);
      }
      
      if (error.name === 'AbortError') {
        throw new Error('Request timeout - API không phản hồi trong 30 giây');
      }
      throw error;
    }
    
    // Kiểm tra cấu trúc response
    if (!data.candidates || data.candidates.length === 0) {
      console.error('Không có candidates trong response:', data);
      if (this.websiteType === 'azota') {
        this.updateSubmitButtonDot(true);
      }
      throw new Error('Không có kết quả từ API');
    }
    
    const candidate = data.candidates[0];
    console.log('Candidate:', candidate);
    
    if (!candidate) {
      console.error('Không có candidate trong response');
      if (this.websiteType === 'azota') {
        this.updateSubmitButtonDot(true);
      }
      throw new Error('Không có candidate trong response');
    }
    
    // Kiểm tra finishReason
    if (candidate.finishReason === 'MAX_TOKENS') {
      console.warn('Response bị cắt ngắn do giới hạn token');
      // Vẫn tiếp tục xử lý nếu có content
    }
    
    if (!candidate.content) {
      console.error('Candidate không có content:', candidate);
      if (this.websiteType === 'azota') {
        this.updateSubmitButtonDot(true);
      }
      throw new Error('Candidate không có content');
    }
    
    // Kiểm tra nếu content có role là 'model' (response bị cắt ngắn)
    if (candidate.content.role === 'model' && !candidate.content.parts) {
      console.warn('Response bị cắt ngắn, thử parse từ finishReason');
      if (candidate.finishReason === 'MAX_TOKENS') {
        throw new Error('Response bị cắt ngắn do giới hạn token. Vui lòng thử lại với câu hỏi ngắn hơn.');
      }
      throw new Error('Response không có nội dung hợp lệ');
    }
    
    if (!candidate.content.parts) {
      console.error('Content không có parts:', candidate.content);
      if (this.websiteType === 'azota') {
        this.updateSubmitButtonDot(true);
      }
      throw new Error('Content không có parts');
    }
    
    if (candidate.content.parts.length === 0) {
      console.error('Parts array rỗng:', candidate.content.parts);
      if (this.websiteType === 'azota') {
        this.updateSubmitButtonDot(true);
      }
      throw new Error('Parts array rỗng');
    }
    
    console.log('Parts:', candidate.content.parts);
    
    const result = candidate.content.parts[0].text;
    
    if (!result) {
      if (this.websiteType === 'azota') {
        this.updateSubmitButtonDot(true);
      }
      throw new Error('Không có nội dung trả về từ API');
    }
    
    console.log('API Result:', result);
    
    // Reset retry count khi API call thành công
    if (this.apiKeyManager) {
      this.apiKeyManager.resetRetryCount();
    }
    
    // Cập nhật dấu chấm button "Nộp bài" để báo thành công (chỉ cho Azota)
    if (this.websiteType === 'azota') {
      this.updateSubmitButtonDot(false);
    }
    
    // Trích xuất đáp án từ kết quả
    console.log('Parsing result:', result);
    
    // Tìm "ĐÁP ÁN: [A-D]" ở cuối response
    const answerMatch = result.match(/ĐÁP ÁN:\s*([A-D])\s*$/i);
    if (answerMatch) {
      console.log('Found answer:', answerMatch[1]);
      return {
        answer: answerMatch[1],
        explanation: 'Đáp án được xác định'
      };
    }
    
    // Fallback: tìm chữ cái cuối cùng trong response
    const lastLetterMatch = result.match(/([A-D])\s*$/);
    if (lastLetterMatch) {
      console.log('Found last letter:', lastLetterMatch[1]);
      return {
        answer: lastLetterMatch[1],
        explanation: 'Đáp án được xác định từ chữ cái cuối'
      };
    }
    
      // Fallback: tìm chữ cái đầu tiên trong kết quả
    const firstLetterMatch = result.match(/([A-D])/);
    if (firstLetterMatch) {
      console.log('Found first letter:', firstLetterMatch[1]);
        return {
        answer: firstLetterMatch[1],
        explanation: 'Đáp án được xác định từ chữ cái đầu'
        };
        }
    
    // Nếu không tìm thấy chữ cái nào
    console.error('Cannot find answer letter in result:', result);
    this.updateSvgIndicator(true);
        throw new Error('Không thể trích xuất đáp án từ response: ' + result);
  }

  markCorrectAnswerWithDotAndColor(correctLetter, answers) {
    if (!correctLetter) return;

    console.log('Marking correct answer:', correctLetter);
    console.log('Available answers:', answers.map(ans => ans.letter));

    // Tìm đáp án đúng và thêm dấu chấm + màu sắc
    const correctAnswer = answers.find(ans => ans.letter === correctLetter);
    if (correctAnswer) {
      console.log('Found correct answer element:', correctAnswer.letter);
      
      // Tìm button đáp án để sửa border-radius thành 25% (hình vuông bo góc dễ nhìn hơn)
      const buttonElement = correctAnswer.element.querySelector('button, [class*="button"], [class*="btn"]');
      if (buttonElement) {
        // Sửa border-radius của button thành 25%
        buttonElement.style.borderRadius = '25%';
        console.log('Modified button border-radius to 25%');
      }
      
      // Không thêm màu sắc để tránh bị phát hiện, chỉ sửa border-radius của button
          } else {
      console.error('Cannot find correct answer element for letter:', correctLetter);
      console.error('Available answers:', answers.map(ans => ans.letter));
    }
  }

  showNotification(message, type = 'info') {
    if (this.minimalMode) {
      // Tắt toàn bộ thông báo khi ở chế độ tối giản (mặc định)
      console.log('Notification blocked (minimal mode):', message);
      return;
    }
    // Xóa thông báo cũ trước khi tạo mới
    const existingNotifications = document.querySelectorAll('.azota-gemini-notification');
    existingNotifications.forEach(notif => {
      if (notif.parentNode) {
        notif.parentNode.removeChild(notif);
      }
    });
    
    // Tạo notification element
    const notification = document.createElement('div');
    notification.className = `azota-gemini-notification azota-gemini-${type}`;
    notification.textContent = message;
    
    // Thêm vào body
    document.body.appendChild(notification);
    
    // Tự động xóa sau 3 giây
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 3000);
  }

  // ==================== EL2 (Elearning 2) Methods ====================
  
  async processEL2Question(targetQuestionContainer = null) {
    // Kiểm tra nếu extension đang bị pause
    if (this.isPaused) {
      this.showNotification('Extension đang tạm dừng. Nhấn Alt+Z để tiếp tục.', 'warning');
      return;
    }

    if (this.isProcessing) {
      console.log('Đang xử lý câu hỏi trước đó, bỏ qua');
      return;
    }

    this.isProcessing = true;
    console.log('Bắt đầu xử lý câu hỏi EL2');
    this.showNotification('Đang phân tích câu hỏi...', 'info');

    try {
      // Tìm container câu hỏi EL2
      const questionContainer = targetQuestionContainer || document.querySelector('.que.multichoice, .que');
      
      if (!questionContainer) {
        this.showNotification('Không tìm thấy câu hỏi trên trang', 'error');
        return;
      }

      const questionId = this.getEL2QuestionId(questionContainer);
      console.log('Question ID:', questionId);
      
      // Reset dấu chấm của tất cả đáp án trước khi xử lý
      this.resetEL2QuestionMarks(questionId);
      this.currentQuestionId = questionId;

      const questionData = this.extractEL2QuestionData(questionContainer);
      if (!questionData || !questionData.question || questionData.answers.length === 0) {
        this.showNotification('Không tìm thấy câu hỏi hoặc đáp án', 'error');
        return;
      }

      // Gửi đến Gemini API
      const result = await this.sendToGemini(questionData);
      
      if (!result || !result.answer) {
        this.showNotification('Không thể phân tích câu hỏi', 'error');
        return;
      }
      
      console.log('API result:', result);
      console.log('Question data answers:', questionData.answers.map(ans => ans.letter));
      
      // Đánh dấu đáp án đúng
      await this.markEL2CorrectAnswer(result.answer, questionData.answers);
      
      this.showNotification(`Đã phân tích xong! Đáp án đúng: ${result.answer}`, 'success');
      
    } catch (error) {
      console.error('Lỗi khi xử lý câu hỏi EL2:', error);
      
      // Xử lý các loại lỗi khác nhau
      if (error.message.includes('API Error: 400')) {
        this.showNotification('API key không hợp lệ hoặc bị hết hạn', 'error');
      } else if (error.message.includes('API Error: 403')) {
        this.showNotification('API bị chặn hoặc không có quyền truy cập', 'error');
      } else if (error.message.includes('API Error: 429')) {
        this.showNotification('API bị giới hạn số lượng request', 'error');
      } else if (error.message.includes('Cấu trúc response không hợp lệ')) {
        this.showNotification('API trả về dữ liệu không đúng định dạng', 'error');
      } else {
        this.showNotification('Lỗi: ' + error.message, 'error');
      }
    } finally {
      this.isProcessing = false;
    }
  }

  getEL2QuestionId(questionContainer) {
    // Tạo ID duy nhất cho câu hỏi dựa trên nội dung
    const questionText = questionContainer.querySelector('.qtext')?.textContent?.trim();
    return questionText ? questionText.substring(0, 50) : Math.random().toString();
  }

  extractEL2QuestionData(questionContainer) {
    console.log('Extracting EL2 question data from container:', questionContainer);
    
    // Tìm câu hỏi
    const questionData = this.extractEL2QuestionContent(questionContainer);
    if (!questionData) {
      console.log('Không tìm thấy nội dung câu hỏi EL2');
      return null;
    }
    
    console.log('Loại câu hỏi EL2:', questionData.type, 'Nội dung:', questionData.content);
    
    // Tìm các đáp án
    const answers = this.extractEL2AnswersContent(questionContainer);
    if (answers.length === 0) {
      console.log('Không tìm thấy đáp án hợp lệ EL2');
      return null;
    }
    
    console.log('Kết quả extract EL2:', { question: questionData, answers: answers.length });
    
    return {
      question: questionData,
      answers: answers
    };
  }

  extractEL2QuestionContent(container) {
    // Tìm phần câu hỏi
    const questionElement = container.querySelector('.qtext');
    
    if (!questionElement) {
      return null;
    }

    // Kiểm tra xem có ảnh không
    const questionImage = questionElement.querySelector('img');
    if (questionImage && questionImage.src) {
      return {
        type: 'image',
        content: questionImage.src
      };
    }

    // Lấy text câu hỏi
    const textContent = questionElement.textContent?.trim();
    if (textContent && textContent.length > 0) {
      return {
        type: 'text',
        content: textContent
      };
    }

    return null;
  }

  extractEL2AnswersContent(container) {
    const answerElements = container.querySelectorAll('.answer .r0, .answer .r1');
    console.log('Tìm thấy', answerElements.length, 'phần tử đáp án EL2');
    
    const answers = [];
    const letterMap = ['a', 'b', 'c', 'd', 'e', 'f']; // Map index to letter
    
    answerElements.forEach((element, index) => {
      // Tìm radio button
      const radioButton = element.querySelector('input[type="radio"]');
      if (!radioButton) return;
      
      // Tìm label
      const labelElement = element.querySelector('[id$="_label"]');
      if (!labelElement) return;
      
      // Lấy chữ cái từ answernumber (a., b., c., d.)
      const answerNumber = labelElement.querySelector('.answernumber');
      let letter = letterMap[index];
      if (answerNumber) {
        const numberText = answerNumber.textContent?.trim();
        const letterMatch = numberText?.match(/([a-d])\./i);
        if (letterMatch) {
          letter = letterMatch[1].toUpperCase();
        }
      }
      
      // Lấy nội dung đáp án
      const answerContent = labelElement.querySelector('.flex-fill, [class*="flex"]');
      let answerText = '';
      
      if (answerContent) {
        answerText = answerContent.textContent?.trim() || '';
      } else {
        // Fallback: lấy tất cả text từ label nhưng loại bỏ answernumber
        const clone = labelElement.cloneNode(true);
        const numberEl = clone.querySelector('.answernumber');
        if (numberEl) numberEl.remove();
        answerText = clone.textContent?.trim() || '';
      }
      
      if (!answerText) {
        console.log('Không tìm thấy nội dung đáp án cho:', letter);
        return;
      }
      
      answers.push({
        letter: letter.toUpperCase(),
        type: 'text',
        content: answerText,
        element: element,
        radioButton: radioButton
      });
      
      console.log('Đáp án EL2', letter, '(text):', answerText);
    });
    
    return answers;
  }

  resetEL2QuestionMarks(questionId) {
    // Reset tất cả đáp án trong container câu hỏi hiện tại
    const questionContainer = document.querySelector('.que.multichoice, .que');
    if (!questionContainer) return;
    
    questionContainer.removeAttribute('data-azota-solved');
    
    const answerElements = questionContainer.querySelectorAll('.answer .r0, .answer .r1');
    answerElements.forEach(element => {
      // Reset border và background
      element.style.border = '';
      element.style.backgroundColor = '';
      element.style.borderRadius = '';
      
      // Xóa class và data attribute
      element.classList.remove('azota-el2-correct-answer');
      element.removeAttribute('data-azota-correct-answer');
      
      // Xóa class khỏi radio button
      const radioButton = element.querySelector('input[type="radio"]');
      if (radioButton) {
        radioButton.classList.remove('azota-el2-hover-indicator');
      }
    });
    
    // Xóa các element khỏi danh sách marked elements
    this.markedEL2Elements = this.markedEL2Elements.filter(element => 
      !answerElements.includes(element)
    );
  }

  async markEL2CorrectAnswer(correctLetter, answers) {
    if (!correctLetter) return;

    console.log('🔵 [MARK] Marking EL2 correct answer:', correctLetter);
    console.log('🔵 [MARK] Available answers:', answers.map(ans => ans.letter));
    console.log('🔵 [MARK] Current minimalMode before check:', this.minimalMode);
    
    // QUAN TRỌNG: Kiểm tra lại minimalMode từ storage để đảm bảo giá trị luôn đúng
    let minimalModeFromStorage = true; // Mặc định là true
    try {
      const result = await new Promise(resolve => chrome.storage.local.get(['minimalMode'], resolve));
      minimalModeFromStorage = result.minimalMode !== undefined ? result.minimalMode : true;
      this.minimalMode = minimalModeFromStorage;
      console.log('🟢 [MARK] MinimalMode from storage:', minimalModeFromStorage, 'Updated this.minimalMode to:', this.minimalMode);
    } catch (e) {
      console.warn('🔴 [MARK] Cannot check minimalMode from storage, using current value:', this.minimalMode);
      minimalModeFromStorage = this.minimalMode;
    }

    // Tìm đáp án đúng
    const correctAnswer = answers.find(ans => ans.letter.toUpperCase() === correctLetter.toUpperCase());
    if (correctAnswer && correctAnswer.element) {
      console.log('🟢 [MARK] Found correct answer element:', correctAnswer.letter);
      
      // Lưu element vào danh sách để có thể update sau
      if (!this.markedEL2Elements.includes(correctAnswer.element)) {
        this.markedEL2Elements.push(correctAnswer.element);
        console.log('🔵 [MARK] Added element to markedEL2Elements, total:', this.markedEL2Elements.length);
        // Thêm vào observer nếu đã được setup
        if (this.styleObserver && correctAnswer.element.parentNode) {
          this.styleObserver.observe(correctAnswer.element, {
            attributes: true,
            attributeFilter: ['style']
          });
          console.log('🔵 [MARK] Added element to styleObserver');
        }
      }
      
      // QUAN TRỌNG: Sử dụng giá trị từ storage, không dùng this.minimalMode
      const currentMinimalMode = minimalModeFromStorage === true;
      
      console.log('🔵 [MARK] Setting border/background. minimalMode from storage:', minimalModeFromStorage, 'currentMinimalMode:', currentMinimalMode);
      console.log('🔵 [MARK] this.minimalMode:', this.minimalMode, 'type:', typeof this.minimalMode);
      
      // Nếu minimalMode = true, KHÔNG BAO GIỜ set border/background
      if (currentMinimalMode) {
        console.log('🟢 [MARK] MinimalMode is TRUE - NOT setting border/background');
        // Đảm bảo xóa hoàn toàn border và background NGAY LẬP TỨC
        this.removeEL2MarkingStyles(correctAnswer.element);
        console.log('🔵 [MARK] Removed styles, checking again in 50ms, 100ms, 200ms');
        // Kiểm tra lại nhiều lần để đảm bảo style không bị set lại
        [50, 100, 200, 500].forEach(delay => {
          setTimeout(() => {
            if (this.minimalMode === true) {
              console.log(`🔵 [MARK] Re-checking and removing styles after ${delay}ms`);
              this.removeEL2MarkingStyles(correctAnswer.element);
            }
          }, delay);
        });
      } else {
        console.log('🟡 [MARK] MinimalMode is FALSE - Setting border/background');
        // Chỉ set border/background khi minimalMode = false
        correctAnswer.element.style.border = '2px solid #4CAF50';
        correctAnswer.element.style.borderRadius = '8px';
        correctAnswer.element.style.backgroundColor = 'rgba(76, 175, 80, 0.1)';
        console.log('🟡 [MARK] Styles set:', correctAnswer.element.getAttribute('style'));
      }
      
      // Đánh dấu đáp án đúng bằng data attribute để có thể style khi hover
      // KHÔNG tự động chọn radio button nữa
      if (correctAnswer.element) {
        correctAnswer.element.setAttribute('data-azota-correct-answer', 'true');
        console.log('🔵 [MARK] Marked element as correct answer (hover to see radio indicator)');
        
        // Thêm event listener cho hover
        this.setupEL2HoverEffect(correctAnswer.element, correctAnswer.radioButton);
        
        // Đánh dấu container câu hỏi là đã giải
        const questionContainer = correctAnswer.element.closest('.que.multichoice, .que');
        if (questionContainer) {
          questionContainer.setAttribute('data-azota-solved', 'true');
          console.log('🔵 [MARK] Marked EL2 question container as solved');
        }
      }
    } else {
      console.error('🔴 [MARK] Cannot find correct answer element for letter:', correctLetter);
      console.error('🔴 [MARK] Available answers:', answers.map(ans => ans.letter));
    }
  }

  setupEL2HoverEffect(element, radioButton) {
    if (!element || !radioButton) return;
    
    // Thêm class để có thể style bằng CSS
    element.classList.add('azota-el2-correct-answer');
    
    // Thêm event listener cho hover
    element.addEventListener('mouseenter', () => {
      if (radioButton) {
        // Thêm class để hiển thị ruột lõi màu xám
        radioButton.classList.add('azota-el2-hover-indicator');
        console.log('🔵 [HOVER] Mouse enter - showing radio indicator');
      }
    });
    
    element.addEventListener('mouseleave', () => {
      if (radioButton) {
        // Xóa class khi rời chuột
        radioButton.classList.remove('azota-el2-hover-indicator');
        console.log('🔵 [HOVER] Mouse leave - hiding radio indicator');
      }
    });
    
    console.log('🔵 [HOVER] Hover effect setup for correct answer');
  }

  removeEL2MarkingStyles(element) {
    // Xóa tất cả style liên quan đến marking
    if (!element) return;
    
    console.log('removeEL2MarkingStyles called for element:', element);
    
    // Xóa style trực tiếp từ style object
    if (element.style) {
      element.style.removeProperty('border');
      element.style.removeProperty('border-width');
      element.style.removeProperty('border-style');
      element.style.removeProperty('border-color');
      element.style.removeProperty('border-radius');
      element.style.removeProperty('background-color');
      element.style.removeProperty('background');
    }
    
    // Xóa các thuộc tính border và background từ inline style attribute
    if (element.hasAttribute('style')) {
      const currentStyle = element.getAttribute('style');
      if (currentStyle) {
        console.log('Current style before removal:', currentStyle);
        // Xóa các thuộc tính border, borderRadius, backgroundColor một cách chính xác
        let newStyle = currentStyle
          // Xóa border với các biến thể
          .replace(/border\s*:\s*[^;]+;?/gi, '')
          .replace(/border-width\s*:\s*[^;]+;?/gi, '')
          .replace(/border-style\s*:\s*[^;]+;?/gi, '')
          .replace(/border-color\s*:\s*[^;]+;?/gi, '')
          // Xóa border-radius
          .replace(/border-radius\s*:\s*[^;]+;?/gi, '')
          // Xóa background-color và background
          .replace(/background-color\s*:\s*[^;]+;?/gi, '')
          .replace(/background\s*:\s*[^;]+;?/gi, '')
          // Xóa các khoảng trắng thừa và dấu chấm phẩy
          .replace(/\s*;\s*/g, ';')
          .replace(/;;+/g, ';')
          .replace(/^[\s;]+|[\s;]+$/g, '')
          .trim();
        
        console.log('New style after removal:', newStyle);
        
        if (newStyle && newStyle.length > 0) {
          element.setAttribute('style', newStyle);
        } else {
          element.removeAttribute('style');
        }
      }
    }
    
    // Đảm bảo xóa hoàn toàn bằng cách set lại về rỗng
    if (element.style) {
      element.style.border = '';
      element.style.borderRadius = '';
      element.style.backgroundColor = '';
      element.style.background = '';
    }
    
    console.log('Style after removal:', element.getAttribute('style') || 'none');
  }

  async updateEL2MarkedElements() {
    // QUAN TRỌNG: Kiểm tra lại minimalMode từ storage
    try {
      const result = await new Promise(resolve => chrome.storage.local.get(['minimalMode'], resolve));
      const minimalModeFromStorage = result.minimalMode ?? true;
      this.minimalMode = minimalModeFromStorage;
      console.log('updateEL2MarkedElements - MinimalMode from storage:', minimalModeFromStorage);
    } catch (e) {
      console.warn('Cannot check minimalMode from storage, using current value:', this.minimalMode);
    }
    
    const currentMinimalMode = this.minimalMode === true;
    console.log('updateEL2MarkedElements called. minimalMode:', currentMinimalMode, 'markedElements count:', this.markedEL2Elements.length);
    
    // Cập nhật lại border/background của tất cả marked elements dựa trên minimalMode
    this.markedEL2Elements.forEach((element, index) => {
      if (element && element.parentNode) { // Kiểm tra element còn tồn tại
        if (currentMinimalMode) {
          // Ẩn border/background - Đảm bảo xóa hoàn toàn
          console.log(`Removing border/background from element ${index}`);
          this.removeEL2MarkingStyles(element);
        } else {
          // Hiển thị border/background
          console.log(`Setting border/background for element ${index}`);
          element.style.border = '2px solid #4CAF50';
          element.style.borderRadius = '8px';
          element.style.backgroundColor = 'rgba(76, 175, 80, 0.1)';
        }
      }
    });
    
    // Loại bỏ các element không còn tồn tại trong DOM
    this.markedEL2Elements = this.markedEL2Elements.filter(element => 
      element && element.parentNode
    );
    
    // Cập nhật observer cho các element mới
    if (this.styleObserver) {
      this.observeMarkedElements();
    }
  }
}

// Khởi tạo extension khi trang load xong
// Flag để tránh init nhiều lần
let extensionInitialized = false;

function initExtension() {
  // Tránh init nhiều lần
  if (extensionInitialized) {
    console.log('🔵 [GLOBAL] Extension already initialized, skipping...');
    return;
  }
  
  try {
    console.log('🔵 [GLOBAL] Initializing AzotaGeminiHelper...');
    console.log('🔵 [GLOBAL] Document ready state:', document.readyState);
    console.log('🔵 [GLOBAL] URL:', window.location.href);
    console.log('🔵 [GLOBAL] Body exists:', !!document.body);
    console.log('🔵 [GLOBAL] Body children:', document.body?.children.length || 0);
    
    window.azotaHelperInstance = new AzotaGeminiHelper();
    extensionInitialized = true;
    console.log('🟢 [GLOBAL] AzotaGeminiHelper instance created');
  } catch (error) {
    console.error('🔴 [GLOBAL] Lỗi khởi tạo extension:', error);
    console.error('🔴 [GLOBAL] Error stack:', error.stack);
    extensionInitialized = false; // Reset để có thể thử lại
  }
}

// Với file local hoặc localhost, cần đợi lâu hơn để DOM load xong
const url = window.location.href;
const isLocalFile = url.startsWith('file://');
const isLocalhost = url.includes('127.0.0.1') || url.includes('localhost');

if (isLocalFile || isLocalhost) {
  const urlType = isLocalFile ? 'File local' : 'Localhost';
  console.log(`🔵 [GLOBAL] ${urlType} detected, using special initialization...`);
  
  // Đợi DOM load xong
  if (document.readyState === 'loading') {
    console.log('🔵 [GLOBAL] Waiting for DOMContentLoaded...');
    document.addEventListener('DOMContentLoaded', () => {
      console.log('🔵 [GLOBAL] DOMContentLoaded fired');
      // Đợi thêm để đảm bảo các element đã render
      setTimeout(initExtension, 500);
    });
  } else {
    console.log('🔵 [GLOBAL] DOM already loaded, initializing after delay...');
    // Đợi thêm để đảm bảo các element đã render
    setTimeout(initExtension, 500);
  }
  
  // Backup: thử lại sau 2 giây nếu vẫn chưa init
  setTimeout(() => {
    if (!window.azotaHelperInstance) {
      console.log('🔵 [GLOBAL] Backup initialization after 2 seconds...');
      initExtension();
    }
  }, 2000);
} else {
  // Với web thông thường
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initExtension);
  } else {
    // Nếu DOM đã load xong, chờ một chút để đảm bảo các element đã render
    setTimeout(initExtension, 100);
  }
}
