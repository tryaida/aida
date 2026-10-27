# Plain-language style guide

For anything a reader of the help site, chat or video sees: page text, narration, captions,
outline cards, chat answers.

## Vocabulary

Use these words. Don't use their internal/technical equivalents in anything user-facing:

| Say | Don't say |
| --- | --- |
| walkthrough | IR, intermediate representation, flow definition, the step file's old format name |
| help site | docs site, knowledge base (unless the reader already uses that term) |
| help chat | chatbot, support bot |
| agent connector | the generator MCP server, "the MCP" |
| Studio | the editor, the CMS |

Don't expose internal jargon either: "journey" (say "walkthrough" or "task"), "manifest",
"capture dir", "digest", or the name of the original pipeline's step-file format. Those are fine in
engineering conversation, never in text a reader or reviewer sees.

## Voice

- Plain words, short sentences. Say what to click using the exact on-screen label, in **bold**.
- Second person ("you"), present tense, active voice.
- One instruction per sentence. No filler ("simply", "just", "easily").
- Say why a step matters only when it helps the reader decide, not to pad length.
- Never invent a feature, button or result that wasn't seen working in a real capture.

## Narration vs. caption vs. page text

- `say`: spoken narration — conversational, can use contractions ("they're", "it's").
- `caption`: on-screen caption for the video — same meaning as `say`, trimmed to fit a line or two,
  spelling out anything a text-to-speech engine would mangle (brand names, abbreviations).
- `page_text`: the help page's written instruction — can be denser than narration, uses **bold**
  for the exact on-screen label and `inline code` only for literal values the reader types.

## Review

`aida-review` checks tone against this file and flags: wrong vocabulary, invented features,
missing bold on clickable labels, and sentences that assume knowledge the reader doesn't have yet.
