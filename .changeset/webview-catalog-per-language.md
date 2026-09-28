---
'forgejo-toolkit': patch
---

Split the webview message catalog by language so no surface downloads the language it is not showing. The English catalog stays a static import — it is the base language and the fallback — while the Chinese one becomes its own chunk behind a literal dynamic import that no surface preloads, which removes the Chinese strings from the shared vendor chunk every panel loads. Language switching stays atomic: a new catalog is loaded before it is published, a superseded request is discarded, the old language keeps rendering while the new one loads (a raw key is never shown), and a failed load keeps the old language. A build-time assertion fails if a catalog that must stay lazy turns back into a static import.
