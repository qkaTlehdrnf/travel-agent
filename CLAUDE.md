# 여행 Agent 앱 (개인용 안드로이드)

사용자 김원중이 여행 중 쓰는 앱. 원칙: 결론·숫자 먼저, 확인 안 된 정보 단정 금지, LLM 없는 빠른 경로 우선, 할 수 없는 일 약속 금지, 결제·설치는 사용자가 직접.

## 구조
- `android/` 얇은 WebView 껍데기 (Java 8, API 23 SDK로 컴파일, targetSdk 30). 음성 인식·TTS·알람·외부 앱 열기·자동 업데이트를 `window.Android` 브리지로 제공.
- `web/` 실제 화면. `https://qkatlehdrnf.github.io/travel-agent/` 로 배포되고, 앱은 `version.json` 의 `build` 가 오르면 파일을 받아 즉시 다시 그린다. **화면 수정은 APK 재설치 없이 반영된다.**
- `web/app.js` 화면·라우터, `web/packs.js` 국가 팩(지도 앱·승강장 표기·권장 앱).
- 데이터: OSM(Overpass/Nominatim), Wikimedia Commons, 선택적으로 Google Places·Anthropic API(키는 폰에만 저장).

## 앱 요청 처리 (`app-request` 라벨 이슈)
사용자가 앱의 "요청" 버튼으로 적은 내용이 이 저장소 이슈로 들어온다. 처리 순서:
1. 열린 `app-request` 이슈를 오래된 순으로 읽는다. 처리 시작 시 `in-progress` 라벨을 단다.
2. 대부분은 `web/` 만 고친다. 고친 뒤 `node --check web/app.js` 와 Playwright로 화면을 한 번 띄워 콘솔 오류가 없는지 확인한다.
3. `python3 scripts/bump.py "한 줄 설명"` 으로 build 를 올리고 main 에 push → Pages 워크플로가 배포 → 폰 앱이 다음 실행/복귀 때 자동 적용.
4. 네이티브 기능(새 권한, 백그라운드 작업 등)이 필요하면 `android/` 수정 + `python3 scripts/bump.py "설명" --apk`. APK 워크플로가 릴리스를 만들고, 앱의 "할 일" 탭에 설치 안내가 뜬다.
5. 이슈에 무엇을 바꿨는지 한두 줄 댓글(첫 줄이 앱에 그대로 보임)을 남기고 닫는다. 애매하면 추측해서 크게 바꾸지 말고 질문 댓글을 남기고 열어 둔다.
6. 결제·예약 실행, 사용자 대신 외부로 메시지 보내기 같은 기능은 만들지 않는다(승인 후 사용자가 직접 하는 흐름만).

## 로컬 빌드
`./build.sh` (apt: android-sdk-platform-23 aapt zipalign apksigner dalvik-exchange). 서명 키는 저장소에 없다(Actions secret `KEYSTORE_B64`/`KEYSTORE_PASS`).
