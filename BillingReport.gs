/**
 * BillingReport.gs
 * Google Cloud AI 비용 리포트 — Gemini API + Cloud Text-to-Speech API
 * 서비스별 일별/주간별/월별 누적 비용 통계 → roy@ai4min.com
 *
 * ===== 사전 설정 (1회) =====
 * 1. Cloud Console > 결제 > 결제 내보내기 > BigQuery로 내보내기 활성화
 *    - 프로젝트: gen-lang-client-0656396808 (또는 별도 BigQuery 프로젝트)
 *    - 데이터세트 이름: billing_export (임의 설정 가능)
 *    - 테이블 이름은 자동 생성: cloud_billing_export_v1_XXXXXX_XXXX_XXXXXX
 * 2. GAS Script Properties에 설정:
 *    BQ_BILLING_TABLE = your-bq-project.billing_export.cloud_billing_export_v1_XXXXXX_XXXX_XXXXXX
 * 3. GAS 에디터 > 서비스(+) > BigQuery API 추가 (또는 appsscript.json에 scope 추가)
 *    appsscript.json oauthScopes에 추가:
 *    "https://www.googleapis.com/auth/bigquery.readonly"
 * =============================
 */

var BR_GEMINI_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
var BR_RECIPIENT = 'roy@ai4min.com';
var BR_GCP_PROJECT = 'gen-lang-client-0656396808';
var BR_BQ_TABLE = PropertiesService.getScriptProperties().getProperty('BQ_BILLING_TABLE') || '';
var BR_MODEL_PRIORITY = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-flash'];

var BR_SERVICES = {
  'Generative Language API': { label: 'Gemini API', color: '#3b82f6', textColor: '#1e3a5f' },
  'Cloud Text-to-Speech API': { label: 'Cloud TTS', color: '#10b981', textColor: '#065f46' }
};

// ─── 메인 함수 ────────────────────────────────────────────────
function sendBillingReport() {
  try {
    Logger.log('=== Cloud AI Billing Report Start ===');
    var data = getBillingData();
    var enriched = enrichBillingWithGemini(data);
    var html = buildBillingReportHTML(enriched);
    var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
    GmailApp.sendEmail(
      BR_RECIPIENT,
      '[Cloud AI Billing] 비용 리포트 - ' + today,
      '',
      { htmlBody: html, name: 'Cloud Billing Bot', charset: 'UTF-8' }
    );
    Logger.log('Billing report sent to ' + BR_RECIPIENT);
  } catch (e) {
    Logger.log('Error: ' + e.message);
    GmailApp.sendEmail(BR_RECIPIENT, '[Cloud AI Billing] Error', 'Error: ' + e.message);
  }
}

// ─── 데이터 수집 ──────────────────────────────────────────────
function getBillingData() {
  var tz = 'Asia/Seoul';
  var now = new Date();
  var todayStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var yesterdayStr = Utilities.formatDate(new Date(now.getTime() - 86400000), tz, 'yyyy-MM-dd');

  // 기본 구조
  var data = {
    date: todayStr,
    currency: 'USD',
    services: {},
    total: { last24h: 0, last7d: 0, monthToDate: 0 },
    dailyBreakdown: [],
    hasBQData: false,
    setupRequired: false,
    bqError: null
  };

  Object.keys(BR_SERVICES).forEach(function (svc) {
    data.services[svc] = { last24h: 0, last7d: 0, monthToDate: 0 };
  });

  if (!BR_BQ_TABLE) {
    data.setupRequired = true;
    Logger.log('BQ_BILLING_TABLE not set in Script Properties.');
    return data;
  }

  try {
    var rows = queryBigQueryBilling();
    if (!rows || rows.length === 0) {
      Logger.log('No billing rows returned from BigQuery.');
      return data;
    }

    data.hasBQData = true;

    // 기준 날짜
    var monthStartStr = Utilities.formatDate(now, tz, 'yyyy-MM') + '-01';

    // 일별 집계용 맵
    var dailyMap = {};

    rows.forEach(function (row) {
      var f = row.f;
      var svcName = f[0].v;
      var dateStr = f[1].v;          // 'YYYY-MM-DD'
      var cost = parseFloat(f[2].v || 0);
      var currency = f[3].v || 'USD';
      data.currency = currency;

      if (!data.services[svcName]) return;

      var svc = data.services[svcName];

      // 어제 (24h) — BigQuery billing export는 1-2일 지연되므로 어제 기준
      if (dateStr === yesterdayStr || dateStr === todayStr) {
        svc.last24h += cost;
        data.total.last24h += cost;
      }

      // 주간 (7일)
      if (dateStr >= Utilities.formatDate(new Date(now.getTime() - 7 * 86400000), tz, 'yyyy-MM-dd')) {
        svc.last7d += cost;
        data.total.last7d += cost;
      }

      // 월간 누적
      if (dateStr >= monthStartStr) {
        svc.monthToDate += cost;
        data.total.monthToDate += cost;
      }

      // 일별 맵 구축
      if (!dailyMap[dateStr]) dailyMap[dateStr] = { date: dateStr, total: 0 };
      dailyMap[dateStr][svcName] = (dailyMap[dateStr][svcName] || 0) + cost;
      dailyMap[dateStr].total += cost;
    });

    // 최근 7일 일별 내역 (내림차순)
    data.dailyBreakdown = Object.keys(dailyMap)
      .sort().reverse().slice(0, 7)
      .map(function (d) { return dailyMap[d]; });

  } catch (e) {
    Logger.log('BigQuery error: ' + e.message);
    data.bqError = e.message;
  }

  return data;
}

function queryBigQueryBilling() {
  // BQ_BILLING_TABLE 예: my-project.billing_export.cloud_billing_export_v1_ABC123
  var bqProject = BR_BQ_TABLE.split('.')[0];
  var serviceList = Object.keys(BR_SERVICES).map(function (s) {
    return "'" + s + "'";
  }).join(', ');

  var sql =
    'SELECT ' +
    '  service.description AS service_name, ' +
    "  CAST(DATE(usage_start_time, 'Asia/Seoul') AS STRING) AS usage_date, " +
    '  ROUND(SUM(cost), 6) AS total_cost, ' +
    '  currency ' +
    'FROM `' + BR_BQ_TABLE + '` ' +
    "WHERE project.id = '" + BR_GCP_PROJECT + "' " +
    '  AND usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 32 DAY) ' +
    '  AND service.description IN (' + serviceList + ') ' +
    'GROUP BY service_name, usage_date, currency ' +
    'ORDER BY usage_date DESC, service_name';

  var response = UrlFetchApp.fetch(
    'https://bigquery.googleapis.com/bigquery/v2/projects/' + bqProject + '/queries',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 30000 }),
      muteHttpExceptions: true
    }
  );

  var result = JSON.parse(response.getContentText());
  if (result.error) throw new Error(result.error.message);

  // 쿼리가 완료될 때까지 폴링
  if (!result.jobComplete) {
    Utilities.sleep(3000);
    var jobId = result.jobReference.jobId;
    var pollRes = UrlFetchApp.fetch(
      'https://bigquery.googleapis.com/bigquery/v2/projects/' + bqProject + '/queries/' + jobId,
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true }
    );
    result = JSON.parse(pollRes.getContentText());
    if (result.error) throw new Error(result.error.message);
  }

  return result.rows || [];
}

// ─── Gemini 요약 생성 ─────────────────────────────────────────
function brGetAvailableModel() {
  try {
    var res = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?key=' + BR_GEMINI_KEY,
      { muteHttpExceptions: true }
    );
    var models = (JSON.parse(res.getContentText()).models || [])
      .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0; })
      .map(function (m) { return m.name.replace('models/', ''); });
    for (var i = 0; i < BR_MODEL_PRIORITY.length; i++) {
      var match = models.filter(function (a) { return a.indexOf(BR_MODEL_PRIORITY[i]) >= 0; })[0];
      if (match) return match;
    }
    return models[0] || null;
  } catch (e) { return null; }
}

function enrichBillingWithGemini(data) {
  var fmt4 = function (v) { return '$' + (v || 0).toFixed(4); };
  var g = data.services['Generative Language API'];
  var t = data.services['Cloud Text-to-Speech API'];

  var fallback = {
    summaryKo: '어제 Gemini API ' + fmt4(g.last24h) + ', Cloud TTS ' + fmt4(t.last24h) + ' 발생. ' +
      '최근 7일 합계 ' + fmt4(data.total.last7d) + ', 이번 달 누적 ' + fmt4(data.total.monthToDate) + '.',
    summaryEn: 'Yesterday: Gemini API ' + fmt4(g.last24h) + ', Cloud TTS ' + fmt4(t.last24h) + '. ' +
      'Weekly total ' + fmt4(data.total.last7d) + ', MTD ' + fmt4(data.total.monthToDate) + '.',
    highlightKo: '어제 총 비용 ' + fmt4(data.total.last24h) + ' | 이번 달 누적 ' + fmt4(data.total.monthToDate),
    highlightEn: 'Yesterday ' + fmt4(data.total.last24h) + ' | MTD ' + fmt4(data.total.monthToDate)
  };

  if (!data.hasBQData) {
    for (var k in fallback) data[k] = fallback[k];
    return data;
  }

  var mdl = brGetAvailableModel();
  if (!mdl) {
    for (var k in fallback) data[k] = fallback[k];
    return data;
  }

  var prompt =
    'Google Cloud AI 비용을 2-3문장으로 요약. 금액 단위: USD.\n' +
    '어제: Gemini=' + fmt4(g.last24h) + ', TTS=' + fmt4(t.last24h) + ', 합계=' + fmt4(data.total.last24h) + '\n' +
    '7일: Gemini=' + fmt4(g.last7d) + ', TTS=' + fmt4(t.last7d) + ', 합계=' + fmt4(data.total.last7d) + '\n' +
    '이번달: Gemini=' + fmt4(g.monthToDate) + ', TTS=' + fmt4(t.monthToDate) + ', 합계=' + fmt4(data.total.monthToDate) + '\n' +
    'JSON만 반환 (추가 텍스트 없음):\n' +
    '{"summaryKo":"...","summaryEn":"...","highlightKo":"...","highlightEn":"..."}';

  try {
    var res = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + mdl + ':generateContent?key=' + BR_GEMINI_KEY,
      {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 512 }
        }),
        muteHttpExceptions: true
      }
    );
    var j = JSON.parse(res.getContentText());
    if (j.error) throw new Error(j.error.message);
    var txt = j.candidates[0].content.parts[0].text
      .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    var parsed = JSON.parse(txt);
    for (var k in parsed) data[k] = parsed[k];
  } catch (e) {
    Logger.log('Gemini error: ' + e.message);
    for (var k in fallback) data[k] = fallback[k];
  }

  return data;
}

// ─── HTML 이메일 빌드 ─────────────────────────────────────────
function buildBillingReportHTML(d) {
  var fmt4 = function (v) { return '$' + (v || 0).toFixed(4); };
  var fmt3 = function (v) { return '$' + (v || 0).toFixed(3); };

  var g = d.services['Generative Language API'];
  var t = d.services['Cloud Text-to-Speech API'];

  // Setup 안내 박스
  var setupMsg = '';
  if (d.setupRequired || !d.hasBQData) {
    var reason = d.setupRequired
      ? 'BQ_BILLING_TABLE이 Script Properties에 설정되지 않았습니다.'
      : (d.bqError ? 'BigQuery 오류: ' + d.bqError : '조회된 비용 데이터가 없습니다 (결제 내보내기 활성화 후 데이터 적재까지 최대 24시간 소요).');
    setupMsg =
      '<div style="background:#fff3cd;border-left:4px solid #ffc107;padding:12px 16px;margin:12px 16px;font-size:13px;color:#856404;border-radius:4px;">' +
      '<strong>⚠️ BigQuery 설정 안내</strong><br>' +
      reason + '<br><br>' +
      '<strong>설정 방법:</strong><br>' +
      '① Cloud Console → 결제 → 결제 내보내기 → BigQuery로 내보내기 활성화<br>' +
      '② GAS Script Properties: <code>BQ_BILLING_TABLE</code> = <code>project.dataset.table</code><br>' +
      '③ GAS 서비스(+)에서 BigQuery API 추가 또는 appsscript.json에 bigquery.readonly scope 추가' +
      '</div>';
  }

  // 서비스별 통계 행
  var svcRows = '';
  var svcKeys = Object.keys(BR_SERVICES);
  svcKeys.forEach(function (key) {
    var info = BR_SERVICES[key];
    var svc = d.services[key];
    svcRows +=
      '<tr>' +
      '<td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;">' +
      '<div style="display:flex;align-items:center;gap:7px;">' +
      '<span style="width:9px;height:9px;border-radius:50%;background:' + info.color + ';display:inline-block;flex-shrink:0;"></span>' +
      '<span style="font-size:13px;color:#374151;">' + info.label + '</span></div></td>' +
      '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #f3f4f6;font-size:13px;">' + fmt4(svc.last24h) + '</td>' +
      '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #f3f4f6;font-size:13px;">' + fmt4(svc.last7d) + '</td>' +
      '<td style="padding:7px 10px;text-align:right;border-bottom:1px solid #f3f4f6;font-size:13px;font-weight:600;color:' + info.textColor + ';">' + fmt4(svc.monthToDate) + '</td>' +
      '</tr>';
  });
  // 합계 행
  svcRows +=
    '<tr style="background:#f8fafc;">' +
    '<td style="padding:7px 10px;font-size:13px;font-weight:700;color:#1e3a5f;">합계</td>' +
    '<td style="padding:7px 10px;text-align:right;font-size:13px;font-weight:700;color:#1e3a5f;">' + fmt4(d.total.last24h) + '</td>' +
    '<td style="padding:7px 10px;text-align:right;font-size:13px;font-weight:700;color:#1e3a5f;">' + fmt4(d.total.last7d) + '</td>' +
    '<td style="padding:7px 10px;text-align:right;font-size:13px;font-weight:700;color:#1e3a5f;">' + fmt4(d.total.monthToDate) + '</td>' +
    '</tr>';

  // 일별 내역 행
  var dailyRows = '';
  (d.dailyBreakdown || []).forEach(function (row) {
    var isYesterday = row.date === Utilities.formatDate(new Date(new Date().getTime() - 86400000), 'Asia/Seoul', 'yyyy-MM-dd');
    dailyRows +=
      '<tr' + (isYesterday ? ' style="background:#fef9c3;"' : '') + '>' +
      '<td style="padding:5px 8px;font-size:12px;color:#374151;border-bottom:1px solid #f3f4f6;">' +
      row.date + (isYesterday ? ' <span style="font-size:10px;color:#d97706;">◀ 어제</span>' : '') + '</td>' +
      '<td style="padding:5px 8px;font-size:12px;text-align:right;border-bottom:1px solid #f3f4f6;">' +
      fmt4(row['Generative Language API'] || 0) + '</td>' +
      '<td style="padding:5px 8px;font-size:12px;text-align:right;border-bottom:1px solid #f3f4f6;">' +
      fmt4(row['Cloud Text-to-Speech API'] || 0) + '</td>' +
      '<td style="padding:5px 8px;font-size:12px;text-align:right;font-weight:600;border-bottom:1px solid #f3f4f6;color:#1e3a5f;">' +
      fmt4(row.total || 0) + '</td>' +
      '</tr>';
  });

  return '<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>' +
    '<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">' +
    '<div style="max-width:600px;margin:0 auto;background:#fff;">' +

    // 하이라이트 바 (amber)
    '<div style="background:#FFF8E1;padding:12px 16px;font-size:14px;color:#92400e;font-weight:600;">' +
    (d.highlightKo || '비용 데이터 로딩 중...') + '</div>' +

    // 숫자 카드: Gemini 어제 / TTS 어제 / 7일 합계 / 이번 달 누적
    '<table style="width:100%;border-collapse:collapse;border-bottom:1px solid #e5e7eb;" cellpadding="0" cellspacing="0"><tr>' +
    '<td style="width:25%;text-align:center;padding:14px 0;">' +
    '<div style="display:inline-block;border-left:3px solid #3b82f6;padding-left:8px;text-align:left;">' +
    '<div style="font-size:16px;font-weight:700;color:#1e3a5f;">' + fmt3(g.last24h) + '</div>' +
    '<div style="font-size:10px;color:#9ca3af;">Gemini 어제</div></div></td>' +

    '<td style="width:25%;text-align:center;padding:14px 0;">' +
    '<div style="display:inline-block;border-left:3px solid #10b981;padding-left:8px;text-align:left;">' +
    '<div style="font-size:16px;font-weight:700;color:#065f46;">' + fmt3(t.last24h) + '</div>' +
    '<div style="font-size:10px;color:#9ca3af;">TTS 어제</div></div></td>' +

    '<td style="width:25%;text-align:center;padding:14px 0;">' +
    '<div style="display:inline-block;border-left:3px solid #f59e0b;padding-left:8px;text-align:left;">' +
    '<div style="font-size:16px;font-weight:700;color:#92400e;">' + fmt3(d.total.last7d) + '</div>' +
    '<div style="font-size:10px;color:#9ca3af;">7일 합계</div></div></td>' +

    '<td style="width:25%;text-align:center;padding:14px 0;">' +
    '<div style="display:inline-block;border-left:3px solid #8b5cf6;padding-left:8px;text-align:left;">' +
    '<div style="font-size:16px;font-weight:700;color:#5b21b6;">' + fmt3(d.total.monthToDate) + '</div>' +
    '<div style="font-size:10px;color:#9ca3af;">이번 달</div></div></td>' +
    '</tr></table>' +

    // 타이틀 바 (gradient)
    '<div style="background:linear-gradient(135deg,#1e3a5f,#3b82f6);padding:10px 16px;text-align:center;">' +
    '<span style="font-size:15px;color:#fff;font-weight:600;">Cloud AI Billing Report</span>' +
    '<span style="font-size:11px;color:rgba(255,255,255,0.7);margin-left:8px;">' + d.date + '</span></div>' +

    // Setup 안내 (필요 시만)
    setupMsg +

    // 한국어 요약
    '<div style="padding:14px 16px;border-bottom:1px solid #e5e7eb;">' +
    '<h2 style="font-size:14px;color:#1e3a5f;margin:0 0 6px;">&#x1F1F0;&#x1F1F7; 비용 현황 요약</h2>' +
    '<p style="font-size:13px;color:#4b5563;line-height:1.6;margin:0;">' + (d.summaryKo || '') + '</p></div>' +

    // 영어 요약
    '<div style="padding:14px 16px;border-bottom:1px solid #e5e7eb;">' +
    '<h2 style="font-size:14px;color:#1e3a5f;margin:0 0 6px;">&#x1F1FA;&#x1F1F8; Cost Summary</h2>' +
    '<p style="font-size:13px;color:#4b5563;line-height:1.6;margin:0;">' + (d.summaryEn || '') + '</p></div>' +

    // 서비스별 누적 통계
    '<div style="padding:14px 16px;border-bottom:1px solid #e5e7eb;">' +
    '<h2 style="font-size:14px;color:#dc2626;margin:0 0 8px;">서비스별 누적 비용 (' + d.currency + ')</h2>' +
    '<table style="width:100%;border-collapse:collapse;">' +
    '<tr style="background:#f9fafb;">' +
    '<th style="padding:7px 10px;text-align:left;font-size:11px;color:#6b7280;border-bottom:2px solid #e5e7eb;">서비스</th>' +
    '<th style="padding:7px 10px;text-align:right;font-size:11px;color:#6b7280;border-bottom:2px solid #e5e7eb;">어제</th>' +
    '<th style="padding:7px 10px;text-align:right;font-size:11px;color:#6b7280;border-bottom:2px solid #e5e7eb;">최근 7일</th>' +
    '<th style="padding:7px 10px;text-align:right;font-size:11px;color:#6b7280;border-bottom:2px solid #e5e7eb;">이번 달</th>' +
    '</tr>' +
    svcRows +
    '</table></div>' +

    // 일별 내역
    (dailyRows
      ? '<div style="padding:14px 16px;background:#eff6ff;border-bottom:1px solid #e5e7eb;">' +
      '<h2 style="font-size:14px;color:#1e40af;margin:0 0 8px;">일별 내역 (최근 7일)</h2>' +
      '<table style="width:100%;border-collapse:collapse;">' +
      '<tr style="background:#dbeafe;">' +
      '<th style="padding:5px 8px;text-align:left;font-size:11px;color:#1e40af;">날짜</th>' +
      '<th style="padding:5px 8px;text-align:right;font-size:11px;color:#1e40af;">Gemini</th>' +
      '<th style="padding:5px 8px;text-align:right;font-size:11px;color:#1e40af;">TTS</th>' +
      '<th style="padding:5px 8px;text-align:right;font-size:11px;color:#1e40af;">합계</th>' +
      '</tr>' + dailyRows + '</table></div>'
      : '') +

    // Cloud Console 링크
    '<div style="padding:14px 16px;">' +
    '<h2 style="font-size:14px;color:#059669;margin:0 0 6px;">Cloud Console 바로가기</h2>' +
    '<ul style="padding-left:18px;margin:0;">' +
    '<li style="line-height:1.8;"><a href="https://console.cloud.google.com/billing/linkedaccount?project=' + BR_GCP_PROJECT + '" style="color:#2563eb;font-size:13px;text-decoration:none;">결제 개요</a></li>' +
    '<li style="line-height:1.8;"><a href="https://console.cloud.google.com/billing/reports?project=' + BR_GCP_PROJECT + '" style="color:#2563eb;font-size:13px;text-decoration:none;">비용 보고서 (서비스별)</a></li>' +
    '<li style="line-height:1.8;"><a href="https://console.cloud.google.com/bigquery?project=' + BR_GCP_PROJECT + '" style="color:#2563eb;font-size:13px;text-decoration:none;">BigQuery (결제 내보내기 확인)</a></li>' +
    '</ul></div>' +

    '<div style="padding:8px;text-align:center;font-size:10px;color:#bbb;">GAS + Gemini | ' + BR_GCP_PROJECT + '</div>' +
    '</div></body></html>';
}

// ─── 트리거 설정 ──────────────────────────────────────────────
function createBillingTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendBillingReport') ScriptApp.deleteTrigger(t);
  });
  // 매일 오전 8시 30분
  ScriptApp.newTrigger('sendBillingReport').timeBased().everyDays(1).atHour(8).nearMinute(30).create();
  Logger.log('Billing trigger created: daily ~8:30 AM KST');
}

// ─── 테스트 ───────────────────────────────────────────────────
function testSendBillingReport() { sendBillingReport(); }
