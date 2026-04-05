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

    const enriched = selectAndEnrichWithGemini(allArticles);
    Logger.log('선별된 Top 3: ' + enriched.map(function(a) { return a.title; }).join(' | '));

    const htmlBody = buildEmailHTML(enriched);

    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const subject = '[Daily AI & Data News] Top 3 뉴스 - ' + today;

    GmailApp.sendEmail(RECIPIENT_EMAIL, subject, '', {
      htmlBody: htmlBody,
      name: 'AI & Data News Bot'
    });

    Logger.log('✅ 이메일 발송 완료!');
  } catch (error) {
    Logger.log('❌ 오류 발생: ' + error.message);
    GmailApp.sendEmail(RECIPIENT_EMAIL,
      '[Daily AI News] 오류 발생',
      '뉴스 수집 중 오류가 발생했습니다: ' + error.message
    );
  }
}

// ============================================================
// 뉴스 수집 - Google News RSS
// ============================================================
function fetchNewsFromRSS() {
  var articles = [];

  for (var qi = 0; qi < SEARCH_QUERIES.length; qi++) {
    var query = SEARCH_QUERIES[qi];
    try {
      var encodedQuery = encodeURIComponent(query + ' when:1d');
      var rssUrl = 'https://news.google.com/rss/search?q=' + encodedQuery + '&hl=en&gl=US&ceid=US:en';

      var response = UrlFetchApp.fetch(rssUrl, { muteHttpExceptions: true });

      if (response.getResponseCode() !== 200) {
        Logger.log('RSS 요청 실패 (' + query + '): ' + response.getResponseCode());
        continue;
      }

      var xml = XmlService.parse(response.getContentText());
      var root = xml.getRootElement();
      var channel = root.getChild('channel');

      if (!channel) continue;

      var items = channel.getChildren('item');

      for (var ii = 0; ii < items.length; ii++) {
        var item = items[ii];
        var title = item.getChildText('title') || '';
        var link = item.getChildText('link') || '';
        var pubDate = item.getChildText('pubDate') || '';
        var source = item.getChildText('source') || '';

        // 중복 체크
        var isDup = false;
        for (var di = 0; di < articles.length; di++) {
          if (articles[di].title === title) { isDup = true; break; }
        }
        if (isDup) continue;

        // 실제 기사 URL 추출
        var articleUrl = extractArticleUrl(item, link);

        articles.push({
          title: title,
          link: articleUrl,
          pubDate: pubDate,
          source: source,
          query: query
        });
      }
    } catch (e) {
      Logger.log('RSS 파싱 오류 (' + query + '): ' + e.message);
    }
  }

  return articles;
}

// ============================================================
// Google News URL → 실제 기사 URL 추출
// ============================================================
function extractArticleUrl(item, rawLink) {
  rawLink = rawLink || '';

  // Method 1: Base64 decode the CBMi... article ID
  try {
    var match = rawLink.match(/articles\/([A-Za-z0-9_\-]+)/);
    if (match) {
      var b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4 !== 0) b64 += '=';
      var bytes = Utilities.base64Decode(b64);
      for (var i = 0; i < bytes.length - 4; i++) {
        // Look for "http" bytes: 0x68 0x74 0x74 0x70
        if (bytes[i] === 0x68 && bytes[i+1] === 0x74 && bytes[i+2] === 0x74 && bytes[i+3] === 0x70) {
          var url = '';
          for (var j = i; j < bytes.length; j++) {
            if (bytes[j] < 0x20) break;
            url += String.fromCharCode(bytes[j]);
          }
          if (url.indexOf('http') === 0 && url.indexOf('google.com') < 0) {
            Logger.log('Base64 decoded URL: ' + url);
            return url;
          }
          break;
        }
      }
    }
  } catch (e) {
    Logger.log('Base64 decode error: ' + e.message);
  }

  // Method 2: Follow redirect and read canonical URL
  try {
    if (rawLink && rawLink.indexOf('http') === 0) {
      var resp = UrlFetchApp.fetch(rawLink, {
        followRedirects: true,
        muteHttpExceptions: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }
      });
      var finalUrl = resp.getFinalUrl ? resp.getFinalUrl() : null;
      if (finalUrl && finalUrl.indexOf('google.com') < 0 && finalUrl.indexOf('http') === 0) {
        Logger.log('Redirect URL: ' + finalUrl);
        return finalUrl;
      }
      var html = resp.getContentText().substring(0, 5000);
      // Check canonical
      var canonMatch = html.match(/<link[^>]+rel=[\"']canonical[\"'][^>]+href=[\"']([^\"']+)[\"']/i);
      if (!canonMatch) canonMatch = html.match(/<link[^>]+href=[\"']([^\"']+)[\"'][^>]+rel=[\"']canonical[\"']/i);
      if (canonMatch && canonMatch[1].indexOf('google.com') < 0) {
        Logger.log('Canonical URL: ' + canonMatch[1]);
        return canonMatch[1];
      }
      // Check og:url
      var ogMatch = html.match(/<meta[^>]+property=[\"']og:url[\"'][^>]+content=[\"']([^\"']+)[\"']/i);
      if (!ogMatch) ogMatch = html.match(/<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+property=[\"']og:url[\"']/i);
      if (ogMatch && ogMatch[1].indexOf('google.com') < 0) {
        Logger.log('og:url: ' + ogMatch[1]);
        return ogMatch[1];
      }
    }
  } catch (e) {
    Logger.log('Redirect/parse error: ' + e.message);
  }

  // Method 3: description tag href
  try {
    var desc = item.getChildText('description') || '';
    var hrefMatch = desc.match(/href=[\"']([^\"']+)[\"']/);
    if (hrefMatch && hrefMatch[1].indexOf('google.com') < 0 && hrefMatch[1].indexOf('http') === 0) {
      Logger.log('Description href: ' + hrefMatch[1]);
      return hrefMatch[1];
    }
  } catch (e) {}

  // Fallback: Google News link
  Logger.log('Fallback to Google News link: ' + rawLink);
  return rawLink;
}

// ============================================================
// Gemini API - 카테고리별 최적 기사 선별 + 요약 (통합)
// ============================================================
function selectAndEnrichWithGemini(allArticles) {
  // 카테고리별 분류
  var groups = {
    ai: [],
    azure: [],
    data: []
  };

  for (var i = 0; i < allArticles.length; i++) {
    var a = allArticles[i];
    var q = a.query || '';
    if (q.indexOf('AI') >= 0 || q.indexOf('artificial intelligence') >= 0) {
      groups.ai.push(a);
    } else if (q.indexOf('Azure') >= 0 || q.indexOf('Fabric') >= 0) {
      groups.azure.push(a);
    } else {
      groups.data.push(a);
    }
  }

  // 각 카테고리 최대 10개로 제한
  function topN(arr, n) { return arr.slice(0, n); }
  var aiList   = topN(groups.ai,    10);
  var azureList = topN(groups.azure, 10);
  var dataList  = topN(groups.data,  10);

  function formatList(arr) {
    return arr.map(function(a, i) {
      return i + '. "' + a.title + '" (Source: ' + (a.source || 'Unknown') + ')';
    }).join('\n');
  }

  var prompt =
    'You are a tech news curator for a Data Engineer who wants daily briefings.\n\n' +
    'Below are news articles grouped into 3 categories.\n' +
    'Your tasks:\n' +
    '1. From each category, select the SINGLE most important, insightful article (avoid marketing/ads, prefer technical depth or industry impact).\n' +
    '2. For each selected article, provide Korean and English title, summary, and an easy analogy.\n\n' +
    '[Category 1: AI]\n' + formatList(aiList) + '\n\n' +
    '[Category 2: Azure Data Architecture]\n' + formatList(azureList) + '\n\n' +
    '[Category 3: Data Engineering]\n' + formatList(dataList) + '\n\n' +
    'Return a JSON array with exactly 3 objects in this order: AI, Azure Data Architecture, Data Engineering.\n' +
    '[\n' +
    '  {\n' +
    '    "category": "AI",\n' +
    '    "selectedIndex": <0-based index from Category 1 list>,\n' +
    '    "titleKo": "한국어 제목",\n' +
    '    "titleEn": "English title",\n' +
    '    "summaryKo": "2-3문장 한국어 요약",\n' +
    '    "summaryEn": "2-3 sentence English summary",\n' +
    '    "exampleKo": "초등학생도 이해할 수 있는 쉬운 비유 예시 (한국어, 2-3문장)",\n' +
    '    "exampleEn": "Easy real-world analogy example anyone can understand (English, 2-3 sentences)"\n' +
    '  },\n' +
    '  { "category": "Azure Data Architecture", "selectedIndex": <index from Category 2>, ... },\n' +
    '  { "category": "Data Engineering", "selectedIndex": <index from Category 3>, ... }\n' +
    ']\n\n' +
    'IMPORTANT: Return ONLY the JSON array. No markdown, no code blocks, no extra text.';

  var modelConfigs = [
    ['gemini-2.0-flash-lite', 'v1beta'],
    ['gemini-1.5-flash-latest', 'v1beta'],
    ['gemini-1.5-flash', 'v1'],
    ['gemini-1.5-pro', 'v1'],
    ['gemini-2.0-flash', 'v1beta']
  ];

  for (var mi = 0; mi < modelConfigs.length; mi++) {
    var modelId = modelConfigs[mi][0];
    var apiVersion = modelConfigs[mi][1];
    try {
      Logger.log('Trying model: ' + modelId + ' (' + apiVersion + ')');
      var url = 'https://generativelanguage.googleapis.com/' + apiVersion + '/models/' + modelId + ':generateContent?key=' + GEMINI_API_KEY;

      var payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 4096
        }
      };

      var options = {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      };

      var response = UrlFetchApp.fetch(url, options);
      var json = JSON.parse(response.getContentText());

      if (json.error) {
        Logger.log('Model ' + modelId + ' error: ' + json.error.message);
        continue;
      }

      if (!json.candidates || !json.candidates[0] || !json.candidates[0].content) {
        Logger.log('Model ' + modelId + ': no candidates');
        continue;
      }

      var text = json.candidates[0].content.parts[0].text;
      var cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

      try {
        var results = JSON.parse(cleanText);
        Logger.log('✅ Gemini success with model: ' + modelId);

        // selectedIndex로 원본 기사 매핑
        var categoryLists = [aiList, azureList, dataList];
        return results.map(function(r, i) {
          var sourceList = categoryLists[i] || [];
          var idx = (typeof r.selectedIndex === 'number' && r.selectedIndex >= 0 && r.selectedIndex < sourceList.length)
            ? r.selectedIndex : 0;
          var originalArticle = sourceList[idx] || sourceList[0] || {};
          return Object.assign({}, originalArticle, r);
        });

      } catch (parseErr) {
        Logger.log('JSON parse error for ' + modelId + ': ' + parseErr.message);
        continue;
      }
    } catch (e) {
      Logger.log('Fetch error for ' + modelId + ': ' + e.message);
    }
  }

  // All models failed - fallback: 각 카테고리 첫번째 기사
  Logger.log('⚠️ All Gemini models failed. Using fallback.');
  var fallbackArticles = [
    aiList[0]    || allArticles[0],
    azureList[0] || allArticles[1],
    dataList[0]  || allArticles[2]
  ].filter(Boolean);

  return fallbackArticles.map(function(a) {
    return Object.assign({}, a, {
      titleKo: a.title,
      titleEn: a.title,
      summaryKo: a.title,
      summaryEn: a.title,
      exampleKo: '(요약 생성 중 오류가 발생했습니다)',
      exampleEn: '(Error occurred during summary generation)',
      category: getCategoryFromQuery(a.query)
    });
  });
}

function getCategoryFromQuery(query) {
  if (query.indexOf('AI') >= 0 || query.indexOf('artificial intelligence') >= 0) return 'AI';
  if (query.indexOf('Azure') >= 0 || query.indexOf('Fabric') >= 0) return 'Data Architecture';
  return 'Data Engineering';
}

// ============================================================
// HTML 이메일 빌더
// ============================================================
function buildEmailHTML(articles) {
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy년 MM월 dd일');
  var todayEn = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMMM dd, yyyy');

  var colors = [
    { bg: '#E8F4FD', text: '#0078D4', label: '#0078D4' },
    { bg: '#E8F5E9', text: '#2E7D32', label: '#2E7D32' },
    { bg: '#FCE4EC', text: '#C62828', label: '#C62828' }
  ];

  var newsHtml = '';

  for (var i = 0; i < articles.length; i++) {
    var article = articles[i];
    var color = colors[i % 3];
    var num = i + 1;
    var isLast = (i === articles.length - 1);
    var borderRadius = isLast ? 'border-radius: 0 0 12px 12px;' : '';
    var category = article.category || getCategoryFromQuery(article.query);

    newsHtml += '<div style="border: 1px solid #e0e0e0; border-top: none; padding: 24px 7px; ' + borderRadius + '">' +
      '<div style="background: ' + color.bg + '; padding: 4px 12px; border-radius: 20px; display: inline-block; margin-bottom: 12px;">' +
        '<span style="color: ' + color.label + '; font-weight: bold; font-size: 13px;">#' + num + ' ' + category + '</span>' +
      '</div>' +
      '<h2 style="color: ' + color.text + '; margin: 8px 0; font-size: 18px;">' + (article.titleKo || article.title) + '</h2>' +
      '<h3 style="color: #555; font-weight: normal; font-size: 15px; margin-top: 4px;">' + (article.titleEn || article.title) + '</h3>' +
      '<p style="line-height: 1.7;"><strong>🇰🇷 요약:</strong> ' + (article.summaryKo || article.title) + '</p>' +
      '<p style="line-height: 1.7;"><strong>🇺🇸 Summary:</strong> ' + (article.summaryEn || article.title) + '</p>' +
      '<div style="background: #FFF8E1; padding: 16px; border-radius: 8px; border-left: 4px solid #FFC107; margin: 16px 0;">' +
        '<strong>💡 쉬운 예시 | Easy Example:</strong><br><br>' +
        '🇰🇷 ' + (article.exampleKo || '') + '<br><br>' +
        '🇺🇸 ' + (article.exampleEn || '') +
      '</div>' +
      '<p style="font-size: 13px; color: #888;">🔗 <a href="' + article.link + '" style="color: #0078D4;">' + (article.source || 'Source') + '</a></p>' +
    '</div>';
  }

  return '<html><body style="font-family: \'Segoe UI\', Arial, sans-serif; max-width: 700px; margin: 0 auto; color: #333;">' +
    '<div style="background: linear-gradient(135deg, #0078D4, #5C2D91); padding: 24px; border-radius: 12px 12px 0 0;">' +
      '<h1 style="color: white; margin: 0; font-size: 22px;">🗞️ Daily AI & Data News - Top 3</h1>' +
      '<p style="color: #e0e0e0; margin: 8px 0 0 0; font-size: 14px;">' + today + ' | ' + todayEn + '</p>' +
    '</div>' +
    newsHtml +
    '<div style="padding: 16px; text-align: center; color: #999; font-size: 12px;">' +
      '<p>Generated by Google Apps Script + Gemini AI</p>' +
    '</div>' +
  '</body></html>';
}

// ============================================================
// 테스트 함수들
// ============================================================
function testNewsCollection() {
  var articles = fetchNewsFromRSS();
  Logger.log('수집된 기사 수: ' + articles.length);
  for (var i = 0; i < articles.length; i++) {
    Logger.log((i+1) + '. [' + articles[i].query + '] ' + articles[i].title);
    Logger.log('   Link: ' + articles[i].link);
  }
}

function testGeminiModels() {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + GEMINI_API_KEY;
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var json = JSON.parse(response.getContentText());
  if (json.models) {
    json.models.forEach(function(m) {
      Logger.log(m.name + ' - ' + (m.supportedGenerationMethods || []).join(', '));
    });
  } else {
    Logger.log('Response: ' + response.getContentText().substring(0, 500));
  }
}

function testSendEmail() {
  sendDailyNewsDigest();
}
