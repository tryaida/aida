# Kokoro (vendored)

The Kokoro text-to-speech runner from [kokoro-js](https://github.com/hexgrad/kokoro/tree/main/kokoro.js)
1.2.1 (Apache-2.0, see `LICENSE`), source at commit `d4ef0569c79046dfd77fbb128502546a3afe5bef`.

Vendored so AIDA can run it on `@huggingface/transformers` 4: kokoro-js 1.2.1 pins transformers 3,
whose image library (`sharp` 0.34) carries security advisories with no fix in that line. Kokoro
never touches images, but every install of AIDA would have pulled the vulnerable version in.

Changes from upstream:

- `kokoro.js`: the streaming API (`stream()`, `TextSplitterStream`, `splitter.js`) is removed;
  AIDA synthesises one narration line at a time.
- `voices.js`: no voice files ship. `getVoiceFile` downloads the one voice in use (about 0.5 MB)
  from the model's Hugging Face repo on first use, checks its size, and caches it beside the model
  (transformers' `env.cacheDir`, under `kokoro-voices/`). The browser Cache API path is removed.
- `phonemize.js`: unchanged.

Drop this folder for the `kokoro-js` package again once a release supports transformers 4.
