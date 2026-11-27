# NEXUS: FRONTLINE

미래형 전략 타워 디펜스. 지시서 v2.1 기준 수직 슬라이스(캠페인 1장)를 만든다.

현재 단계: **Phase 2 완료** — 단순 도형 전투 루프(1장 1~10웨이브, 유닛 4종), 터치 조작, 헤드리스 시뮬레이션. 상태와 다음 할 일은 `docs/progress.md`.

```bash
npm install
npm run dev        # 게임: http://127.0.0.1:5190/  · 시안 시트: /dev/sheet.html
npm run typecheck
npm test           # 결정론·재생·데이터 검사
npm run sim        # 헤드리스 밸런스 표
node tests/touch.mjs   # 터치 검수 + 10웨이브 완주 (dev 서버 필요)
```

| 문서 | 내용 |
| --- | --- |
| `docs/design.md` | 유닛·업그레이드·경제·적·보스·맵·웨이브 수치 |
| `docs/story.md` | 세계관, 인물, 6장 줄거리, 복선, 결말, 1장 텍스트 |
| `docs/art.md` | 형태·색·재질·UI·모션 규칙과 검수 방법 |
| `docs/decisions.md` | 지시서와 다르게 정했거나 지시서가 정하지 않은 것 |
| `docs/progress.md` | 현재 상태와 다음 작업 |
| `docs/playtest.md` | 실기기에서 사람이 확인할 것 |
