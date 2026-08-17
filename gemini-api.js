// Gemini API helper functions
class GeminiAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent';
  }

  async generateContent(prompt) {
    try {
      const response = await fetch(`${this.baseUrl}?key=${this.apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: prompt
            }]
          }],
          generationConfig: {
            temperature: 0.1,
            topK: 1,
            topP: 0.8,
            maxOutputTokens: 1024,
          }
        })
      });

      if (!response.ok) {
        throw new Error(`API Error: ${response.status} - ${response.statusText}`);
      }

      const data = await response.json();
      
      if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
        throw new Error('Invalid response from Gemini API');
      }

      return data.candidates[0].content.parts[0].text;
    } catch (error) {
      console.error('Gemini API Error:', error);
      throw error;
    }
  }

  async analyzeQuestion(question, answers) {
    const prompt = `Bạn là một trợ lý AI chuyên phân tích câu hỏi trắc nghiệm. Hãy phân tích câu hỏi sau và chọn đáp án đúng nhất:

Câu hỏi: ${question}

Các đáp án:
${answers.map((ans, index) => `${ans.letter}. ${ans.content}`).join('\n')}

Yêu cầu:
1. Phân tích câu hỏi một cách cẩn thận
2. Xem xét từng đáp án
3. Chọn đáp án đúng nhất
4. Trả lời theo format: "ĐÁP ÁN: [A/B/C/D]"

Chỉ trả lời theo đúng format trên, không thêm gì khác.`;

    try {
      const result = await this.generateContent(prompt);
      
      // Trích xuất đáp án từ kết quả
      const match = result.match(/ĐÁP ÁN:\s*([A-D])\s*-\s*(.+)/);
      if (match) {
        return {
          answer: match[1],
          explanation: match[2].trim()
        };
      } else {
        // Fallback: tìm chữ cái đầu tiên trong kết quả
        const letterMatch = result.match(/([A-D])/);
        return {
          answer: letterMatch ? letterMatch[1] : null,
          explanation: result
        };
      }
    } catch (error) {
      throw new Error(`Lỗi khi phân tích câu hỏi: ${error.message}`);
    }
  }
}

// Export cho sử dụng trong content script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GeminiAPI;
} else {
  window.GeminiAPI = GeminiAPI;
}
