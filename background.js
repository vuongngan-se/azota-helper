// Background script cho À Zố Tà
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Extension được cài đặt lần đầu
    console.log('À Zố Tà đã được cài đặt');
    
    // Set mặc định tắt thông báo (minimalMode = true) và bật Azota mode
    chrome.storage.local.set({ 
      minimalMode: true,
      azotaMode: true,
      el2Mode: false
    }, () => {
      console.log('Default settings set: minimalMode=true, azotaMode=true, el2Mode=false');
    });
  }
});

// Inject content script vào file:// URLs programmatically
// Sử dụng Set để track các tab đã inject để tránh inject nhiều lần
const injectedTabs = new Set();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Chỉ inject khi tab đã load xong và là file:// URL
  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('file://')) {
    // Kiểm tra xem đã inject chưa
    if (injectedTabs.has(tabId)) {
      console.log('🔵 [BACKGROUND] Content script already injected for tab:', tabId);
      return;
    }
    
    console.log('🔵 [BACKGROUND] File:// URL detected, injecting content script...');
    console.log('🔵 [BACKGROUND] Tab URL:', tab.url);
    
    // Đánh dấu đã inject
    injectedTabs.add(tabId);
    
    // Đợi một chút để đảm bảo DOM đã sẵn sàng
    setTimeout(() => {
      // Inject content script
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content.js']
      }).then(() => {
        console.log('🟢 [BACKGROUND] Content script injected into file:// URL');
      }).catch((error) => {
        console.error('🔴 [BACKGROUND] Error injecting content script:', error);
        // Xóa khỏi Set nếu inject thất bại để có thể thử lại
        injectedTabs.delete(tabId);
      });
      
      // Inject CSS
      chrome.scripting.insertCSS({
        target: { tabId: tabId },
        files: ['styles.css']
      }).catch((error) => {
        console.error('🔴 [BACKGROUND] Error injecting CSS:', error);
      });
    }, 500);
  }
});

// Xóa tab khỏi Set khi tab bị đóng
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
});

// Lắng nghe messages từ content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getApiKey') {
    chrome.storage.sync.get(['geminiApiKey'], (result) => {
      sendResponse({ apiKey: result.geminiApiKey });
    });
    return true; // Giữ message channel mở cho async response
  }
  
  if (request.action === 'togglePause') {
    // Lưu trạng thái pause vào storage
    chrome.storage.local.set({ isPaused: request.isPaused }, () => {
      // Gửi message đến tất cả content scripts (Azota, EL2, và file://)
      // Lưu ý: chrome.tabs.query không hỗ trợ file:// URLs, nên ta query tất cả tabs
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          // Chỉ gửi đến tabs có URL phù hợp
          if (tab.url && (
            tab.url.includes('azota.vn') || 
            tab.url.includes('elearning2.vku.udn.vn') ||
            tab.url.startsWith('file://') ||
            tab.url.includes('127.0.0.1') ||
            tab.url.includes('localhost')
          )) {
            chrome.tabs.sendMessage(tab.id, {
              action: 'pauseStateChanged',
              isPaused: request.isPaused
            }).catch(() => {
              // Ignore errors if tab doesn't have content script
            });
          }
        });
      });
    });
    sendResponse({ success: true });
    return true;
  }
  
  if (request.action === 'getPauseState') {
    chrome.storage.local.get(['isPaused'], (result) => {
      sendResponse({ isPaused: result.isPaused || false });
    });
    return true;
  }
});

// Lắng nghe command từ keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  console.log('Command received:', command);
  
  if (command === 'pause-extension') {
    console.log('Pausing extension');
    // Lưu trạng thái pause vào storage
    chrome.storage.local.set({ isPaused: true });
    
    // Gửi message đến tất cả content scripts (Azota, EL2, file://, và localhost)
    chrome.tabs.query({}, (tabs) => {
      console.log('Found tabs:', tabs.length);
      tabs.forEach(tab => {
        // Chỉ gửi đến tabs có URL phù hợp
        if (tab.url && (
          tab.url.includes('azota.vn') || 
          tab.url.includes('elearning2.vku.udn.vn') ||
          tab.url.startsWith('file://') ||
          tab.url.includes('127.0.0.1') ||
          tab.url.includes('localhost')
        )) {
          chrome.tabs.sendMessage(tab.id, {
            action: 'pauseStateChanged',
            isPaused: true
          }).then(() => {
            console.log('Pause message sent to tab:', tab.id);
          }).catch((error) => {
            console.log('Error sending pause message to tab:', tab.id, error);
          });
        }
      });
    });
  }
  
  if (command === 'resume-extension') {
    console.log('Resuming extension');
    // Lưu trạng thái resume vào storage
    chrome.storage.local.set({ isPaused: false });
    
    // Gửi message đến tất cả content scripts (Azota, EL2, file://, và localhost)
    chrome.tabs.query({}, (tabs) => {
      console.log('Found tabs:', tabs.length);
      tabs.forEach(tab => {
        // Chỉ gửi đến tabs có URL phù hợp
        if (tab.url && (
          tab.url.includes('azota.vn') || 
          tab.url.includes('elearning2.vku.udn.vn') ||
          tab.url.startsWith('file://') ||
          tab.url.includes('127.0.0.1') ||
          tab.url.includes('localhost')
        )) {
          chrome.tabs.sendMessage(tab.id, {
            action: 'pauseStateChanged',
            isPaused: false
          }).then(() => {
            console.log('Resume message sent to tab:', tab.id);
          }).catch((error) => {
            console.log('Error sending resume message to tab:', tab.id, error);
          });
        }
      });
    });
  }
});

// Xoá overlay khi nhấn phím tắt
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "remove-overlay") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        document.querySelectorAll('.cdk-overlay-backdrop, .cdk-overlay-pane').forEach(el => el.remove());
      }
    });
  }
});
