/**
 * BillingReport.gs
 * Google Cloud AI 비용 리포트 — Azure 스타일 포맷
 * Gemini API + Cloud Text-to-Speech API 비용 현황 → roy@ai4min.com
 *
 * ===== 사전 설정 (1회) =====
 * 1. Cloud Console > 결제 > 결제 내보내기 > BigQuery로 내보내기 활성화
 *    데이터세트: billing_export / 테이블: cloud_billing_export_v1_XXXXXX
 * 2. GAS Script Properties:
 *    BQ_BILLING_TABLE = your-bq-project.billing_export.cloud_billing_export_v1_XXXX
 * 3. GAS 서비스(+) > BigQuery API 추가
 * =============================
 */

var BR_GEMINI_KEY  = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
var BR_RECIPIENT   = 'roy@ai4min.com';
var BR_GCP_PROJECT = 'gen-lang-client-0656396808';
var BR_BQ_TABLE    = PropertiesService.getScriptProperties().getProperty('BQ_BILLING_TABLE') || '';

var BR_SERVICES = {
  'Generative Language API': { label: 'Gemini API',  color: '#0078D4', bg: '#EFF6FF' },
  'Cloud Text-to-Speech API': { label: 'Cloud TTS',  color: '#107C10', bg: '#F0FFF4' }
};

// ─── 메인 함수 ────────────────────────────────────────────────
function sendBillingReport() {
  try {
    Logger.log('=== Cloud AI Billing Report Start ===');
    var data = getBillingData();
    var html = buildBillingReportHTML(data);
    var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
    GmailApp.sendEmail(
      BR_RECIPIENT,
      '[IT News Google Cloud AI Billing] - ' + today,
      '',
      { htmlBody: html, name: 'Google Cloud Billing Bot', charset: 'UTF-8' }
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
  var todayStr     = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var yesterdayStr = Utilities.formatDate(new Date(now.getTime() - 86400000), tz, 'yyyy-MM-dd');
  var monthStartStr = Utilities.formatDate(now, tz, 'yyyy-MM') + '-01';
  var day7Str  = Utilities.formatDate(new Date(now.getTime() - 7  * 86400000), tz, 'yyyy-MM-dd');
  var day30Str = Utilities.formatDate(new Date(now.getTime() - 30 * 86400000), tz, 'yyyy-MM-dd');

  var data = {
    date: todayStr,
    reportTime: Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm') + ' KST',
    currency: 'USD',
    services: {},
    total: { last24h: 0, last7d: 0, last30d: 0, monthToDate: 0 },
    dailyBreakdown: [],
    stats: { dailyAvg: 0, weeklyAvg: 0, monthProjected: 0 },
    hasBQData: false,
    setupRequired: false,
    bqError: null
  };

  Object.keys(BR_SERVICES).forEach(function (svc) {
    data.services[svc] = { last24h: 0, last7d: 0, last30d: 0, monthToDate: 0, pct: '0.0' };
  });

  if (!BR_BQ_TABLE) {
    data.setupRequired = true;
    Logger.log('BQ_BILLING_TABLE not set.');
    return data;
  }

  try {
    var rows = queryBigQueryBilling();
    if (!rows || rows.length === 0) {
      Logger.log('No billing rows from BigQuery.');
      return data;
    }

    data.hasBQData = true;
    var dailyMap = {};

    rows.forEach(function (row) {
      var f = row.f;
      var svcName  = f[0].v;
      var dateStr  = f[1].v;
      var cost     = parseFloat(f[2].v || 0);
      var currency = f[3].v || 'USD';
      data.currency = currency;

      if (!data.services[svcName]) return;
      var svc = data.services[svcName];

      if (dateStr === yesterdayStr || dateStr === todayStr) {
        svc.last24h += cost; data.total.last24h += cost;
      }
      if (dateStr >= day7Str) {
        svc.last7d += cost; data.total.last7d += cost;
      }
      if (dateStr >= day30Str) {
        svc.last30d += cost; data.total.last30d += cost;
      }
      if (dateStr >= monthStartStr) {
        svc.monthToDate += cost; data.total.monthToDate += cost;
      }

      if (!dailyMap[dateStr]) dailyMap[dateStr] = { date: dateStr, total: 0 };
      dailyMap[dateStr][svcName] = (dailyMap[dateStr][svcName] || 0) + cost;
      dailyMap[dateStr].total += cost;
    });

    // 최근 7일 일별 내역
    data.dailyBreakdown = Object.keys(dailyMap)
      .sort().reverse().slice(0, 7)
      .map(function (k) { return dailyMap[k]; });

    // 통계
    var daysInMonth = parseInt(todayStr.split('-')[2], 10) || 1;
    data.stats = {
      dailyAvg:       data.total.last7d  / 7,
      weeklyAvg:      data.total.last30d / 4.33,
      monthProjected: (data.total.monthToDate / daysInMonth) * 30,
      daysInMonth:    daysInMonth
    };

    // 서비스 비율 (이번 달 기준)
    var totalMTD = data.total.monthToDate || 0.000001;
    Object.keys(BR_SERVICES).forEach(function (svc) {
      data.services[svc].pct = (data.services[svc].monthToDate / totalMTD * 100).toFixed(1);
    });

  } catch (e) {
    Logger.log('BigQuery error: ' + e.message);
    data.bqError = e.message;
  }

  return data;
}

function queryBigQueryBilling() {
  var bqProject   = BR_BQ_TABLE.split('.')[0];
  var serviceList = Object.keys(BR_SERVICES).map(function (s) { return "'" + s + "'"; }).join(', ');

  var sql =
    'SELECT service.description, ' +
    "CAST(DATE(usage_start_time, 'Asia/Seoul') AS STRING), " +
    'ROUND(SUM(cost), 6), currency ' +
    'FROM `' + BR_BQ_TABLE + '` ' +
    "WHERE project.id = '" + BR_GCP_PROJECT + "' " +
    '  AND usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 32 DAY) ' +
    '  AND service.description IN (' + serviceList + ') ' +
    'GROUP BY 1, 2, 4 ORDER BY 2 DESC, 1';

  var res = UrlFetchApp.fetch(
    'https://bigquery.googleapis.com/bigquery/v2/projects/' + bqProject + '/queries',
    {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 30000 }),
      muteHttpExceptions: true
    }
  );

  var result = JSON.parse(res.getContentText());
  if (result.error) throw new Error(result.error.message);

  if (!result.jobComplete) {
    Utilities.sleep(3000);
    var jobId = result.jobReference.jobId;
    var poll = UrlFetchApp.fetch(
      'https://bigquery.googleapis.com/bigquery/v2/projects/' + bqProject + '/queries/' + jobId,
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true }
    );
    result = JSON.parse(poll.getContentText());
    if (result.error) throw new Error(result.error.message);
  }

  return result.rows || [];
}

// ─── HTML 이메일 빌드 (Azure 스타일) ─────────────────────────
function buildBillingReportHTML(d) {
  var fmt = function (v, n) { return '$' + (v || 0).toFixed(n !== undefined ? n : 4); };

  var g = d.services['Generative Language API'];
  var t = d.services['Cloud Text-to-Speech API'];
  var st = d.stats || {};

  // ── Setup 안내 (숨김) ──
  var setupMsg = '';

  // ── Section 1: 기간별 누적 비용 (4 카드) ──
  var cards = [
    { label: '최근 24시간', sublabel: 'Last 24 hours', value: fmt(d.total.last24h, 4), color: '#0078D4', icon: '&#x23F0;' },
    { label: '최근 7일',   sublabel: 'Last 7 days',   value: fmt(d.total.last7d,  4), color: '#107C10', icon: '&#x1F4C5;' },
    { label: '최근 30일',  sublabel: 'Last 30 days',  value: fmt(d.total.last30d, 4), color: '#5C2D91', icon: '&#x1F4CA;' },
    { label: '이번 달',    sublabel: 'Month-to-Date',  value: fmt(d.total.monthToDate, 4), color: '#D83B01', icon: '&#x1F4B0;' }
  ];
  var cardHtml = '<table width="100%" cellpadding="0" cellspacing="0">';
  for (var ci = 0; ci < cards.length; ci++) {
    var c = cards[ci];
    if (ci % 2 === 0) cardHtml += '<tr>';
    cardHtml +=
      '<td style="width:50%;padding:3px 4px;" align="center">' +
      '<div style="background:#fff;border:1px solid #E5E7EB;border-radius:8px;padding:10px 8px;text-align:center;border-top:3px solid ' + c.color + ';">' +
      '<div style="font-size:15px;margin-bottom:2px;">' + c.icon + '</div>' +
      '<div style="font-size:15px;font-weight:700;color:' + c.color + ';margin-bottom:1px;">' + c.value + '</div>' +
      '<div style="font-size:11px;color:#374151;font-weight:600;">' + c.label + '</div>' +
      '<div style="font-size:10px;color:#9CA3AF;">' + c.sublabel + '</div>' +
      '</div></td>';
    if (ci % 2 === 1) cardHtml += '</tr>';
  }
  cardHtml += '</table>';

  // ── Section 2: 서비스별 비용 (최근 30일) + 바 차트 ──
  var maxSvc = Math.max(g.last30d || 0, t.last30d || 0, 0.000001);
  var svcRows = '';
  [[g, 'Generative Language API'], [t, 'Cloud Text-to-Speech API']].forEach(function (pair) {
    var svc = pair[0]; var key = pair[1];
    var info = BR_SERVICES[key];
    var barPct = Math.round((svc.last30d || 0) / maxSvc * 100);
    svcRows +=
      '<tr style="border-bottom:1px solid #F3F4F6;">' +
      '<td style="padding:8px 12px;font-size:12px;width:110px;">' +
      '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + info.color + ';margin-right:5px;vertical-align:middle;"></span>' +
      '<span style="color:#374151;">' + info.label + '</span></td>' +
      '<td style="padding:8px 12px;font-size:12px;font-weight:600;color:' + info.color + ';width:80px;text-align:right;">' + fmt(svc.last30d, 4) + '</td>' +
      '<td style="padding:8px 12px;">' +
      '<div style="background:#F3F4F6;border-radius:4px;height:10px;">' +
      '<div style="background:' + info.color + ';border-radius:4px;height:10px;width:' + barPct + '%;"></div>' +
      '</div></td>' +
      '<td style="padding:8px 12px;font-size:11px;color:#6B7280;width:36px;text-align:right;">' + svc.pct + '%</td>' +
      '</tr>';
  });
  svcRows +=
    '<tr style="background:#F8FAFC;">' +
    '<td style="padding:8px 12px;font-size:12px;font-weight:700;color:#111;">합계</td>' +
    '<td style="padding:8px 12px;font-size:12px;font-weight:700;color:#0078D4;text-align:right;">' + fmt(d.total.last30d, 4) + '</td>' +
    '<td style="padding:8px 12px;"></td>' +
    '<td style="padding:8px 12px;font-size:11px;color:#6B7280;text-align:right;">100%</td>' +
    '</tr>';

  // ── Section 3: 일별 추이 (최근 7일) ──
  var maxDay = 0.000001;
  (d.dailyBreakdown || []).forEach(function (r) { if ((r.total || 0) > maxDay) maxDay = r.total; });

  var dailyHtml = '';
  (d.dailyBreakdown || []).forEach(function (row) {
    var barPct = Math.round((row.total || 0) / maxDay * 100);
    var isYesterday = row.date === Utilities.formatDate(new Date(new Date().getTime() - 86400000), 'Asia/Seoul', 'yyyy-MM-dd');
    var label = row.date.substring(5); // MM-DD
    dailyHtml +=
      '<tr style="' + (isYesterday ? 'background:#FFF4E5;' : '') + '">' +
      '<td style="padding:5px 12px;font-size:11px;color:#374151;width:55px;white-space:nowrap;">' +
      label + (isYesterday ? '<br><span style="font-size:9px;color:#D83B01;">▶ 어제</span>' : '') + '</td>' +
      '<td style="padding:5px 12px;">' +
      '<div style="background:#E5E7EB;border-radius:3px;height:8px;">' +
      '<div style="background:#0078D4;border-radius:3px;height:8px;width:' + barPct + '%;"></div>' +
      '</div></td>' +
      '<td style="padding:5px 12px;font-size:11px;font-weight:600;color:#0078D4;width:65px;text-align:right;">' + fmt(row.total || 0, 4) + '</td>' +
      '</tr>';
  });

  // ── Section 4: 통계 및 예측 ──
  function statRow(label, value, valueColor) {
    return '<tr style="border-bottom:1px solid #F3F4F6;">' +
      '<td style="padding:7px 12px;font-size:12px;color:#6B7280;">' + label + '</td>' +
      '<td style="padding:7px 12px;font-size:12px;font-weight:600;text-align:right;color:' + (valueColor || '#111') + ';">' + value + '</td>' +
      '</tr>';
  }

  var statsHtml =
    statRow('일 평균 비용 (7일 기준)', fmt(st.dailyAvg, 4)) +
    statRow('주 평균 비용 (30일 기준)', fmt(st.weeklyAvg, 4)) +
    statRow('이번 달 누적', fmt(d.total.monthToDate, 4)) +
    statRow('이번 달 예상 합계 (' + (st.daysInMonth || '?') + '일 기준)', fmt(st.monthProjected, 4), '#D83B01') +
    statRow('Gemini API 비율', (g.pct || '0.0') + '%', '#0078D4') +
    statRow('Cloud TTS 비율',  (t.pct  || '0.0') + '%', '#107C10');

  // ── HTML 조합 ─────────────────────────────────────────────────
  return [
    '<html><head><meta charset="UTF-8"></head>',
    '<body style="margin:0;padding:16px;background:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">',
    '<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">',

    // 헤더
    '<div style="background:linear-gradient(135deg,#0078D4 0%,#005A9E 100%);padding:12px 16px;">',
    '<div style="font-size:16px;font-weight:700;color:#fff;line-height:1.3;">Google Cloud AI Billing Bot</div>',
    '<div style="font-size:11px;color:rgba(255,255,255,0.75);margin-top:2px;">' + BR_GCP_PROJECT + ' &bull; ' + d.reportTime + '</div>',
    '</div>',

    setupMsg,

    // Section 1
    '<div style="padding:8px 12px 4px;">',
    '<div style="font-size:12px;font-weight:700;color:#0078D4;letter-spacing:0.5px;margin-bottom:6px;">&#x1F4B3;&nbsp; 기간별 누적 비용</div>',
    cardHtml,
    '</div>',

    // Section 2
    '<div style="padding:14px 12px;border-top:6px solid #F3F4F6;">',
    '<div style="font-size:12px;font-weight:700;color:#0078D4;letter-spacing:0.5px;margin-bottom:8px;">&#x1F4CA;&nbsp; 서비스별 비용 <span style="font-weight:400;color:#9CA3AF;font-size:11px;">(최근 30일)</span></div>',
    '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">',
    '<tr style="background:#F8FAFC;border-bottom:2px solid #E5E7EB;">',
    '<th style="padding:6px 12px;font-size:10px;color:#6B7280;text-align:left;font-weight:600;width:110px;">서비스</th>',
    '<th style="padding:6px 12px;font-size:10px;color:#6B7280;text-align:right;font-weight:600;width:80px;">비용</th>',
    '<th style="padding:6px 12px;font-size:10px;color:#6B7280;font-weight:600;">사용 비율</th>',
    '<th style="padding:6px 12px;font-size:10px;color:#6B7280;text-align:right;font-weight:600;width:36px;">%</th>',
    '</tr>',
    svcRows,
    '</table></div>',

    // Section 3
    (dailyHtml
      ? '<div style="padding:14px 12px;border-top:6px solid #F3F4F6;">' +
        '<div style="font-size:12px;font-weight:700;color:#0078D4;letter-spacing:0.5px;margin-bottom:8px;">&#x1F4C8;&nbsp; 일별 추이 <span style="font-weight:400;color:#9CA3AF;font-size:11px;">(최근 7일)</span></div>' +
        '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">' +
        dailyHtml + '</table></div>'
      : ''),

    // Section 4
    '<div style="padding:14px 12px;border-top:6px solid #F3F4F6;">',
    '<div style="font-size:12px;font-weight:700;color:#0078D4;letter-spacing:0.5px;margin-bottom:8px;">&#x1F4C9;&nbsp; 통계 및 예측</div>',
    '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">',
    statsHtml,
    '</table></div>',

    // 푸터
    '<div style="background:#F8FAFC;padding:12px 16px;border-top:1px solid #E5E7EB;text-align:center;">',
    '<a href="https://console.cloud.google.com/billing/reports?project=' + BR_GCP_PROJECT + '" style="font-size:11px;color:#0078D4;text-decoration:none;margin:0 10px;">&#x1F517; 비용 보고서</a>',
    '<span style="color:#D1D5DB;font-size:11px;">|</span>',
    '<a href="https://console.cloud.google.com/bigquery?project=' + BR_GCP_PROJECT + '" style="font-size:11px;color:#0078D4;text-decoration:none;margin:0 10px;">&#x1F517; BigQuery</a>',
    '<div style="margin-top:6px;font-size:10px;color:#9CA3AF;">Generated by Google Apps Script &bull; ' + BR_GCP_PROJECT + '</div>',
    '</div>',

    '</div></body></html>'
  ].join('\n');
}

// ─── 트리거 설정 ──────────────────────────────────────────────
function createBillingTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendBillingReport') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendBillingReport').timeBased().everyDays(1).atHour(8).nearMinute(30).create();
  Logger.log('Billing trigger created: daily ~8:30 AM KST');
}

// ─── 테스트 ───────────────────────────────────────────────────
function testSendBillingReport() { sendBillingReport(); }
