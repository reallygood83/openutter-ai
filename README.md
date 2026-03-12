# OpenUtter AI

Google Meet AI 대화 에이전트 — 미팅에 참여하고, 자막을 캡처하고, AI로 응답합니다.

A Google Meet AI conversation agent — join meetings, capture captions, and respond with AI.

---

## Architecture / 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│                    OpenUtter AI Bot                      │
│                                                         │
│  ┌──────────┐  ┌────────────────┐  ┌─────────────────┐  │
│  │  Config   │  │   Meet Bot     │  │  Caption        │  │
│  │  Parser   │──│  (Playwright)  │──│  Capture        │  │
│  └──────────┘  │                │  │  (MutationObs)  │  │
│                │  - Stealth     │  └────────┬────────┘  │
│                │  - Join/Leave  │           │            │
│                │  - Overlays    │    finalized caption   │
│                └───────┬────────┘           │            │
│                        │                   ▼            │
│                        │           ┌──────────────┐     │
│                        │           │ AI Responder  │     │
│                        │           │ (OpenAI Chat) │     │
│                        │           └──────┬───────┘     │
│                        │                  │             │
│                        │           ┌──────▼───────┐     │
│                        │           │  TTS Engine   │     │
│                        │           │ (OpenAI TTS)  │     │
│                        │           └──────┬───────┘     │
│                        │                  │             │
│                        │           ┌──────▼───────┐     │
│                        │           │Audio Injector │     │
│                        └───────────│(Virtual Mic)  │     │
│                                    └──────────────┘     │
│                                                         │
│  Browser (Chromium via Playwright)                       │
│  ┌─────────────────────────────────────────────────┐    │
│  │  getUserMedia patched → Virtual AudioContext     │    │
│  │  MutationObserver → Caption DOM → Node.js IPC   │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## How It Works / 작동 원리

1. **Playwright**로 Chromium 브라우저를 실행하고 Google Meet에 참여합니다.
2. Stealth 패치로 자동화 감지를 우회합니다.
3. **MutationObserver**가 실시간 자막을 캡처하여 Node.js로 전달합니다.
4. AI 모드 활성화 시:
   - 자막이 확정되면 (발화 후 5초 무음) **OpenAI Chat API**로 응답을 생성합니다.
   - **OpenAI TTS API**로 응답을 음성으로 변환합니다.
   - **가상 오디오 스트림**을 통해 음성을 미팅에 주입합니다.

---

## Installation / 설치

```bash
# Clone the repository
git clone https://github.com/your-org/openutter-ai.git
cd openutter-ai

# Install dependencies
npm install

# Install Playwright browser
npx playwright install chromium

# Copy environment file and add your OpenAI API key
cp .env.example .env
# Edit .env and set OPENAI_API_KEY
```

### Build / 빌드

```bash
npm run build
```

---

## Usage / 사용법

### Caption-only mode (AI 없이 자막만 캡처)

```bash
# Guest join / 게스트 참여
npx tsx src/index.ts https://meet.google.com/abc-defg-hij --anon --bot-name "Note Bot"

# Authenticated join / 인증된 참여
npx tsx src/index.ts https://meet.google.com/abc-defg-hij --auth
```

### AI conversation mode / AI 대화 모드

```bash
# AI responds to all speech
npx tsx src/index.ts https://meet.google.com/abc-defg-hij --anon --bot-name "AI Bot" --ai

# AI responds only when triggered with "@bot"
npx tsx src/index.ts https://meet.google.com/abc-defg-hij --anon --bot-name "AI Bot" --ai --ai-trigger "@bot"

# Custom model and voice
npx tsx src/index.ts https://meet.google.com/abc-defg-hij --anon --bot-name "AI Bot" \
  --ai --ai-model gpt-4o --ai-voice nova --ai-system-prompt "You are a Korean-English translator."
```

### After building / 빌드 후

```bash
npm run build
node dist/index.js https://meet.google.com/abc-defg-hij --anon --bot-name "AI Bot" --ai
```

---

## CLI Options / CLI 옵션

| Flag | Description / 설명 | Default |
|------|-------------------|---------|
| `<meet-url>` | Google Meet URL (required / 필수) | - |
| `--auth` | 저장된 Google 계정으로 참여 | - |
| `--anon` | 게스트로 참여 (`--bot-name` 필수) | - |
| `--bot-name <name>` | 봇 표시 이름 | `OpenUtter Bot` |
| `--headed` | 브라우저 창 표시 | `false` |
| `--camera` | 카메라 활성화 | `off` |
| `--mic` | 마이크 활성화 | `off` |
| `--verbose` | 자막 상세 로깅 | `false` |
| `--duration <time>` | 최대 미팅 시간 (예: `60m`, `2h`) | unlimited |
| `--channel <ch>` | 알림 채널 | - |
| `--target <id>` | 알림 대상 | - |

### AI Options / AI 옵션

| Flag | Description / 설명 | Default |
|------|-------------------|---------|
| `--ai` | AI 대화 모드 활성화 | `false` |
| `--ai-model <model>` | OpenAI 모델 | `gpt-4o-mini` |
| `--ai-system-prompt <prompt>` | 시스템 프롬프트 | `You are a helpful meeting assistant...` |
| `--ai-voice <voice>` | TTS 음성 (`alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`) | `alloy` |
| `--ai-trigger <keyword>` | 이 키워드가 포함된 발화에만 응답 | - (모든 발화에 응답) |

---

## Environment Variables / 환경 변수

| Variable | Description / 설명 | Required |
|----------|-------------------|----------|
| `OPENAI_API_KEY` | OpenAI API 키 | `--ai` 모드에서 필수 |

`.env` 파일에 설정하거나 셸에서 export 하세요.

---

## Authentication / 인증

Google 계정으로 참여하려면 먼저 인증을 설정하세요:

```bash
npx tsx scripts/utter-auth.ts
```

브라우저 창이 열리면 Google 계정에 로그인하고 터미널에서 Enter를 누르세요.
세션이 `~/.openutter/auth.json`에 저장됩니다.

---

## File Structure / 파일 구조

```
openutter-ai/
├── src/
│   ├── index.ts           # CLI entry point
│   ├── config.ts          # CLI argument parsing
│   ├── meet-bot.ts        # Main bot logic (join, caption, AI pipeline)
│   ├── caption-capture.ts # MutationObserver-based caption capture
│   ├── ai-responder.ts    # OpenAI Chat Completions integration
│   ├── tts-engine.ts      # OpenAI TTS integration
│   └── audio-injector.ts  # Virtual audio stream injection
├── scripts/               # Original standalone scripts (unchanged)
│   ├── utter-join.ts
│   ├── utter-auth.ts
│   ├── utter-transcript.ts
│   └── utter-screenshot.ts
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## Limitations & Troubleshooting / 제한사항 및 문제 해결

### Known Limitations / 알려진 제한사항

- **Google Meet 자막**: 영어가 기본입니다. 다른 언어는 Meet 설정에서 자막 언어를 변경해야 합니다.
- **AudioContext**: 헤드리스 모드에서 AudioContext가 suspended 상태일 수 있습니다. 브라우저가 자동으로 resume을 시도합니다.
- **응답 지연**: AI 응답 → TTS → 오디오 주입까지 2-5초 정도 소요됩니다.
- **동시 발화**: 여러 사람이 동시에 말하면 자막이 겹칠 수 있습니다.
- **Trigger 모드 권장**: `--ai-trigger`를 사용하면 불필요한 응답을 방지할 수 있습니다.

### Troubleshooting / 문제 해결

**"playwright-core not found"**
```bash
npm install
npx playwright install chromium
```

**"Can't join this video call"**
- 미팅 링크가 유효한지 확인하세요.
- `--headed` 플래그로 브라우저를 직접 확인하세요.
- 호스트가 게스트 참여를 허용했는지 확인하세요.

**자막이 캡처되지 않음**
- 미팅에서 누군가 말하고 있는지 확인하세요.
- `--verbose` 플래그로 자막 로그를 확인하세요.
- `--headed`로 브라우저에서 자막이 표시되는지 확인하세요.

**AI가 응답하지 않음**
- `.env`에 `OPENAI_API_KEY`가 설정되어 있는지 확인하세요.
- `--ai-trigger`를 사용 중이라면 해당 키워드가 발화에 포함되는지 확인하세요.
- `--verbose`로 AI 파이프라인 로그를 확인하세요.

**오디오가 들리지 않음**
- `--ai` 모드에서는 `--use-fake-device-for-media-stream`이 자동으로 비활성화됩니다.
- `--headed` 모드에서 가상 오디오가 제대로 설정되는지 확인하세요.

---

## License

ISC
