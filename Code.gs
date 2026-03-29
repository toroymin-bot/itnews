// ============================================================
// Daily AI & Data News - Google Apps Script
// 매일 아침 Top 3 AI/Data 뉴스를 한국어+영어로 이메일 발송
// ============================================================

const GEMINI_API_KEY = 'AIzaSyANYllMyXwEdxVs6ErPQiRrQbGVz46ISic';
const RECIPIENT_EMAIL = 'toroymin@gmail.com';

const SEARCH_QUERIES = [
  'AI artificial intelligence',
  'Azure data architecture Microsoft Fabric',
  'data engineering data architecture',
];

// 모델 우선순위 (최신순) - 없으면 자동으로 다음 모델 시도
const MODEL_PRIORITY = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
];

// ============================================================
// 사용 가능한 Gemini 모델 동적 조회
// ============================================================
function getAvailableModel() {
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + GEMINI_API_KEY;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const models = JSON.parse(res.getContentText()).models || [];

    // generateContent 지원 모델만 필터
    const available = models
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace('models/', ''));

    Logger.log('사용 가능한 모델: ' + available.join(', '));

    // 우선순위 기준으로 가장 좋은 모델 선택
    for (const preferred of MODEL_PRIORITY) {
      const match = available.find(a => a.includes(preferred));
      if (match) {
        Logger.log('선택된 모델: ' + match);
        return match;
      }
    }

    // 우선순위에 없으면 첫 번째 사용 가능한 모델
    if (available.length > 0) {
      Logger.log('fallback 모델: ' + available[0]);
      return available[0];
    }
  } catch (e) {
    Logger.log('모델 목록 조회 실패: ' + e.message);
  }
  return null;
}

// ============================================================
// 메인 함수 - 트리거에 연결
// ============================================================
function sendDailyNewsDigest() {
  try {
    Logger.log('=== Daily AI & Data News 시작 ===');

    const allArticles = fetchNewsFromRSS();
    Logger.log('수집된 기사 수: ' + allArticles.length);

    if (allArticles.length === 0) {
      Logger.log('수집된 기사가 없습니다. 이메일을 건너뜁니다.');
      return;
    }

    const top3 = selectTop3(allArticles);
    Logger.log('Top 3: ' + top3.map(a => a.title).join(' | '));

    const enriched = generateDigestWithGemini(top3);
    const htmlBody = buildEmailHTML(enriched);

    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    GmailApp.sendEmail(RECIPIENT_EMAIL, '[Daily AI & Data News] Top 3 뉴스 - ' + today, '', {
      htmlBody: htmlBody,
      name: 'AI & Data News Bot',
      charset: 'UTF-8'
    });

    Logger.log('이메일 발송 완료!');
  } catch (error) {
    Logger.log('오류 발생: ' + error.message);
    GmailApp.sendEmail(RECIPIENT_EMAIL, '[Daily AI News] 오류 발생', '오류: ' + error.message);
  }
}

// ============================================================
// 뉴스 수집 - Google News RSS
// ============================================================
function fetchNewsFromRSS() {
  const articles = [];

  for (const query of SEARCH_QUERIES) {
    try {
      const encodedQuery = encodeURIComponent(query + ' when:1d');
      const rssUrl = 'https://news.google.com/rss/search?q=' + encodedQuery + '&hl=en&gl=US&ceid=US:en';
      const response = UrlFetchApp.fetch(rssUrl, { muteHttpExceptions: true });

      if (response.getResponseCode() !== 200) continue;

      const xml = XmlService.parse(response.getContentText());
      const items = xml.getRootElement().getChild('channel').getChildren('item');

      for (const item of items) {
        const title = item.getChildText('title') || '';
        const link = item.getChildText('link') || '';
        const pubDate = item.getChildText('pubDate') || '';
        const source = item.getChildText('source') || '';

        if (articles.some(a => a.title === title)) continue;
        articles.push({ title, link, pubDate, source, query });
      }
    } catch (e) {
      Logger.log('RSS 오류 (' + query + '): ' + e.message);
    }
  }

  return articles;
}

// ============================================================
// Top 3 선별
// ============================================================
function selectTop3(articles) {
  articles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  const selected = [];
  const usedQueries = new Set();

  for (const article of articles) {
    if (selected.length >= 3) break;
    if (!usedQueries.has(article.query)) {
      selected.push(article);
      usedQueries.add(article.query);
    }
  }

  for (const article of articles) {
    if (selected.length >= 3) break;
    if (!selected.some(s => s.title === article.title)) selected.push(article);
  }

  return selected;
}

// ============================================================
// Gemini API 요약 - 동적 모델 선택
// ============================================================
function generateDigestWithGemini(articles) {
  const model = getAvailableModel();

  if (!model) {
    Logger.log('사용 가능한 Gemini 모델 없음. 요약 없이 발송.');
    return articles.map(a => ({
      ...a,
      summaryKo: a.title, summaryEn: a.title,
      exampleKo: '(요약 생성 실패)', exampleEn: '(Summary generation failed)',
      titleKo: a.title, titleEn: a.title,
      category: a.query.includes('AI') ? 'AI' : a.query.includes('Azure') ? 'Data Architecture' : 'Data Engineering'
    }));
  }

  const newsList = articles.map((a, i) =>
    (i + 1) + '. "' + a.title + '" (Source: ' + a.source + ', Link: ' + a.link + ')'
  ).join('\n');

  const prompt = `You are a tech news curator. Below are 3 news articles about AI, Data, and Data Architecture.

For each article, provide the following in valid JSON format:

[
  {
    "titleKo": "한국어 제목",
    "titleEn": "English title",
    "summaryKo": "2-3문장 한국어 요약",
    "summaryEn": "2-3 sentence English summary",
    "exampleKo": "초등학생도 이해할 수 있는 쉬운 비유 예시 (한국어, 2-3문장)",
    "exampleEn": "Easy real-world analogy example anyone can understand (English, 2-3 sentences)",
    "category": "AI / Data Architecture / Data Engineering 중 하나"
  }
]

News articles:
${newsList}

IMPORTANT: Return ONLY the JSON array. No markdown, no code blocks, no extra text.`;

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + GEMINI_API_KEY;
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
      }),
      muteHttpExceptions: true
    });

    const json = JSON.parse(response.getContentText());
    if (json.error) throw new Error(json.error.message);

    const text = json.candidates[0].content.parts[0].text;
    const enriched = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
    Logger.log('Gemini 요약 성공 (모델: ' + model + ')');
    return articles.map((a, i) => ({ ...a, ...(enriched[i] || {}) }));
  } catch (e) {
    Logger.log('Gemini 오류 (' + model + '): ' + e.message);
    return articles.map(a => ({
      ...a,
      summaryKo: a.title, summaryEn: a.title,
      exampleKo: '(요약 생성 실패)', exampleEn: '(Summary generation failed)',
      titleKo: a.title, titleEn: a.title,
      category: a.query.includes('AI') ? 'AI' : a.query.includes('Azure') ? 'Data Architecture' : 'Data Engineering'
    }));
  }
}

// ============================================================
// HTML 이메일
// Note: 이모지는 HTML 엔티티 사용 (GAS 4-byte UTF-8 인코딩 문제 방지)
//   &#x1F5DE;&#xFE0F; = 🗞️  &#x1F1F0;&#x1F1F7; = 🇰🇷
//   &#x1F1FA;&#x1F1F8; = 🇺🇸  &#x1F4A1; = 💡  &#x1F517; = 🔗
// ============================================================
function buildEmailHTML(articles) {
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy년 MM월 dd일');
  const todayEn = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMMM dd, yyyy');

  const colors = [
    { bg: '#E8F4FD', text: '#0078D4', label: '#0078D4' },
    { bg: '#E8F5E9', text: '#2E7D32', label: '#2E7D32' },
    { bg: '#FCE4EC', text: '#C62828', label: '#C62828' }
  ];

  let newsHtml = '';
  articles.forEach((article, i) => {
    const color = colors[i % 3];
    const num = i + 1;
    const isLast = i === articles.length - 1;
    const br = isLast ? 'border-radius: 0 0 12px 12px;' : '';
    const category = article.category || (article.query.includes('AI') ? 'AI' : article.query.includes('Azure') ? 'Data Architecture' : 'Data Engineering');

    newsHtml += `
    <div style="border: 1px solid #e0e0e0; border-top: none; padding: 24px 7px; ${br}">
      <div style="background: ${color.bg}; padding: 4px 12px; border-radius: 20px; display: inline-block; margin-bottom: 12px;">
        <span style="color: ${color.label}; font-weight: bold; font-size: 13px;">#${num} ${category}</span>
      </div>
      <h2 style="color: ${color.text}; margin: 8px 0; font-size: 18px;">${article.titleKo || article.title}</h2>
      <h3 style="color: #555; font-weight: normal; font-size: 15px; margin-top: 4px;">${article.titleEn || article.title}</h3>
      <p style="line-height: 1.7;"><strong>&#x1F1F0;&#x1F1F7; 요약:</strong> ${article.summaryKo || article.title}</p>
      <p style="line-height: 1.7;"><strong>&#x1F1FA;&#x1F1F8; Summary:</strong> ${article.summaryEn || article.title}</p>
      <div style="background: #FFF8E1; padding: 16px; border-radius: 8px; border-left: 4px solid #FFC107; margin: 16px 0;">
        <strong>&#x1F4A1; 쉬운 예시 | Easy Example:</strong><br><br>
        &#x1F1F0;&#x1F1F7; ${article.exampleKo || ''}<br><br>
        &#x1F1FA;&#x1F1F8; ${article.exampleEn || ''}
      </div>
      <p style="font-size: 13px; color: #888;">&#x1F517; <a href="${article.link}" style="color: #0078D4;">${article.source || 'Source'}</a></p>
    </div>`;
  });

  return `<html><head><meta charset="UTF-8"></head><body style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 700px; margin: 0 auto; color: #333;">
    <div style="background: linear-gradient(135deg, #0078D4, #5C2D91); padding: 24px; border-radius: 12px 12px 0 0;">
      <h1 style="color: white; margin: 0; font-size: 22px;">&#x1F5DE;&#xFE0F; Daily AI &amp; Data News - Top 3</h1>
      <p style="color: #e0e0e0; margin: 8px 0 0 0; font-size: 14px;">${today} | ${todayEn}</p>
    </div>
    ${newsHtml}
    <div style="padding: 16px; text-align: center; color: #999; font-size: 12px;">
      <p>Generated by Google Apps Script + Gemini AI</p>
    </div>
  </body></html>`;
}

// ============================================================
// 테스트
// ============================================================
function testSendEmail() {
  sendDailyNewsDigest();
}
