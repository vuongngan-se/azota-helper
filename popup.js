// Popup script cho À Zố Tà
document.addEventListener('DOMContentLoaded', function () {
  try {
    console.log('Popup script loaded');

    const testBtn = document.getElementById('testBtn');
    const status = document.getElementById('status');
    const minimalToggle = document.getElementById('minimalMode');
    const azotaToggle = document.getElementById('azotaMode');
    const el2Toggle = document.getElementById('el2Mode');

    console.log('Test button found:', testBtn);
    console.log('Status element found:', status);

    // Kiểm tra element tồn tại trước khi add event listener
    if (testBtn) {
      testBtn.addEventListener('click', testApiKey);
      console.log('Test button event listener added');
    } else {
      console.error('Test button not found');
    }

    // Không test tự động, chỉ khi nhấn nút
    if (status) {
      status.textContent = 'Sẵn sàng test API...';
      status.className = 'status';
      console.log('Status set to:', status.textContent);
    } else {
      console.error('Status element not found!');
    }

    // Load minimal mode from storage
    if (minimalToggle) {
      chrome.storage.local.get(['minimalMode'], (result) => {
        // Mặc định tắt thông báo (minimalMode = true)
        const isMinimal = result.minimalMode ?? true;
        minimalToggle.checked = isMinimal;

        // Nếu chưa lưu bao giờ, lưu luôn mặc định tắt thông báo
        if (result.minimalMode === undefined) {
          chrome.storage.local.set({ minimalMode: true });
        }
      });

      minimalToggle.addEventListener('change', async () => {
        const isMinimal = minimalToggle.checked;
        chrome.storage.local.set({ minimalMode: isMinimal });
        // Notify active tabs
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url && (tab.url.includes('azota.vn') || tab.url.includes('elearning2.vku.udn.vn') || tab.url.startsWith('file://') || tab.url.includes('127.0.0.1') || tab.url.includes('localhost'))) {
          try {
            await chrome.tabs.sendMessage(tab.id, { action: 'minimalModeChanged', minimalMode: isMinimal });
          } catch (e) {
            console.log('Could not send minimal mode message to tab:', e);
          }
        }
      });
    }

    // Load and handle Azota toggle
    if (azotaToggle) {
      chrome.storage.local.get(['azotaMode'], (result) => {
        // Mặc định bật Azota
        const isAzota = result.azotaMode ?? true;
        azotaToggle.checked = isAzota;

        if (result.azotaMode === undefined) {
          chrome.storage.local.set({ azotaMode: true, el2Mode: false });
        }
      });

      azotaToggle.addEventListener('change', async () => {
        const isAzota = azotaToggle.checked;
        if (isAzota) {
          // Nếu bật Azota, tắt EL2
          el2Toggle.checked = false;
          chrome.storage.local.set({ azotaMode: true, el2Mode: false });
        } else {
          // Nếu tắt Azota, bật EL2
          el2Toggle.checked = true;
          chrome.storage.local.set({ azotaMode: false, el2Mode: true });
        }
        // Notify active tabs
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url) {
          try {
            await chrome.tabs.sendMessage(tab.id, {
              action: 'modeChanged',
              azotaMode: azotaToggle.checked,
              el2Mode: el2Toggle.checked
            });
          } catch (e) {
            console.log('Could not send mode change message to tab:', e);
          }
        }
      });
    }

    // Load and handle EL2 toggle
    if (el2Toggle) {
      chrome.storage.local.get(['el2Mode'], (result) => {
        // Mặc định tắt EL2
        const isEl2 = result.el2Mode ?? false;
        el2Toggle.checked = isEl2;
      });

      el2Toggle.addEventListener('change', async () => {
        const isEl2 = el2Toggle.checked;
        if (isEl2) {
          // Nếu bật EL2, tắt Azota
          azotaToggle.checked = false;
          chrome.storage.local.set({ azotaMode: false, el2Mode: true });
        } else {
          // Nếu tắt EL2, bật Azota
          azotaToggle.checked = true;
          chrome.storage.local.set({ azotaMode: true, el2Mode: false });
        }
        // Notify active tabs
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url) {
          try {
            await chrome.tabs.sendMessage(tab.id, {
              action: 'modeChanged',
              azotaMode: azotaToggle.checked,
              el2Mode: el2Toggle.checked
            });
          } catch (e) {
            console.log('Could not send mode change message to tab:', e);
          }
        }
      });
    }

    // Load API key information
    loadApiKeyInfo();

  } catch (error) {
    console.error('Error in popup initialization:', error);
  }

  async function testApiKey() {
    console.log('Test API key function called');

    showStatus('Đang test API key...', 'info');

    try {
      // Lấy thông tin API key từ content script
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && (tab.url.includes('azota.vn') || tab.url.includes('elearning2.vku.udn.vn') || tab.url.startsWith('file://'))) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { action: 'getApiKeyInfo' });
          if (response && response.keyInfo) {
            console.log('API Key Info:', response.keyInfo);
            showStatus(`Đang test key ${response.keyInfo.currentIndex + 1}/${response.keyInfo.totalKeys}...`, 'info');
          }
        } catch (e) {
          console.log('Could not get API key info from tab:', e);
        }
      }

      // Test với key đầu tiên từ file
      const response = await fetch(chrome.runtime.getURL('api-keys.txt'));
      const text = await response.text();
      const apiKeys = text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && !line.startsWith('//'))
        .filter(line => line.startsWith('AIzaSy'));

      if (apiKeys.length === 0) {
        showStatus('Không tìm thấy API key nào trong file api-keys.txt', 'error');
        // Cập nhật display để hiển thị lỗi
        updateApiKeyDisplay(null);
        return;
      }

      // Lấy key đang hoạt động hiện tại để test
      const storageResult = await new Promise(resolve =>
        chrome.storage.local.get(['currentKeyIndex'], resolve)
      );
      const currentIndex = storageResult.currentKeyIndex || 0;
      const testKey = apiKeys[currentIndex] || apiKeys[0];
      console.log('Sending request to Gemini API for key index:', currentIndex);
      const apiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${testKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: 'Test connection. Please respond with "OK" if you can read this.'
            }]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 10,
          }
        })
      });

      console.log('Response status:', apiResponse.status);

      if (apiResponse.ok) {
        const data = await apiResponse.json();
        console.log('API response:', data);
        showStatus(`API hoạt động bình thường! (${apiKeys.length} keys available)`, 'success');
        // Refresh API key info sau khi test thành công
        loadApiKeyInfo();
      } else {
        const errorData = await apiResponse.json();
        console.error('API error:', errorData);
        showStatus(`API lỗi: ${errorData.error?.message || 'Unknown error'}`, 'error');
        // Refresh API key info sau khi test lỗi
        loadApiKeyInfo();
      }
    } catch (error) {
      console.error('Lỗi khi test API key:', error);
      showStatus('Lỗi kết nối: ' + error.message, 'error');
    }
  }

  function showStatus(message, type) {
    console.log('showStatus called:', message, type);
    const statusEl = document.getElementById('status');
    console.log('Status element in showStatus:', statusEl);

    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = `status ${type}`;

      console.log('Status element updated:', statusEl.textContent, statusEl.className);

      // Auto hide after 5 seconds for success messages
      if (type === 'success') {
        setTimeout(() => {
          if (statusEl) {
            statusEl.textContent = '';
            statusEl.className = 'status';
          }
        }, 5000);
      }
    } else {
      console.error('Status element not found in showStatus');
    }
  }

  async function loadApiKeyInfo() {
    try {
      // Lấy thông tin từ content script nếu có
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let keyInfo = null;

      if (tab && tab.url && (tab.url.includes('azota.vn') || tab.url.includes('elearning2.vku.udn.vn') || tab.url.startsWith('file://'))) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { action: 'getApiKeyInfo' });
          if (response && response.keyInfo) {
            keyInfo = response.keyInfo;
          }
        } catch (e) {
          console.log('Could not get API key info from tab:', e);
        }
      }

      // Nếu không lấy được từ content script, đọc từ file
      if (!keyInfo) {
        try {
          const response = await fetch(chrome.runtime.getURL('api-keys.txt'));
          const text = await response.text();
          const apiKeys = text
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#') && !line.startsWith('//'))
            .filter(line => line.startsWith('AIzaSy'));

          // Lấy current key index từ storage
          const result = await new Promise(resolve =>
            chrome.storage.local.get(['currentKeyIndex'], resolve)
          );
          const currentIndex = result.currentKeyIndex || 0;

          if (apiKeys.length > 0) {
            const currentKey = apiKeys[currentIndex] || 'Unknown';
            keyInfo = {
              totalKeys: apiKeys.length,
              currentIndex: currentIndex,
              currentKey: formatApiKey(currentKey),
              retryCount: 0
            };
          }
        } catch (error) {
          console.error('Error loading API keys from file:', error);
        }
      }

      // Cập nhật UI
      updateApiKeyDisplay(keyInfo);

    } catch (error) {
      console.error('Error loading API key info:', error);
      updateApiKeyDisplay(null);
    }
  }

  function formatApiKey(key) {
    if (!key || key.length < 20) {
      return key || 'Unknown';
    }
    // Hiển thị 8 ký tự đầu + ... + 8 ký tự cuối
    const start = key.substring(0, 8);
    const end = key.substring(key.length - 8);
    return `${start}...${end}`;
  }

  function updateApiKeyDisplay(keyInfo) {
    const statusEl = document.getElementById('apiKeyStatus');
    const indexEl = document.getElementById('keyIndex');
    const previewEl = document.getElementById('keyPreview');
    const totalEl = document.getElementById('totalKeys');

    if (!keyInfo) {
      if (statusEl) statusEl.textContent = 'Lỗi';
      if (statusEl) statusEl.className = 'api-key-status error';
      if (indexEl) indexEl.textContent = '-';
      if (previewEl) previewEl.textContent = 'Không tìm thấy';
      if (totalEl) totalEl.textContent = '0 keys';
      return;
    }

    // Cập nhật status
    if (statusEl) {
      if (keyInfo.retryCount > 0) {
        statusEl.textContent = 'Cảnh báo';
        statusEl.className = 'api-key-status warning';
      } else {
        statusEl.textContent = 'Hoạt động';
        statusEl.className = 'api-key-status';
      }
    }

    // Cập nhật thông tin key
    if (indexEl) indexEl.textContent = keyInfo.currentIndex + 1;
    if (previewEl) previewEl.textContent = keyInfo.currentKey;
    if (totalEl) totalEl.textContent = `${keyInfo.totalKeys} keys`;
  }
});
