# Existing solutions (landscape)

Researched 2026-10-22 from vendor pages, launch posts and comparison articles. None of these were used
hands-on; treat feature claims as vendor claims until tested.

**Finding:** many tools cover one part. None covers the whole set: end-user docs generated from the
repo *and* the running app, printable pages, narrated video, chat, an MCP server, any agent and any
voice provider, self-hostable, kept current from CI.

**Positioning:** an open, self-hosted Videate + Promptless + Mintlify that works with any agent and any
voice provider, and starts from the app itself.

## Docs that update themselves (written docs and screenshots)

| Tool | What it does | Gap for us |
| --- | --- | --- |
| [Promptless](https://promptless.ai/) (YC) | Watches PRs, Slack and tickets; drafts doc updates; uses a test account to re-capture screenshots with crops and annotations; checks existing screenshots on any page it edits; tag it on a PR or issue | No video; writes into your existing doc platform instead of providing one |
| [Mintlify](https://www.mintlify.com/docs/ai-native) | Docs platform with reader assistant, Search MCP server, Admin MCP server, and Autopilot that opens PRs when code changes make docs stale | Developer/API-docs focus; no video or app capture |
| [DocuWriter](https://www.docuwriter.ai/), [Documentation.AI](https://documentation.ai/) | Generate docs from the codebase and keep them in sync | Mostly code/architecture docs, not end-user how-tos |
| [GitBook](https://www.gitbook.com/blog/best-ai-documentation-tools), [Document360](https://document360.com/blog/ai-documentation-trends/) | Established doc platforms with AI search and writing help | AI added on; no capture from the app |

## Video tutorials that update themselves

| Tool | What it does | Gap for us |
| --- | --- | --- |
| [Videate](https://www.videate.io/automated-video-production) | Hooks into the app at code level, detects UI changes, re-renders how-to videos and screenshots, turns docs into videos in several languages | Closest commercial match for video; enterprise-priced and closed |
| [Trupeer](https://www.trupeer.ai/tools/auto-updating-documentation-tool) | Screen recording becomes video plus article; can re-record a single changed step | Recording-based |
| [StorytoDoc](https://storytodoc.ai/post/ai-documentation-tool-complete-guide) | Video guides plus articles; one-click re-record | Recording-based |
| [Guidde](https://www.guidde.com/knowledge-hub/ai-documentation-generator-guide-2026), Scribe | Click-through capture into guides | A person re-records when the UI changes ([comparison](https://ferndesk.com/blog/scribe-alternatives)); not CI-friendly |

## Open-source building blocks

| Project | What it does | Use to us |
| --- | --- | --- |
| [Argo](https://github.com/shreyaskarnik/argo) | Playwright script + JSON manifest → MP4 with local Kokoro TTS, no API keys | Very close to the pilot pipeline AIDA started from; study its manifest before freezing the walkthrough format |
| [ProductVideoCreator](https://github.com/gordo-v1su4/ProductVideoCreator) | Agent skills combining Playwright, Remotion and edge-tts | Same skills-plus-scripts shape |
| howTo-Recorder ([topic list](https://github.com/topics/ai-voiceover?o=asc&s=updated)) | YAML scenarios → how-to videos with animated cursor and title cards | Format reference |
| [Doc Detective](https://www.docsastests.com/validate-ui-with-doc-detective) | Docs as tests: runs documented procedures against UI and API; [GitHub Actions](https://www.docsastests.com/ci-with-github-actions) | Model for the CI staleness check |
| [repowise](https://repowise.dev/blog/comparisons/best-codebase-documentation-tools-ai-agents), [ai-doc-gen](https://github.com/divar-ir/ai-doc-gen), DeepWiki | Wikis built from code, with MCP for agents | Developer-facing, not end-user; DeepWiki's URL swap is a growth idea |
| HyperFrames (installed locally as skills) | HTML video compositions; Studio with preview and timeline; agent, Studio and hand edits on one source; undoable history; review loop | Model for the editing experience; candidate video renderer |

## Build vs reuse

- **Reuse:** Playwright, Astro Starlight or Fumadocs, Doc Detective's ideas, possibly HyperFrames.
- **Study:** Argo's manifest before locking the walkthrough format.
- **Optional publish target:** Mintlify, for teams already on it.
- **Build:** the walkthrough format, the demo-env contract, CI change tiers, provider adapters, the Studio.
