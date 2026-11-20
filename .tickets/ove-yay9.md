---
id: ove-yay9
status: open
deps: []
links: []
created: 2026-11-20T19:03:33Z
type: task
priority: 3
assignee: cc-vps
parent: ove-v5c6
---
# Prices: keep only text-output models in the OpenAI/Google tables (use models.dev modalities)

Review of the ove-f6hn PR (#113): the generator filters OpenAI/Google models by id words (image, realtime, audio, tts, ...), which lets a video-only model such as gemini-omni-flash-preview into GOOGLE_PRICES with its video-output rate. No coding harness uses it today, so nothing is mispriced in practice. Fix: filter by models.dev's modalities (text output), with a test for entries missing that metadata (keep them, or decide explicitly).

