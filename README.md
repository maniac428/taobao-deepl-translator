# 타오바오·티몰 DeepL 한국어 번역기

타오바오와 티몰의 중국어 화면 텍스트를 DeepL API로 한국어 번역하는 개인용 Tampermonkey 스크립트입니다. 속도보다 번역 정확도를 우선해 `model_type: quality_optimized`를 사용합니다.

## 설치

1. 브라우저에 Tampermonkey를 설치합니다.
2. Tampermonkey 대시보드에서 새 스크립트를 만듭니다.
3. 기본 내용을 지우고 [`taobao-deepl-ko.user.js`](./taobao-deepl-ko.user.js)의 전체 내용을 붙여넣어 저장합니다.
4. 타오바오를 연 뒤 오른쪽 아래 **API 키 설정**에서 DeepL API 키를 입력합니다.

기존 API Free 키가 `:fx`로 끝나면 Free 엔드포인트를 자동으로 사용하며, 그 외 키는 표준 엔드포인트를 사용합니다.

## 주요 기능

- DeepL `quality_optimized` 및 중국어(ZH) → 한국어(KO) 고정
- 상품 페이지, 검색 결과, 무한 스크롤과 SPA 화면 변화 감지
- 화면 주변 우선 번역, 중복 요청 묶기와 최대 1개 동시 요청
- 원문/번역문 전환
- 30일·최대 4,000개 로컬 번역 캐시
- 페이지당 신규 번역 30,000자 기본 제한
- 선택적 ZH→KO DeepL 용어집
- DeepL 공식 사용량 조회
- 주문·주소·결제·계정·채팅 페이지 자동 번역 차단

## 보안과 비용 주의

`GM_xmlhttpRequest`는 브라우저 CORS를 우회할 뿐 API 키를 암호화하거나 숨기지 않습니다. 키는 스크립트 코드가 아닌 Tampermonkey 저장소에 보관되지만, 그 저장소도 운영체제의 비밀 금고는 아닙니다. 공개 배포나 여러 사람과 함께 사용할 때는 DeepL이 권장하는 백엔드 프록시를 사용하세요.

주문·주소 등 민감 화면은 기본 차단되며, 사용자가 이번 탭에서 번역을 허용하더라도 해당 원문과 번역문은 영구 캐시에 저장하지 않습니다.

비용 대비 효율을 위해 페이지당 30,000자 제한을 유지하는 것을 권장합니다. `0`으로 바꾸면 무제한이지만 무한 스크롤에서 사용량이 빠르게 증가할 수 있습니다.

## 한계

- 이미지·동영상·캔버스 안의 중국어는 OCR 기능이 없으므로 번역하지 않습니다.
- 닫힌 Shadow DOM 내부 텍스트는 접근할 수 없습니다.
- 제품 규격, 인증, 안전 정보와 구매 조건은 반드시 중국어 원문과 대조하세요.
- 사이트 구조 변경에 따라 일부 문구가 누락될 수 있습니다.

## 공식 문서

- [DeepL 모델 유형](https://developers.deepl.com/docs/translate/understanding-model-types)
- [Translate API](https://developers.deepl.com/api-reference/translate/request-translation)
- [브라우저 요청과 API 키 보안](https://developers.deepl.com/docs/best-practices/cors-requests)
- [사용량과 제한](https://developers.deepl.com/docs/resources/usage-limits)
