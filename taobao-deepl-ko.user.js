// ==UserScript==
// @name         타오바오·티몰 DeepL 한국어 번역 (정확도 우선)
// @namespace    local.taobao.deepl.ko
// @version      1.0.1
// @description  타오바오·티몰의 중국어를 DeepL 최고 품질 모델로 한국어 번역합니다. 동적 화면, 캐시, 비용 한도, 원문 복원을 지원합니다.
// @author       local
// @match        https://taobao.com/*
// @match        https://*.taobao.com/*
// @match        https://tmall.com/*
// @match        https://*.tmall.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @grant        window.onurlchange
// @connect      api.deepl.com
// @connect      api-free.deepl.com
// @updateURL    none
// @downloadURL  none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  /*
   * 개인용 스크립트입니다.
   *
   * 보안상 중요한 점
   * - API 키는 이 파일에 적지 않고 Tampermonkey 저장소에만 보관합니다.
   * - 키가 포함된 스크립트를 공유하거나 동기화하지 마세요.
   * - Tampermonkey 저장소는 암호화 금고가 아닙니다. 가장 안전한 구성은
   *   본인 서버(프록시)를 거쳐 DeepL을 호출하는 방식입니다.
   * - 주문·주소·계정·채팅 화면은 기본적으로 번역하지 않습니다.
   *
   * 정확도 설정
   * - model_type은 quality_optimized로 고정합니다.
   * - 짧은 상품 옵션의 언어 오인식을 줄이기 위해 source_lang=ZH를 명시합니다.
   * - 쇼핑 문맥(context)과 짧은 맞춤 지시를 함께 보냅니다.
   */

  const SCRIPT_NAME = '타오바오 DeepL 번역';
  const TARGET_LANGUAGE = 'KO';
  const SOURCE_LANGUAGE = 'ZH';
  const MODEL_TYPE = 'quality_optimized';
  // q2부터 개인정보 화면의 원문은 캐시에 넣지 않습니다.
  // 이전 개발본의 캐시는 민감 원문 포함 여부를 판별할 수 없어 한 번 폐기합니다.
  const CACHE_VERSION = 'q2-sensitive-cache-guard-v1';
  const UI_HOST_ID = 'tm-taobao-deepl-ko-ui';

  const STORAGE = Object.freeze({
    apiKey: 'taobaoDeeplApiKeyV1',
    enabled: 'taobaoDeeplEnabledV1',
    showTranslation: 'taobaoDeeplShowTranslationV1',
    pageCharacterLimit: 'taobaoDeeplPageCharacterLimitV1',
    glossaryId: 'taobaoDeeplGlossaryIdV1',
    cache: 'taobaoDeeplCacheV1',
    cacheEpoch: 'taobaoDeeplCacheEpochV1',
    stats: 'taobaoDeeplStatsV1',
  });

  const CONFIG = Object.freeze({
    batchDelayMs: 180,
    maxBatchTexts: 40,
    maxBatchCharacters: 18000,
    maxTextCharacters: 2000,
    requestTimeoutMs: 25000,
    maxRetries: 2,
    intersectionMarginPx: 900,
    cacheLimit: 4000,
    cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
    cacheSaveDelayMs: 3000,
    statsSaveDelayMs: 1500,
    defaultPageCharacterLimit: 30000,
    scanDebounceMs: 90,
    recordPruneIntervalMs: 45000,
    shadowRootDiscoveryIntervalMs: 15000,
  });

  const SHOPPING_CONTEXT =
    '这是淘宝或天猫购物页面，内容包括商品名称、品牌、型号、规格、颜色、尺码、材质、价格、优惠、库存、物流、评价和售后服务。';

  const CUSTOM_INSTRUCTIONS = Object.freeze([
    '온라인 쇼핑 페이지에 어울리는 자연스럽고 간결한 한국어를 사용합니다.',
    '브랜드명, 제품명, 모델 번호, 수량, 치수, 단위, 가격과 쿠폰 조건을 정확하게 유지합니다.',
    '상품 속성과 선택 옵션은 한국 온라인 쇼핑몰에서 흔히 쓰는 용어로 번역합니다.',
  ]);

  const TRANSLATABLE_ATTRIBUTES = Object.freeze(['placeholder', 'title', 'aria-label']);
  const SKIPPED_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'HEAD',
    'NOSCRIPT',
    'TEMPLATE',
    'TEXTAREA',
    'CODE',
    'PRE',
    'KBD',
    'SAMP',
    'CANVAS',
    'SVG',
    'MATH',
    'IFRAME',
    'OBJECT',
    'EMBED',
  ]);
  const SKIPPED_ANCESTOR_SELECTOR =
    'head,script,style,noscript,template,textarea,code,pre,kbd,samp,canvas,svg,math,iframe,object,embed';

  const SENSITIVE_HOST_PARTS = new Set([
    'account',
    'address',
    'buyer',
    'buyertrade',
    'chat',
    'i',
    'login',
    'member',
    'member1',
    'message',
    'my',
    'myseller',
    'order',
    'pay',
    'passport',
    'qianniu',
    'refund',
    'profile',
    'security',
    'seller',
    'trade',
    'wangwang',
  ]);

  let apiKey = String(GM_getValue(STORAGE.apiKey, '') || '').trim();
  let enabled = Boolean(GM_getValue(STORAGE.enabled, true));
  let showTranslation = Boolean(GM_getValue(STORAGE.showTranslation, true));
  let pageCharacterLimit = normalizePageLimit(
    GM_getValue(STORAGE.pageCharacterLimit, CONFIG.defaultPageCharacterLimit),
  );
  let glossaryId = String(GM_getValue(STORAGE.glossaryId, '') || '').trim();

  let allowSensitivePageForSession = false;
  let routeGeneration = 1;
  let lastUrl = location.href;
  let pageSentCharacters = 0;
  let activeRequest = false;
  let batchTimer = null;
  let cacheSaveTimer = null;
  let statsSaveTimer = null;
  let scanTimer = null;
  let observer = null;
  let intersectionObserver = null;
  let customInstructionsAvailable = true;
  let pageLimitToastShown = false;
  let lastErrorToastAt = 0;
  let ui = null;
  let requestEpoch = 1;
  let cacheEpoch = normalizeCacheEpoch(GM_getValue(STORAGE.cacheEpoch, 0));
  let lastLogicalRouteKey = getLogicalRouteKey();

  const pendingGroups = new Map();
  const inFlightGroups = new Map();
  const pendingScanRoots = new Set();
  const deferredByElement = new Map();
  const activeRecords = new Set();
  const textRecordByNode = new WeakMap();
  const attributeRecordsByElement = new WeakMap();
  const observedRoots = new WeakSet();
  const activeGmRequests = new Set();

  const cache = loadCache();
  const stats = loadStats();
  const statsDelta = {
    apiTexts: 0,
    billedCharacters: 0,
    cacheHits: 0,
    lastModelUsed: '',
  };

  installStorageListeners();
  registerMenus();
  start();

  function start() {
    const initialize = () => {
      createFloatingUi();
      initializeIntersectionObserver();
      observeRoot(document.documentElement);
      updateUi();

      if (canTranslateNow()) {
        scheduleScan(document.body || document.documentElement);
      } else if (!apiKey) {
        window.setTimeout(() => {
          showToast('오른쪽 아래 “API 키 설정”을 눌러 DeepL API 키를 등록하세요.', 'warning', 9000);
        }, 900);
      } else if (isSensitivePageBlocked()) {
        window.setTimeout(() => {
          showToast(
            '개인정보가 포함될 수 있는 화면이라 자동 번역을 막았습니다. 꼭 필요하면 설정에서 이번 탭만 허용하세요.',
            'warning',
            10000,
          );
        }, 900);
      }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
      initialize();
    }

    window.addEventListener('urlchange', handlePossibleRouteChange);
    window.addEventListener('popstate', handlePossibleRouteChange);
    window.addEventListener('hashchange', handlePossibleRouteChange);
    window.addEventListener('pagehide', () => {
      saveCacheNow();
      saveStatsNow();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && canTranslateNow()) {
        scheduleScan(document.body || document.documentElement);
        scheduleBatch(30);
      }
    });

    // 일부 SPA 이동은 urlchange 이벤트를 발생시키지 않으므로 가볍게 보조 확인합니다.
    window.setInterval(handlePossibleRouteChange, 1000);
    window.setInterval(pruneDisconnectedState, CONFIG.recordPruneIntervalMs);
    window.setInterval(() => {
      if (canTranslateNow()) runWhenIdle(discoverOpenShadowRoots);
    }, CONFIG.shadowRootDiscoveryIntervalMs);
  }

  function registerMenus() {
    GM_registerMenuCommand('🔑 DeepL API 키 설정/변경', setApiKeyFromPrompt);
    GM_registerMenuCommand(enabled ? '⏸ 자동 번역 끄기' : '▶ 자동 번역 켜기', toggleEnabled);
    GM_registerMenuCommand(showTranslation ? '原 원문 보기' : '한 번역문 보기', toggleDisplayMode);
    GM_registerMenuCommand(
      `💸 페이지당 새 번역 한도 (${formatLimit(pageCharacterLimit)})`,
      setPageCharacterLimitFromPrompt,
    );
    GM_registerMenuCommand(
      glossaryId ? '📘 DeepL 용어집 ID 변경/해제' : '📘 DeepL 용어집 ID 설정 (선택)',
      setGlossaryIdFromPrompt,
    );
    GM_registerMenuCommand('📊 DeepL 공식 사용량 확인', showOfficialUsage);
    GM_registerMenuCommand('↻ 현재 화면 다시 검사', rescanCurrentPage);
    GM_registerMenuCommand('🧹 번역 캐시 비우기', clearCache);
    GM_registerMenuCommand('🗑 DeepL API 키 삭제', deleteApiKey);
  }

  function setApiKeyFromPrompt() {
    const input = window.prompt(
      [
        'DeepL API 키를 붙여넣으세요.',
        '',
        '키는 코드가 아니라 이 스크립트의 Tampermonkey 저장소에 보관됩니다.',
        'Free 키(:fx)와 유료 API 키의 접속 주소는 자동으로 구분합니다.',
        '기존 키는 화면에 다시 표시하지 않습니다.',
      ].join('\n'),
      '',
    );

    if (input === null) return;
    const nextKey = input.trim();

    if (nextKey.length < 20 || /\s/.test(nextKey)) {
      window.alert('API 키 형식이 올바르지 않습니다. DeepL 계정에서 키 전체를 다시 복사해 주세요.');
      return;
    }

    cancelTranslationWork('paused');
    apiKey = nextKey;
    enabled = true;
    GM_setValue(STORAGE.apiKey, apiKey);
    GM_setValue(STORAGE.enabled, true);
    updateUi();

    if (isSensitivePageBlocked()) {
      showToast('API 키를 저장했습니다. 이 화면은 개인정보 보호를 위해 자동 번역하지 않습니다.', 'success', 7000);
    } else {
      showToast('API 키를 저장했습니다. 현재 화면부터 최고 품질로 번역합니다.', 'success', 6500);
      retryUntranslatedRecords();
      scheduleScan(document.body || document.documentElement);
    }
  }

  function deleteApiKey() {
    if (!apiKey) {
      window.alert('저장된 API 키가 없습니다.');
      return;
    }
    if (!window.confirm('이 스크립트에 저장된 DeepL API 키를 삭제할까요?')) return;

    cancelTranslationWork('paused');
    apiKey = '';
    enabled = false;
    GM_deleteValue(STORAGE.apiKey);
    GM_setValue(STORAGE.enabled, false);
    updateUi();
    showToast('저장된 API 키를 삭제했습니다.', 'success');
  }

  function toggleEnabled() {
    enabled = !enabled;
    GM_setValue(STORAGE.enabled, enabled);

    if (enabled && !apiKey) {
      enabled = false;
      GM_setValue(STORAGE.enabled, false);
      updateUi();
      setApiKeyFromPrompt();
      return;
    }

    if (enabled) {
      showToast('자동 번역을 켰습니다.', 'success');
      retryUntranslatedRecords();
      scheduleScan(document.body || document.documentElement);
    } else {
      cancelTranslationWork('paused');
      showToast('자동 번역을 껐습니다. 이미 번역한 문장은 그대로 둡니다.', 'info');
    }
    updateUi();
  }

  function toggleDisplayMode() {
    showTranslation = !showTranslation;
    GM_setValue(STORAGE.showTranslation, showTranslation);

    for (const record of Array.from(activeRecords)) {
      applyRecordDisplay(record);
    }

    updateUi();
    showToast(showTranslation ? '번역문을 표시합니다.' : '원문을 표시합니다.', 'info', 3000);
  }

  function setPageCharacterLimitFromPrompt() {
    const input = window.prompt(
      [
        '한 페이지에서 DeepL로 새로 보낼 원문 문자 수의 상한입니다.',
        `현재 값: ${pageCharacterLimit === 0 ? '무제한' : formatNumber(pageCharacterLimit) + '자'}`,
        '',
        '추천: 30000 (캐시 재사용은 한도에 포함하지 않음)',
        '0을 입력하면 무제한이지만 무한 스크롤에서 사용량이 빠르게 늘 수 있습니다.',
      ].join('\n'),
      String(pageCharacterLimit),
    );

    if (input === null) return;
    const parsed = Number(input.trim());
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10000000) {
      window.alert('0~10,000,000 사이의 정수를 입력해 주세요.');
      return;
    }

    pageCharacterLimit = parsed;
    pageLimitToastShown = false;
    GM_setValue(STORAGE.pageCharacterLimit, pageCharacterLimit);
    updateUi();
    retryUntranslatedRecords();
    showToast(`페이지당 새 번역 한도를 ${formatLimit(pageCharacterLimit)}로 설정했습니다.`, 'success');
  }

  function setGlossaryIdFromPrompt() {
    const input = window.prompt(
      [
        '중국어(ZH) → 한국어(KO) DeepL 용어집 ID를 입력하세요.',
        '브랜드명과 쇼핑 용어를 일관되게 번역할 때 유용합니다.',
        '',
        '비워 두고 확인하면 용어집을 사용하지 않습니다.',
        '용어집을 바꾸면 기존 번역 캐시는 정확성을 위해 비웁니다.',
      ].join('\n'),
      glossaryId,
    );

    if (input === null) return;
    const nextId = input.trim();
    if (nextId && !/^[a-zA-Z0-9-]{8,100}$/.test(nextId)) {
      window.alert('용어집 ID 형식을 확인해 주세요. 보통 영문·숫자·하이픈으로 된 긴 ID입니다.');
      return;
    }

    cancelTranslationWork('paused');
    glossaryId = nextId;
    GM_setValue(STORAGE.glossaryId, glossaryId);
    clearCacheWithoutPrompt();
    invalidateAllTranslations();
    updateUi();
    scheduleScan(document.body || document.documentElement);
    showToast(glossaryId ? '용어집을 적용했습니다.' : '용어집 사용을 해제했습니다.', 'success');
  }

  function rescanCurrentPage() {
    retryUntranslatedRecords();
    scheduleScan(document.body || document.documentElement);
    showToast('현재 화면을 다시 검사합니다.', 'info', 2500);
  }

  function allowSensitivePage() {
    if (!isSensitivePage()) return;
    const approved = window.confirm(
      [
        '이 화면에는 주문, 주소, 계정 또는 대화 정보가 포함될 수 있습니다.',
        '허용하면 화면의 중국어 문장이 DeepL 서버로 전송됩니다.',
        '',
        '이 탭에서 현재 페이지 번역을 허용할까요?',
      ].join('\n'),
    );
    if (!approved) return;

    allowSensitivePageForSession = true;
    updateUi();
    scheduleScan(document.body || document.documentElement);
    showToast('이 탭에서만 개인정보 화면 번역을 허용했습니다.', 'warning', 7000);
  }

  async function showOfficialUsage() {
    if (!apiKey) {
      setApiKeyFromPrompt();
      return;
    }

    try {
      const response = await requestDeepL({ method: 'GET', path: '/v2/usage' });
      const data = parseJson(response.responseText);
      if (response.status !== 200 || !data) {
        throw new ApiError(response.status, getApiErrorMessage(data, response.status));
      }

      const lines = ['DeepL 공식 사용량 (현재 청구 기간)', ''];
      if (Number.isFinite(Number(data.character_count))) {
        lines.push(`사용: ${formatNumber(data.character_count)}자`);
        lines.push(`한도: ${formatLargeLimit(data.character_limit)}`);
      }
      if (Number.isFinite(Number(data.api_key_character_count))) {
        lines.push(`이 API 키 사용: ${formatNumber(data.api_key_character_count)}자`);
        lines.push(`이 API 키 한도: ${formatLargeLimit(data.api_key_character_limit)}`);
      }
      if (Array.isArray(data.products)) {
        for (const product of data.products) {
          const name = product.product || product.product_type || product.name || '상품';
          const keyCount = product.api_key_unit_count ?? product.api_key_character_count;
          const accountCount = product.account_unit_count ?? product.character_count;
          if (Number.isFinite(Number(keyCount))) lines.push(`${name} · 이 키: ${formatNumber(keyCount)}`);
          if (Number.isFinite(Number(accountCount))) lines.push(`${name} · 계정: ${formatNumber(accountCount)}`);
        }
      }
      if (data.start_time) lines.push(`시작: ${new Date(data.start_time).toLocaleString('ko-KR')}`);
      if (data.end_time) lines.push(`종료: ${new Date(data.end_time).toLocaleString('ko-KR')}`);
      lines.push('', `이 스크립트 로컬 기록: ${formatNumber(stats.billedCharacters)}자`);
      lines.push('공식 수치는 몇 분 정도 늦게 반영될 수 있습니다.');
      window.alert(lines.join('\n'));
    } catch (error) {
      showToast(`사용량 확인 실패: ${error instanceof Error ? error.message : String(error)}`, 'error', 8000);
    }
  }

  function clearCache() {
    if (!window.confirm(`저장된 번역 캐시 ${formatNumber(cache.size)}개를 모두 지울까요?`)) return;
    clearCacheWithoutPrompt();
    updateUi();
    showToast('번역 캐시를 비웠습니다. 이미 표시된 번역은 유지됩니다.', 'success');
  }

  function clearCacheWithoutPrompt() {
    cache.clear();
    cacheEpoch += 1;
    GM_setValue(STORAGE.cacheEpoch, cacheEpoch);
    GM_setValue(STORAGE.cache, []);
  }

  function installStorageListeners() {
    if (typeof GM_addValueChangeListener !== 'function') return;

    GM_addValueChangeListener(STORAGE.cacheEpoch, (_name, _oldValue, newValue, remote) => {
      if (!remote) return;
      const nextEpoch = normalizeCacheEpoch(newValue);
      if (nextEpoch === cacheEpoch) return;
      cacheEpoch = nextEpoch;
      cache.clear();
      if (cacheSaveTimer) {
        window.clearTimeout(cacheSaveTimer);
        cacheSaveTimer = null;
      }
      updateUi();
    });

    GM_addValueChangeListener(STORAGE.cache, (_name, _oldValue, newValue, remote) => {
      if (!remote) return;
      const currentEpoch = normalizeCacheEpoch(GM_getValue(STORAGE.cacheEpoch, 0));
      if (currentEpoch !== cacheEpoch) return;
      mergeCacheEntries(newValue);
      updateUi();
    });

    GM_addValueChangeListener(STORAGE.stats, (_name, _oldValue, newValue, remote) => {
      if (!remote || !newValue || typeof newValue !== 'object') return;
      stats.startedAt = Math.min(
        Number(newValue.startedAt) || stats.startedAt,
        Number(stats.startedAt) || Date.now(),
      );
      stats.apiTexts = (Number(newValue.apiTexts) || 0) + statsDelta.apiTexts;
      stats.billedCharacters =
        (Number(newValue.billedCharacters) || 0) + statsDelta.billedCharacters;
      stats.cacheHits = (Number(newValue.cacheHits) || 0) + statsDelta.cacheHits;
      stats.lastModelUsed =
        statsDelta.lastModelUsed || String(newValue.lastModelUsed || stats.lastModelUsed || '');
      updateUi();
    });
  }

  function createFloatingUi() {
    if (document.getElementById(UI_HOST_ID)) return;

    const host = document.createElement('div');
    host.id = UI_HOST_ID;
    host.setAttribute('data-tm-taobao-deepl-ui', '1');
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .wrap {
        position: fixed;
        z-index: 2147483647;
        right: 16px;
        bottom: 16px;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 7px;
        border: 1px solid rgba(255, 255, 255, .18);
        border-radius: 14px;
        background: rgba(21, 24, 31, .94);
        box-shadow: 0 8px 28px rgba(0, 0, 0, .32);
        color: #f7f8fb;
        font: 600 12px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        backdrop-filter: blur(10px);
      }
      button {
        all: unset;
        box-sizing: border-box;
        cursor: pointer;
        min-height: 31px;
        padding: 7px 10px;
        border-radius: 9px;
        color: #f7f8fb;
        background: #353a46;
        white-space: nowrap;
        transition: background .15s ease, opacity .15s ease;
      }
      button:hover { background: #464d5d; }
      button:focus-visible { outline: 2px solid #79a7ff; outline-offset: 2px; }
      .main[data-state="on"] { background: #176f46; }
      .main[data-state="off"] { background: #6c3434; }
      .main[data-state="blocked"] { background: #765615; }
      .mode { min-width: 49px; text-align: center; }
      .settings { width: 31px; padding: 7px; text-align: center; }
      .panel {
        position: absolute;
        right: 0;
        bottom: calc(100% + 8px);
        width: 270px;
        padding: 13px;
        border: 1px solid rgba(255, 255, 255, .15);
        border-radius: 13px;
        background: #1b1f28;
        box-shadow: 0 10px 32px rgba(0, 0, 0, .38);
      }
      .panel[hidden] { display: none; }
      .title { margin-bottom: 9px; font-size: 14px; font-weight: 750; }
      .row { display: flex; justify-content: space-between; gap: 12px; margin: 6px 0; }
      .label { color: #aeb6c7; font-weight: 500; }
      .value { max-width: 150px; overflow: hidden; text-align: right; text-overflow: ellipsis; }
      .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 11px; }
      .actions button { text-align: center; background: #303746; }
      .wide { grid-column: 1 / -1; }
      .warning { margin-top: 9px; color: #ffd47d; font-size: 11px; font-weight: 500; line-height: 1.4; }
    `;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `
      <button class="main" type="button"></button>
      <button class="mode" type="button" title="원문과 번역문 전환"></button>
      <button class="settings" type="button" title="번역 설정" aria-label="번역 설정">⚙</button>
      <section class="panel" hidden>
        <div class="title">DeepL 한국어 번역</div>
        <div class="row"><span class="label">모델</span><span class="value model">최고 품질</span></div>
        <div class="row"><span class="label">실제 응답</span><span class="value actual-model">아직 없음</span></div>
        <div class="row"><span class="label">이번 페이지</span><span class="value page-usage">0자</span></div>
        <div class="row"><span class="label">캐시</span><span class="value cache-size">0개</span></div>
        <div class="row"><span class="label">용어집</span><span class="value glossary">사용 안 함</span></div>
        <div class="actions">
          <button class="key" type="button">API 키 설정</button>
          <button class="usage" type="button">공식 사용량</button>
          <button class="rescan" type="button">화면 재검사</button>
          <button class="cache" type="button">캐시 비우기</button>
          <button class="allow wide" type="button" hidden>이 개인정보 화면만 허용</button>
        </div>
        <div class="warning" hidden></div>
      </section>
    `;

    shadow.append(style, wrap);
    (document.body || document.documentElement).appendChild(host);

    ui = {
      host,
      wrap,
      main: wrap.querySelector('.main'),
      mode: wrap.querySelector('.mode'),
      settings: wrap.querySelector('.settings'),
      panel: wrap.querySelector('.panel'),
      actualModel: wrap.querySelector('.actual-model'),
      pageUsage: wrap.querySelector('.page-usage'),
      cacheSize: wrap.querySelector('.cache-size'),
      glossary: wrap.querySelector('.glossary'),
      key: wrap.querySelector('.key'),
      usage: wrap.querySelector('.usage'),
      rescan: wrap.querySelector('.rescan'),
      cache: wrap.querySelector('.cache'),
      allow: wrap.querySelector('.allow'),
      warning: wrap.querySelector('.warning'),
    };

    ui.main.addEventListener('click', () => {
      if (!apiKey) setApiKeyFromPrompt();
      else if (isSensitivePageBlocked()) allowSensitivePage();
      else toggleEnabled();
    });
    ui.mode.addEventListener('click', toggleDisplayMode);
    ui.settings.addEventListener('click', () => {
      ui.panel.hidden = !ui.panel.hidden;
    });
    ui.key.addEventListener('click', setApiKeyFromPrompt);
    ui.usage.addEventListener('click', () => void showOfficialUsage());
    ui.rescan.addEventListener('click', rescanCurrentPage);
    ui.cache.addEventListener('click', clearCache);
    ui.allow.addEventListener('click', allowSensitivePage);
  }

  function updateUi() {
    if (!ui) return;

    const blocked = isSensitivePageBlocked();
    if (!apiKey) {
      ui.main.textContent = '🌐 API 키 설정';
      ui.main.dataset.state = 'off';
    } else if (blocked) {
      ui.main.textContent = '🔒 개인정보 보호';
      ui.main.dataset.state = 'blocked';
    } else if (enabled) {
      ui.main.textContent = activeRequest ? '🌐 번역 중…' : '🌐 번역 켬';
      ui.main.dataset.state = 'on';
    } else {
      ui.main.textContent = '🌐 번역 꺼짐';
      ui.main.dataset.state = 'off';
    }

    ui.mode.textContent = showTranslation ? '원문' : '번역';
    ui.mode.title = showTranslation ? '원문 보기' : '번역문 보기';
    ui.key.textContent = apiKey ? 'API 키 변경' : 'API 키 설정';
    ui.pageUsage.textContent = `${formatNumber(pageSentCharacters)} / ${formatLimit(pageCharacterLimit)}`;
    ui.cacheSize.textContent = `${formatNumber(cache.size)}개`;
    ui.glossary.textContent = glossaryId ? `${glossaryId.slice(0, 8)}…` : '사용 안 함';
    ui.actualModel.textContent = stats.lastModelUsed || '아직 없음';
    ui.allow.hidden = !blocked;
    ui.warning.hidden = !blocked;
    ui.warning.textContent = blocked
      ? '화면의 중국어가 DeepL 서버로 전송될 수 있어 자동 번역을 차단했습니다.'
      : '';
  }

  function initializeIntersectionObserver() {
    if (!('IntersectionObserver' in window)) return;

    intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const candidates = deferredByElement.get(entry.target);
          deferredByElement.delete(entry.target);
          intersectionObserver.unobserve(entry.target);

          if (!candidates || !canTranslateNow()) continue;
          for (const candidate of candidates.values()) processCandidate(candidate);
        }
      },
      { root: null, rootMargin: `${CONFIG.intersectionMarginPx}px 0px`, threshold: 0 },
    );
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);

    const localObserver = new MutationObserver((mutations) => {
      if (!canTranslateNow()) return;

      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          handleChangedTextNode(mutation.target);
          continue;
        }

        if (mutation.type === 'attributes') {
          handleChangedAttribute(mutation.target, mutation.attributeName);
          continue;
        }

        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            processOrDefer({ kind: 'text', node });
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            scheduleScan(node);
          }
        }
      }
    });

    localObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATABLE_ATTRIBUTES,
    });

    if (root === document.documentElement) observer = localObserver;
  }

  function scheduleScan(root) {
    if (!root || !canTranslateNow()) return;
    pendingScanRoots.add(root);
    if (scanTimer) return;

    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      const roots = Array.from(pendingScanRoots);
      pendingScanRoots.clear();
      runWhenIdle(() => {
        for (const scanRoot of roots) scanSubtree(scanRoot);
      });
    }, CONFIG.scanDebounceMs);
  }

  function scanSubtree(root) {
    if (!canTranslateNow() || !root?.isConnected) return;

    if (root.nodeType === Node.TEXT_NODE) {
      processOrDefer({ kind: 'text', node: root });
      return;
    }
    const isElementRoot = root instanceof Element;
    const isFragmentRoot = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE;
    if (!isElementRoot && !isFragmentRoot) return;
    if (isElementRoot && isExcludedElement(root)) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const owner = getTextOwnerElement(node);
        if (!owner || isExcludedElement(owner)) return NodeFilter.FILTER_REJECT;
        return hasChinese(cleanText(node.nodeValue || ''))
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    let textNode;
    while ((textNode = walker.nextNode())) {
      processOrDefer({ kind: 'text', node: textNode });
    }

    const elements = [
      ...(isElementRoot ? [root] : []),
      ...root.querySelectorAll('*'),
    ];
    for (const element of elements) {
      if (isExcludedElement(element)) continue;

      for (const attribute of TRANSLATABLE_ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (value && hasChinese(cleanText(value))) {
          processOrDefer({ kind: 'attribute', element, attribute });
        }
      }

      if (element.shadowRoot) {
        observeRoot(element.shadowRoot);
        scheduleScan(element.shadowRoot);
      }
    }
  }

  function getTextOwnerElement(node) {
    if (node?.parentElement) return node.parentElement;
    const root = node?.getRootNode?.();
    return root?.host instanceof Element ? root.host : null;
  }

  function discoverOpenShadowRoots() {
    if (!canTranslateNow()) return;
    for (const element of document.querySelectorAll('*')) {
      if (!element.shadowRoot || observedRoots.has(element.shadowRoot)) continue;
      observeRoot(element.shadowRoot);
      scheduleScan(element.shadowRoot);
    }
  }

  function processOrDefer(candidate) {
    if (!canTranslateNow()) return;
    const element = candidate.kind === 'text'
      ? getTextOwnerElement(candidate.node)
      : candidate.element;
    if (!element || isExcludedElement(element)) return;

    if (!intersectionObserver || isNearViewport(element)) {
      processCandidate(candidate);
      return;
    }

    let candidates = deferredByElement.get(element);
    if (!candidates) {
      candidates = new Map();
      deferredByElement.set(element, candidates);
      intersectionObserver.observe(element);
    }
    const candidateKey = candidate.kind === 'text'
      ? candidate.node
      : `attribute:${candidate.attribute}`;
    candidates.set(candidateKey, candidate);
  }

  function processCandidate(candidate) {
    if (candidate.kind === 'text') processTextNode(candidate.node);
    else processAttribute(candidate.element, candidate.attribute);
  }

  function processTextNode(node) {
    const owner = getTextOwnerElement(node);
    if (!canTranslateNow() || !node?.isConnected || !owner) return;
    if (isExcludedElement(owner)) return;

    const existing = textRecordByNode.get(node);
    const currentValue = String(node.nodeValue || '');

    if (existing?.active) {
      if (isRecordValueCurrent(existing, currentValue)) {
        applyRecordDisplay(existing);
        return;
      }
      invalidateRecord(existing);
    }

    const parts = splitOuterWhitespace(currentValue);
    const source = cleanText(parts.core);
    if (!shouldTranslate(source)) return;

    const record = {
      kind: 'text',
      node,
      source,
      sourceFull: currentValue,
      translatedFull: null,
      leading: parts.leading,
      trailing: parts.trailing,
      generation: routeGeneration,
      sensitive: isSensitivePage(),
      active: true,
      status: 'new',
    };

    textRecordByNode.set(node, record);
    activeRecords.add(record);
    enqueueRecord(record);
  }

  function processAttribute(element, attribute) {
    if (!canTranslateNow() || !element?.isConnected || isExcludedElement(element)) return;
    const currentValue = element.getAttribute(attribute);
    if (!currentValue) return;

    let records = attributeRecordsByElement.get(element);
    if (!records) {
      records = new Map();
      attributeRecordsByElement.set(element, records);
    }

    const existing = records.get(attribute);
    if (existing?.active) {
      if (isRecordValueCurrent(existing, currentValue)) {
        applyRecordDisplay(existing);
        return;
      }
      invalidateRecord(existing);
    }

    const source = cleanText(currentValue);
    if (!shouldTranslate(source)) return;

    const record = {
      kind: 'attribute',
      element,
      attribute,
      source,
      sourceFull: currentValue,
      translatedFull: null,
      leading: '',
      trailing: '',
      generation: routeGeneration,
      sensitive: isSensitivePage(),
      active: true,
      status: 'new',
    };

    records.set(attribute, record);
    activeRecords.add(record);
    enqueueRecord(record);
  }

  function handleChangedTextNode(node) {
    const record = textRecordByNode.get(node);
    const current = String(node.nodeValue || '');
    if (record?.active && isRecordValueCurrent(record, current)) {
      applyRecordDisplay(record);
      return;
    }
    if (record) invalidateRecord(record);
    processOrDefer({ kind: 'text', node });
  }

  function handleChangedAttribute(element, attribute) {
    if (!TRANSLATABLE_ATTRIBUTES.includes(attribute)) return;
    const record = attributeRecordsByElement.get(element)?.get(attribute);
    const current = element.getAttribute(attribute) || '';
    if (record?.active && isRecordValueCurrent(record, current)) {
      applyRecordDisplay(record);
      return;
    }
    if (record) invalidateRecord(record);
    processOrDefer({ kind: 'attribute', element, attribute });
  }

  function enqueueRecord(record) {
    const cacheKey = makeCacheKey(record.source);
    const groupKey = `${record.sensitive ? 'sensitive' : 'public'}\u0000${cacheKey}`;
    const cached = record.sensitive ? null : cacheGet(cacheKey);
    if (cached) {
      incrementStat('cacheHits', 1);
      saveStats();
      completeRecord(record, cached.text);
      updateUi();
      return;
    }

    const inFlight = inFlightGroups.get(groupKey);
    if (inFlight) {
      inFlight.records.add(record);
      record.status = 'pending';
      return;
    }

    let group = pendingGroups.get(groupKey);
    if (!group) {
      group = {
        groupKey,
        cacheKey,
        text: record.source,
        records: new Set(),
        generation: routeGeneration,
        sensitive: record.sensitive,
      };
      pendingGroups.set(groupKey, group);
    }
    group.records.add(record);
    record.status = 'pending';
    scheduleBatch();
  }

  function scheduleBatch(delayMs = CONFIG.batchDelayMs) {
    if (batchTimer || activeRequest || pendingGroups.size === 0) return;
    batchTimer = window.setTimeout(() => {
      batchTimer = null;
      void flushBatch();
    }, delayMs);
  }

  async function flushBatch() {
    if (!canTranslateNow() || activeRequest || pendingGroups.size === 0 || document.hidden) return;

    const groups = [];
    let batchCharacters = 0;

    for (const [groupKey, group] of pendingGroups) {
      removeStaleRecords(group);
      if (group.records.size === 0) {
        pendingGroups.delete(groupKey);
        continue;
      }

      const length = Array.from(group.text).length;
      if (
        groups.length >= CONFIG.maxBatchTexts ||
        (groups.length > 0 && batchCharacters + length > CONFIG.maxBatchCharacters)
      ) {
        break;
      }

      if (pageCharacterLimit > 0 && pageSentCharacters + batchCharacters + length > pageCharacterLimit) {
        pendingGroups.delete(groupKey);
        for (const record of group.records) record.status = 'limit';
        if (!pageLimitToastShown) {
          pageLimitToastShown = true;
          showToast(
            `이 페이지의 새 번역 한도(${formatLimit(pageCharacterLimit)})에 도달했습니다. 설정에서 늘릴 수 있습니다.`,
            'warning',
            9000,
          );
        }
        continue;
      }

      pendingGroups.delete(groupKey);
      inFlightGroups.set(groupKey, group);
      groups.push(group);
      batchCharacters += length;
    }

    if (groups.length === 0) {
      updateUi();
      return;
    }

    activeRequest = true;
    const batchRequestEpoch = requestEpoch;
    const authKeySnapshot = apiKey;
    pageSentCharacters += batchCharacters;
    updateUi();

    try {
      const translations = await translateTexts(
        groups.map((group) => group.text),
        { authKey: authKeySnapshot, requestToken: batchRequestEpoch },
      );
      if (batchRequestEpoch !== requestEpoch) throw new StaleRequestError();
      if (translations.length !== groups.length) {
        throw new ApiError(0, 'DeepL 응답의 번역 개수가 요청 개수와 다릅니다.');
      }

      for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        const result = translations[index];
        const translated = cleanText(String(result.text || ''));

        incrementStat('apiTexts', 1);
        incrementStat(
          'billedCharacters',
          Number.isFinite(Number(result.billed_characters))
            ? Number(result.billed_characters)
            : Array.from(group.text).length,
        );
        if (result.model_type_used) setLastModelUsed(String(result.model_type_used));

        if (translated) {
          if (!group.sensitive) {
            cacheSet(group.cacheKey, { text: translated, savedAt: Date.now() });
          }
          for (const record of group.records) completeRecord(record, translated);
        } else {
          for (const record of group.records) record.status = 'error';
        }
      }
      saveStats();
    } catch (error) {
      if (!(error instanceof StaleRequestError)) handleBatchError(error, groups);
    } finally {
      for (const group of groups) inFlightGroups.delete(group.groupKey);
      activeRequest = false;
      updateUi();
      if (pendingGroups.size > 0) scheduleBatch(40);
    }
  }

  async function translateTexts(texts, authContext) {
    const body = {
      text: texts,
      source_lang: SOURCE_LANGUAGE,
      target_lang: TARGET_LANGUAGE,
      model_type: MODEL_TYPE,
      context: SHOPPING_CONTEXT,
      split_sentences: '1',
      preserve_formatting: false,
      show_billed_characters: true,
    };

    if (glossaryId) body.glossary_id = glossaryId;
    const attemptedCustomInstructions = customInstructionsAvailable;
    if (attemptedCustomInstructions) body.custom_instructions = [...CUSTOM_INSTRUCTIONS];

    try {
      return await requestTranslations(body, authContext);
    } catch (originalError) {
      // 구형/제한 계정이 맞춤 지시만 거절하는 경우에도 품질 모델은 유지합니다.
      if (
        attemptedCustomInstructions &&
        originalError instanceof ApiError &&
        originalError.status === 400
      ) {
        delete body.custom_instructions;
        try {
          const fallback = await requestTranslations(body, authContext);
          customInstructionsAvailable = false;
          showToast(
            '이 계정은 맞춤 번역 지시를 받지 않아 지시만 제외했습니다. 최고 품질 모델은 그대로 사용합니다.',
            'warning',
            8000,
          );
          return fallback;
        } catch (fallbackError) {
          if (fallbackError instanceof StaleRequestError) throw fallbackError;
          throw originalError;
        }
      }
      throw originalError;
    }
  }

  async function requestTranslations(body, { authKey, requestToken }) {
    let lastError = null;

    for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt += 1) {
      if (requestToken !== requestEpoch) throw new StaleRequestError();
      try {
        const response = await requestDeepL({
          method: 'POST',
          path: '/v2/translate',
          body,
          authKey,
        });
        if (requestToken !== requestEpoch) throw new StaleRequestError();
        const parsed = parseJson(response.responseText);

        if (response.status === 200) {
          if (!parsed || !Array.isArray(parsed.translations)) {
            throw new ApiError(0, 'DeepL 응답을 해석하지 못했습니다.');
          }
          return parsed.translations;
        }

        const error = new ApiError(
          response.status,
          getApiErrorMessage(parsed, response.status),
        );

        if ([429, 500, 529].includes(response.status) && attempt < CONFIG.maxRetries) {
          lastError = error;
          await sleep(700 * 2 ** attempt + Math.floor(Math.random() * 300));
          continue;
        }
        throw error;
      } catch (error) {
        if (error instanceof StaleRequestError || requestToken !== requestEpoch) {
          throw new StaleRequestError();
        }
        if (error instanceof ApiError && error.status === 0 && attempt < CONFIG.maxRetries) {
          lastError = error;
          await sleep(700 * 2 ** attempt + Math.floor(Math.random() * 300));
          continue;
        }
        throw error;
      }
    }

    throw lastError || new ApiError(0, '알 수 없는 네트워크 오류입니다.');
  }

  function requestDeepL({ method, path, body = null, authKey = apiKey }) {
    const origin = authKey.endsWith(':fx')
      ? 'https://api-free.deepl.com'
      : 'https://api.deepl.com';

    return new Promise((resolve, reject) => {
      let requestHandle = null;
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        if (requestHandle) activeGmRequests.delete(requestHandle);
        callback(value);
      };

      try {
        requestHandle = GM_xmlhttpRequest({
          method,
          url: `${origin}${path}`,
          headers: {
            Authorization: `DeepL-Auth-Key ${authKey}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          data: body ? JSON.stringify(body) : undefined,
          timeout: CONFIG.requestTimeoutMs,
          anonymous: true,
          onload: (response) => settle(resolve, response),
          onerror: () => settle(reject, new ApiError(0, 'DeepL 네트워크 요청에 실패했습니다.')),
          ontimeout: () => settle(reject, new ApiError(0, 'DeepL 응답 시간이 초과되었습니다.')),
          onabort: () => settle(reject, new ApiError(0, 'DeepL 요청이 취소되었습니다.')),
        });
        if (!settled && requestHandle?.abort) activeGmRequests.add(requestHandle);
      } catch (error) {
        settle(reject, new ApiError(0, error instanceof Error ? error.message : '요청 생성 실패'));
      }
    });
  }

  function cancelTranslationWork(nextStatus = 'paused') {
    requestEpoch += 1;

    for (const collection of [pendingGroups, inFlightGroups]) {
      for (const group of collection.values()) {
        for (const record of group.records) {
          if (record.active && !record.translatedFull) record.status = nextStatus;
        }
      }
      collection.clear();
    }

    if (batchTimer) {
      window.clearTimeout(batchTimer);
      batchTimer = null;
    }

    for (const requestHandle of Array.from(activeGmRequests)) {
      try {
        requestHandle.abort();
      } catch {
        // 이미 완료된 요청은 무시합니다.
      }
    }
    activeGmRequests.clear();
  }

  function handleBatchError(error, groups) {
    for (const group of groups) {
      for (const record of group.records) {
        if (record.active) record.status = 'error';
      }
    }

    const status = error instanceof ApiError ? error.status : 0;
    const detail = error instanceof Error ? error.message : String(error);

    if (status === 403) {
      enabled = false;
      cancelTranslationWork('error');
      GM_setValue(STORAGE.enabled, false);
      showToast(
        'DeepL 인증에 실패해 자동 번역을 중지했습니다(403). API 키와 Free/유료 API 종류를 확인하세요.',
        'error',
        12000,
      );
      return;
    }

    if (status === 456) {
      enabled = false;
      cancelTranslationWork('error');
      GM_setValue(STORAGE.enabled, false);
      showToast('DeepL 월간 문자 또는 비용 한도에 도달해 자동 번역을 중지했습니다(456).', 'error', 0);
      return;
    }

    if (status === 400 && glossaryId) {
      showToast(
        '요청이 거절되었습니다(400). 설정한 용어집이 ZH→KO용인지, ID가 정확한지 확인하세요.',
        'error',
        11000,
      );
      return;
    }

    const now = Date.now();
    if (now - lastErrorToastAt > 12000) {
      lastErrorToastAt = now;
      showToast(`DeepL 번역 오류${status ? ` (${status})` : ''}: ${detail}`, 'error', 9000);
    }
  }

  function completeRecord(record, translated) {
    if (!isRecordUsable(record)) return;
    record.translatedFull = `${record.leading}${translated}${record.trailing}`;
    record.status = 'done';
    applyRecordDisplay(record);
  }

  function applyRecordDisplay(record) {
    if (!isRecordUsable(record)) {
      invalidateRecord(record);
      return;
    }

    const current = getRecordValue(record);
    if (!isRecordValueCurrent(record, current)) {
      invalidateRecord(record);
      return;
    }

    const next = showTranslation && record.translatedFull
      ? record.translatedFull
      : record.sourceFull;
    if (current === next) return;
    setRecordValue(record, next);
  }

  function getRecordValue(record) {
    if (record.kind === 'text') return String(record.node.nodeValue || '');
    return record.element.getAttribute(record.attribute) || '';
  }

  function setRecordValue(record, value) {
    if (record.kind === 'text') record.node.nodeValue = value;
    else record.element.setAttribute(record.attribute, value);
  }

  function isRecordValueCurrent(record, value) {
    return value === record.sourceFull || Boolean(record.translatedFull && value === record.translatedFull);
  }

  function isRecordUsable(record) {
    if (!record?.active || record.generation !== routeGeneration) return false;
    return record.kind === 'text'
      ? Boolean(record.node?.isConnected)
      : Boolean(record.element?.isConnected);
  }

  function invalidateRecord(record) {
    if (!record) return;
    record.active = false;
    activeRecords.delete(record);
    if (record.kind === 'text') {
      if (textRecordByNode.get(record.node) === record) textRecordByNode.delete(record.node);
    } else {
      const records = attributeRecordsByElement.get(record.element);
      if (records?.get(record.attribute) === record) records.delete(record.attribute);
    }
  }

  function invalidateAllTranslations() {
    for (const record of Array.from(activeRecords)) {
      if (record.active && getRecordValue(record) === record.translatedFull) {
        setRecordValue(record, record.sourceFull);
      }
      invalidateRecord(record);
    }
    pendingGroups.clear();
    for (const element of deferredByElement.keys()) {
      intersectionObserver?.unobserve(element);
    }
    deferredByElement.clear();
  }

  function retryUntranslatedRecords() {
    for (const record of Array.from(activeRecords)) {
      if (
        !record.active ||
        record.translatedFull ||
        !['limit', 'error', 'new', 'paused'].includes(record.status)
      ) continue;
      enqueueRecord(record);
    }
    scheduleBatch(30);
  }

  function removeStaleRecords(group) {
    for (const record of Array.from(group.records)) {
      if (!isRecordUsable(record)) group.records.delete(record);
    }
  }

  function pruneDisconnectedState() {
    for (const record of Array.from(activeRecords)) {
      if (!isRecordUsable(record)) invalidateRecord(record);
    }
    for (const [element] of deferredByElement) {
      if (!element.isConnected) {
        deferredByElement.delete(element);
        intersectionObserver?.unobserve(element);
      }
    }
  }

  function handlePossibleRouteChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const nextLogicalRouteKey = getLogicalRouteKey();
    if (nextLogicalRouteKey === lastLogicalRouteKey) {
      updateUi();
      return;
    }

    lastLogicalRouteKey = nextLogicalRouteKey;
    routeGeneration += 1;
    pageSentCharacters = 0;
    pageLimitToastShown = false;
    allowSensitivePageForSession = false;
    invalidateAllTranslations();
    updateUi();

    if (canTranslateNow()) {
      window.setTimeout(() => scheduleScan(document.body || document.documentElement), 250);
    }
  }

  function canTranslateNow() {
    return Boolean(
      enabled &&
      apiKey &&
      !document.hidden &&
      !isSensitivePageBlocked(),
    );
  }

  function isSensitivePageBlocked() {
    return isSensitivePage() && !allowSensitivePageForSession;
  }

  function isSensitivePage() {
    const firstHostPart = location.hostname.toLowerCase().split('.')[0];
    if (SENSITIVE_HOST_PARTS.has(firstHostPart)) return true;

    const sensitivePrefixes = [
      'account', 'address', 'buyer', 'chat', 'login', 'member', 'message',
      'my', 'order', 'pay', 'profile', 'refund', 'security', 'setting', 'trade',
    ];
    return location.pathname
      .toLowerCase()
      .split('/')
      .filter(Boolean)
      .some((segment) => sensitivePrefixes.some((prefix) => segment.startsWith(prefix)));
  }

  function getLogicalRouteKey() {
    const url = new URL(location.href);
    const identityNames = ['id', 'itemId', 'item_id', 'auctionId', 'q', 'keyword', 'cat'];
    const identity = identityNames
      .map((name) => [name, url.searchParams.get(name)])
      .filter(([, value]) => value)
      .map(([name, value]) => `${name}=${value}`)
      .join('&');
    return `${url.origin}${url.pathname}${identity ? `?${identity}` : ''}`;
  }

  function isExcludedElement(element) {
    if (!(element instanceof Element)) return true;
    if (element.id === UI_HOST_ID || element.closest(`#${UI_HOST_ID}`)) return true;
    if (SKIPPED_TAGS.has(element.tagName)) return true;
    if (element.closest(SKIPPED_ANCESTOR_SELECTOR)) return true;
    if (element.isContentEditable || element.closest('[contenteditable="true"]')) return true;
    if (element.closest('[translate="no"], [data-tm-taobao-deepl-ui]')) return true;
    return false;
  }

  function isNearViewport(element) {
    if (!element?.isConnected) return false;

    let target = element;
    let rect = target.getBoundingClientRect();
    for (let depth = 0; depth < 3 && rect.width === 0 && rect.height === 0; depth += 1) {
      target = target.parentElement;
      if (!target) break;
      rect = target.getBoundingClientRect();
    }

    if (!target || (rect.width === 0 && rect.height === 0)) return false;
    const style = window.getComputedStyle(target);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;

    const margin = CONFIG.intersectionMarginPx;
    return (
      rect.bottom >= -margin &&
      rect.top <= window.innerHeight + margin &&
      rect.right >= -margin &&
      rect.left <= window.innerWidth + margin
    );
  }

  function shouldTranslate(text) {
    if (!text || !hasChinese(text)) return false;
    const length = Array.from(text).length;
    if (length < 1 || length > CONFIG.maxTextCharacters) return false;
    if (/^(?:https?:\/\/|www\.)\S+$/iu.test(text)) return false;
    if (/^[\p{N}\p{P}\p{S}\p{Z}]+$/u.test(text)) return false;
    return true;
  }

  function hasChinese(text) {
    return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(text);
  }

  function splitOuterWhitespace(value) {
    const leading = value.match(/^\s*/u)?.[0] || '';
    const trailing = value.match(/\s*$/u)?.[0] || '';
    const end = trailing.length ? value.length - trailing.length : value.length;
    return { leading, core: value.slice(leading.length, end), trailing };
  }

  function cleanText(text) {
    return String(text || '')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .normalize('NFKC');
  }

  function makeCacheKey(text) {
    return `${CACHE_VERSION}\u0000${MODEL_TYPE}\u0000${glossaryId || '-'}\u0000${text}`;
  }

  function loadCache() {
    const stored = GM_getValue(STORAGE.cache, []);
    if (!Array.isArray(stored)) return new Map();

    const cutoff = Date.now() - CONFIG.cacheTtlMs;
    const valid = stored.filter(
      (entry) =>
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        isCurrentCacheKey(entry[0]) &&
        entry[1] &&
        typeof entry[1].text === 'string' &&
        Number(entry[1].savedAt) >= cutoff,
    );
    if (valid.length !== stored.length) GM_setValue(STORAGE.cache, valid);
    return new Map(valid.slice(-CONFIG.cacheLimit));
  }

  function mergeCacheEntries(stored) {
    if (!Array.isArray(stored)) return;
    const cutoff = Date.now() - CONFIG.cacheTtlMs;

    for (const entry of stored) {
      if (
        !Array.isArray(entry) ||
        typeof entry[0] !== 'string' ||
        !isCurrentCacheKey(entry[0]) ||
        !entry[1] ||
        typeof entry[1].text !== 'string' ||
        Number(entry[1].savedAt) < cutoff
      ) continue;

      const current = cache.get(entry[0]);
      if (!current || Number(entry[1].savedAt) > Number(current.savedAt)) {
        cache.delete(entry[0]);
        cache.set(entry[0], entry[1]);
      }
    }
    while (cache.size > CONFIG.cacheLimit) cache.delete(cache.keys().next().value);
  }

  function isCurrentCacheKey(key) {
    return key.startsWith(`${CACHE_VERSION}\u0000`);
  }

  function cacheGet(key) {
    const value = cache.get(key);
    if (!value) return null;
    if (Date.now() - Number(value.savedAt) > CONFIG.cacheTtlMs) {
      cache.delete(key);
      scheduleCacheSave();
      return null;
    }

    cache.delete(key);
    cache.set(key, value);
    scheduleCacheSave();
    return value;
  }

  function cacheSet(key, value) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > CONFIG.cacheLimit) cache.delete(cache.keys().next().value);
    scheduleCacheSave();
  }

  function scheduleCacheSave() {
    if (cacheSaveTimer) return;
    cacheSaveTimer = window.setTimeout(() => {
      cacheSaveTimer = null;
      saveCacheNow();
    }, CONFIG.cacheSaveDelayMs);
  }

  function saveCacheNow() {
    if (cacheSaveTimer) {
      window.clearTimeout(cacheSaveTimer);
      cacheSaveTimer = null;
    }
    const latestEpoch = normalizeCacheEpoch(GM_getValue(STORAGE.cacheEpoch, 0));
    if (latestEpoch !== cacheEpoch) {
      cacheEpoch = latestEpoch;
      cache.clear();
      updateUi();
      return;
    }

    mergeCacheEntries(GM_getValue(STORAGE.cache, []));
    GM_setValue(STORAGE.cache, Array.from(cache.entries()));
  }

  function loadStats() {
    const stored = GM_getValue(STORAGE.stats, {});
    return {
      startedAt: Number(stored?.startedAt) || Date.now(),
      apiTexts: Number(stored?.apiTexts) || 0,
      billedCharacters: Number(stored?.billedCharacters) || 0,
      cacheHits: Number(stored?.cacheHits) || 0,
      lastModelUsed: String(stored?.lastModelUsed || ''),
    };
  }

  function saveStats() {
    if (statsSaveTimer) return;
    statsSaveTimer = window.setTimeout(() => {
      statsSaveTimer = null;
      saveStatsNow();
    }, CONFIG.statsSaveDelayMs);
  }

  function saveStatsNow() {
    if (statsSaveTimer) {
      window.clearTimeout(statsSaveTimer);
      statsSaveTimer = null;
    }

    const latest = GM_getValue(STORAGE.stats, {});
    const merged = {
      startedAt: Math.min(
        Number(latest?.startedAt) || stats.startedAt,
        Number(stats.startedAt) || Date.now(),
      ),
      apiTexts: (Number(latest?.apiTexts) || 0) + statsDelta.apiTexts,
      billedCharacters:
        (Number(latest?.billedCharacters) || 0) + statsDelta.billedCharacters,
      cacheHits: (Number(latest?.cacheHits) || 0) + statsDelta.cacheHits,
      lastModelUsed:
        statsDelta.lastModelUsed || String(latest?.lastModelUsed || stats.lastModelUsed || ''),
    };

    Object.assign(stats, merged);
    statsDelta.apiTexts = 0;
    statsDelta.billedCharacters = 0;
    statsDelta.cacheHits = 0;
    statsDelta.lastModelUsed = '';
    GM_setValue(STORAGE.stats, merged);
  }

  function incrementStat(name, amount) {
    const value = Number(amount) || 0;
    stats[name] = (Number(stats[name]) || 0) + value;
    statsDelta[name] = (Number(statsDelta[name]) || 0) + value;
  }

  function setLastModelUsed(model) {
    stats.lastModelUsed = model;
    statsDelta.lastModelUsed = model;
  }

  function normalizeCacheEpoch(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  function normalizePageLimit(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 10000000
      ? parsed
      : CONFIG.defaultPageCharacterLimit;
  }

  function parseJson(text) {
    try {
      return JSON.parse(text || '{}');
    } catch {
      return null;
    }
  }

  function getApiErrorMessage(parsed, status) {
    const raw = parsed?.message || parsed?.detail || `HTTP ${status || '오류'}`;
    return cleanText(String(raw)).slice(0, 350);
  }

  function runWhenIdle(callback) {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(callback, { timeout: 600 });
    } else {
      window.setTimeout(callback, 0);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('ko-KR').format(Number(value) || 0);
  }

  function formatLimit(value) {
    return Number(value) === 0 ? '무제한' : `${formatNumber(value)}자`;
  }

  function formatLargeLimit(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '정보 없음';
    if (number >= 1000000000000) return '설정 안 됨';
    return `${formatNumber(number)}자`;
  }

  function showToast(message, type = 'info', durationMs = 4500) {
    const oldToast = document.querySelector('[data-tm-taobao-deepl-toast]');
    if (oldToast) oldToast.remove();

    const toast = document.createElement('div');
    toast.setAttribute('data-tm-taobao-deepl-toast', '1');
    toast.setAttribute('translate', 'no');
    toast.textContent = `${SCRIPT_NAME}: ${message}`;

    const colors = {
      info: ['#1d2533', '#dbe8ff'],
      success: ['#143824', '#8ce4ad'],
      warning: ['#443410', '#ffd987'],
      error: ['#491a21', '#ffabb5'],
    };
    const [background, color] = colors[type] || colors.info;

    Object.assign(toast.style, {
      position: 'fixed',
      zIndex: '2147483647',
      right: '16px',
      bottom: '68px',
      maxWidth: '430px',
      padding: '11px 13px',
      border: `1px solid ${color}`,
      borderRadius: '10px',
      boxShadow: '0 8px 28px rgba(0, 0, 0, .35)',
      background,
      color,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: '13px',
      fontWeight: '600',
      lineHeight: '1.45',
      whiteSpace: 'pre-wrap',
    });

    (document.body || document.documentElement).appendChild(toast);
    if (durationMs > 0) window.setTimeout(() => toast.remove(), durationMs);
  }

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  class StaleRequestError extends Error {
    constructor() {
      super('더 이상 유효하지 않은 번역 요청입니다.');
      this.name = 'StaleRequestError';
    }
  }
})();
