// ============================================================
// Daily AI & Data News - Google Apps Script
// 매일 아침 Top 3 AI/Data 뉴스를 한국어+영어로 이메일 발송
// ============================================================

// 테스트용 - GAS 기본 선택 함수 (맨 위 배치)
function aaRunTest() { sendDailyNewsDigest(); }

// API 키는 GAS Script Properties에 저장 (코드에 노출 방지)
// 설정: GAS 에디터 → 프로젝트 설정 → 스크립트 속성 추가
//   GEMINI_API_KEY  : Google AI Studio (aistudio.google.com/apikey)
//   GOOGLE_TTS_API_KEY : Google Cloud Console → Cloud Text-to-Speech API 활성화 후 발급
const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
const GOOGLE_TTS_API_KEY = PropertiesService.getScriptProperties().getProperty('GOOGLE_TTS_API_KEY') || '';
const RECIPIENT_EMAIL = 'roy@ai4min.com';

const SEARCH_QUERIES = [
  'AI artificial intelligence',
  'Azure data architecture Microsoft Fabric',
  'data engineering data architecture',
  'IT technology cloud computing',
];

// 모델 우선순위 (최신순) - 직접 호출 시도
const MODEL_PRIORITY = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];

// 실행당 한 번만 탐색
let _cachedModel = undefined;

// ============================================================
// 사용 가능한 Gemini 모델 탐색 (모델 목록 API 없이 직접 ping)
// ============================================================
function getAvailableModel() {
  if (_cachedModel !== undefined) return _cachedModel;
  const testPrompt = JSON.stringify({
    contents: [{ parts: [{ text: 'hi' }] }],
    generationConfig: { maxOutputTokens: 1 }
  });
  for (const model of MODEL_PRIORITY) {
    try {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + GEMINI_API_KEY;
      const res = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'application/json',
        payload: testPrompt, muteHttpExceptions: true
      });
      const json = JSON.parse(res.getContentText());
      if (!json.error) {
        Logger.log('선택된 모델: ' + model);
        _cachedModel = model;
        return model;
      }
    } catch (e) { /* 다음 모델 시도 */ }
  }
  _cachedModel = null;
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

    const top3 = selectTop3WithGemini(allArticles);
    Logger.log('Top 3: ' + top3.map(a => a.title).join(' | '));
    Logger.log('링크: ' + top3.map(a => a.link).join(' | '));

    const enriched = generateDigestWithGemini(top3);

    // TTS 음성 브리핑 생성 (GOOGLE_TTS_API_KEY 설정 시)
    const audioBlobs = generateTTSAudio(enriched);

    const htmlBody = buildEmailHTML(enriched, !!audioBlobs);

    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const emailOptions = {
      htmlBody: htmlBody,
      name: 'AI & Data News Bot',
      charset: 'UTF-8'
    };
    if (audioBlobs) emailOptions.attachments = audioBlobs;

    GmailApp.sendEmail(RECIPIENT_EMAIL, '[Daily AI & Data News] Top 3 뉴스 - ' + today, '', emailOptions);

    Logger.log('이메일 발송 완료!');
  } catch (error) {
    Logger.log('오류 발생: ' + error.message);
    GmailApp.sendEmail(RECIPIENT_EMAIL, '[Daily AI News] 오류 발생', '오류: ' + error.message);
  }
}

// ============================================================
// 뉴스 수집 - Bing News RSS (실제 기사 URL 직접 반환)
// ============================================================
function fetchNewsFromRSS() {
  const articles = [];

  for (const query of SEARCH_QUERIES) {
    try {
      const encodedQuery = encodeURIComponent(query);
      // Bing News RSS는 <link>에 실제 기사 URL을 직접 반환
      const rssUrl = 'https://www.bing.com/news/search?q=' + encodedQuery + '&format=rss&mkt=en-US';
      const response = UrlFetchApp.fetch(rssUrl, { muteHttpExceptions: true });

      if (response.getResponseCode() !== 200) {
        Logger.log('Bing RSS 오류 (' + query + '): HTTP ' + response.getResponseCode());
        continue;
      }

      const xml = XmlService.parse(response.getContentText());
      const channel = xml.getRootElement().getChild('channel');
      if (!channel) continue;
      const items = channel.getChildren('item');

      // 최근 48시간 기사 필터링 (여유있게)
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

      for (const item of items) {
        const title = item.getChildText('title') || '';
        const rawLink = item.getChildText('link') || '';
        const pubDate = item.getChildText('pubDate') || '';
        const description = item.getChildText('description') || '';

        // pubDate 필터 (48시간 이내)
        const pub = new Date(pubDate);
        if (pub < twoDaysAgo) continue;

        // Bing 리다이렉트 URL에서 실제 기사 URL 추출
        // 형태: http://www.bing.com/news/apiclick.aspx?...&url=ENCODED_URL&...
        const urlParam = rawLink.match(/[?&]url=([^&]+)/);
        const link = urlParam ? decodeURIComponent(urlParam[1]) : rawLink;

        // source: description 끝부분에서 추출 시도
        const sourceMatch = description.match(/[-–]\s*([^-–<]{3,40})\s*$/);
        const source = sourceMatch ? sourceMatch[1].trim() : (link.match(/^https?:\/\/(?:www\.)?([^\/]+)/) || ['', link])[1];

        if (!title || articles.some(a => a.title === title)) continue;
        articles.push({ title, link, pubDate, source, query });
      }
    } catch (e) {
      Logger.log('RSS 오류 (' + query + '): ' + e.message);
    }
  }

  return articles;
}

// ============================================================
// Top 3 선별 - Gemini가 카테고리별 최적 기사 직접 선택
// 카테고리: AI 1개, Azure Data Architecture 1개 (없으면 IT 일반), Data Engineering 1개
// ============================================================
function selectTop3WithGemini(allArticles) {
  const model = getAvailableModel();

  // 카테고리별 분류
  const groups = { ai: [], azure: [], data: [], it: [] };
  for (const a of allArticles) {
    const q = a.query || '';
    if (q.includes('AI') || q.includes('artificial intelligence')) groups.ai.push(a);
    else if (q.includes('Azure') || q.includes('Fabric'))           groups.azure.push(a);
    else if (q.includes('IT') || q.includes('cloud computing'))     groups.it.push(a);
    else                                                             groups.data.push(a);
  }

  // Azure 없으면 IT 일반으로 대체
  if (groups.azure.length === 0) {
    Logger.log('Azure 뉴스 없음 → IT 일반 뉴스로 대체: ' + groups.it.length + '개');
    groups.azure = groups.it;
  }

  const aiList    = groups.ai.slice(0, 10);
  const azureList = groups.azure.slice(0, 10);
  const dataList  = groups.data.slice(0, 10);

  // Gemini 없으면 단순 첫 번째 기사로 fallback
  if (!model) {
    Logger.log('모델 없음 → 단순 선별 fallback');
    return [aiList[0], azureList[0], dataList[0]].filter(Boolean);
  }

  const fmt = (arr) => arr.map((a, i) => i + '. "' + a.title + '" (' + (a.source || '') + ')').join('\n');

  const prompt =
    'You are a tech news curator for a Data Engineer.\n' +
    'From each category below, select the SINGLE most important article.\n' +
    'Prefer technical depth and industry impact. Avoid marketing/ads.\n\n' +
    '[Category 1: AI]\n' + fmt(aiList) + '\n\n' +
    '[Category 2: Azure Data Architecture]\n' + fmt(azureList) + '\n\n' +
    '[Category 3: Data Engineering]\n' + fmt(dataList) + '\n\n' +
    'Return JSON array of exactly 3 objects, in order: AI, Azure Data Architecture, Data Engineering.\n' +
    '[{"category":"AI","selectedIndex":0},{"category":"Azure Data Architecture","selectedIndex":0},{"category":"Data Engineering","selectedIndex":0}]\n' +
    'IMPORTANT: Return ONLY the JSON array. No markdown, no extra text.';

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + GEMINI_API_KEY;
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 256 }
      }),
      muteHttpExceptions: true
    });

    const json = JSON.parse(res.getContentText());
    if (json.error) throw new Error(json.error.message);

    const text = json.candidates[0].content.parts[0].text;
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    const results = JSON.parse(arrMatch ? arrMatch[0] : cleaned);

    const lists = [aiList, azureList, dataList];
    const selected = results.map((r, i) => {
      const list = lists[i] || [];
      const idx = (typeof r.selectedIndex === 'number' && r.selectedIndex < list.length) ? r.selectedIndex : 0;
      return list[idx] || list[0];
    }).filter(Boolean);

    Logger.log('Gemini 선별 성공 (모델: ' + model + ')');
    return selected;

  } catch (e) {
    Logger.log('Gemini 선별 실패 → 단순 fallback: ' + e.message);
    return [aiList[0], azureList[0], dataList[0]].filter(Boolean);
  }
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
    const cleaned2 = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const arrMatch2 = cleaned2.match(/\[[\s\S]*\]/);
    const enriched = JSON.parse(arrMatch2 ? arrMatch2[0] : cleaned2);
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
// TTS 음성 브리핑 생성 - Google Cloud Text-to-Speech API
// 한국어(ko-KR-Neural2-A) + 영어(en-US-Neural2-F) 각각 MP3 첨부
// ============================================================
function generateTTSAudio(articles) {
  if (!GOOGLE_TTS_API_KEY) {
    Logger.log('GOOGLE_TTS_API_KEY 없음. 음성 브리핑 건너뜀.');
    return null;
  }

  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy년 MM월 dd일');

  // 한국어 스크립트
  let koScript = today + ' AI Data News 브리핑입니다.\n\n';
  articles.forEach((a, i) => {
    koScript += (i + 1) + '번째 기사. ' + (a.titleKo || a.title) + '.\n';
    koScript += (a.summaryKo || '') + '\n';
    koScript += '쉬운 예시. ' + (a.exampleKo || '') + '\n\n';
  });
  koScript += '이상 오늘의 AI Data News 브리핑이었습니다. 좋은 하루 되세요!';

  // 영어 스크립트
  let enScript = "Today's AI Data News briefing.\n\n";
  articles.forEach((a, i) => {
    enScript += 'Article ' + (i + 1) + '. ' + (a.titleEn || a.title) + '.\n';
    enScript += (a.summaryEn || '') + '\n';
    enScript += 'Easy example. ' + (a.exampleEn || '') + '\n\n';
  });
  enScript += "That's all for today's briefing. Have a great day!";

  const blobs = [];

  const koBytes = callTTS(koScript, 'ko-KR', 'ko-KR-Neural2-A', 1.1);
  if (koBytes) {
    blobs.push(Utilities.newBlob(koBytes, 'audio/mpeg', '한국어.mp3'));
    Logger.log('한국어 TTS 완료 (' + Math.round(koBytes.length / 1024) + ' KB)');
  }

  const enBytes = callTTS(enScript, 'en-US', 'en-US-Neural2-F', 1.1);
  if (enBytes) {
    blobs.push(Utilities.newBlob(enBytes, 'audio/mpeg', 'english.mp3'));
    Logger.log('영어 TTS 완료 (' + Math.round(enBytes.length / 1024) + ' KB)');
  }

  return blobs.length > 0 ? blobs : null;
}

function callTTS(text, languageCode, voiceName, speakingRate) {
  const url = 'https://texttospeech.googleapis.com/v1/text:synthesize?key=' + GOOGLE_TTS_API_KEY;
  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        input: { text: text },
        voice: { languageCode: languageCode, name: voiceName },
        audioConfig: { audioEncoding: 'MP3', speakingRate: speakingRate || 1.0 }
      }),
      muteHttpExceptions: true
    });
    const json = JSON.parse(response.getContentText());
    if (json.error) throw new Error(json.error.message);
    return Utilities.base64Decode(json.audioContent);
  } catch (e) {
    Logger.log('TTS 오류 (' + languageCode + '): ' + e.message);
    return null;
  }
}

// ============================================================
// HTML 이메일
// Note: 이모지는 HTML 엔티티 사용 (GAS 4-byte UTF-8 인코딩 문제 방지)
//   &#x1F5DE;&#xFE0F; = 🗞️  &#x1F1F0;&#x1F1F7; = 🇰🇷
//   &#x1F1FA;&#x1F1F8; = 🇺🇸  &#x1F4A1; = 💡  &#x1F517; = 🔗
// ============================================================
function buildEmailHTML(articles, hasAudio) {
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

  const audioBadge = hasAudio ? `
    <div style="background: #f0f4ff; border: 1px solid #c7d7ff; border-radius: 8px; padding: 10px 16px; margin-top: 12px; text-align: center; font-size: 13px; color: #3a5fc8; line-height: 1.5;">
      &#x1F3A7; <strong>음성 첨부됨</strong> &mdash; 출퇴근 시 청취하세요<br>
      <span style="color: #555;">&#x1F1F0;&#x1F1F7; 한국어.mp3 &nbsp;|&nbsp; &#x1F1FA;&#x1F1F8; english.mp3</span>
    </div>` : '';

  return `<html><head><meta charset="UTF-8"></head><body style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 700px; margin: 0 auto; color: #333;">
    <div style="background: linear-gradient(135deg, #0078D4, #5C2D91); padding: 6px 12px; border-radius: 12px 12px 0 0;">
      <p style="color: #000; margin: 0; font-size: 13px;">${today} | ${todayEn}</p>
    </div>
    ${audioBadge}
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
