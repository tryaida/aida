// Deterministic walkthrough player, ported from the original pipeline's player.js.
// Every visual is a pure function of time: window.renderAt(t) puts the DOM in its state for
// second t and resolves once the screenshots it needs are decoded, so the renderer can capture
// any frame in any order. Opened directly in a browser it also plays in real time.
/* global TIMELINE */
(() => {
  const TL = window.TIMELINE
  const $ = (id) => document.getElementById(id)
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
  const lerp = (a, b, p) => a + (b - a) * p
  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2) // cubic in-out
  const easeOut = (p) => 1 - Math.pow(1 - p, 3)
  const ramp = (t, t0, d) => clamp((t - t0) / d, 0, 1)
  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // Mosaic constants — kept identical to pages/annotate.ts's (same names there) so a blur box
  // looks and destroys information the same way whether it ends up on a page screenshot or in
  // the video. See annotate.ts's header comment on MOSAIC_MAX_CELLS for why it's 1.
  const BLUR_MOSAIC_FACTOR = 20
  const BLUR_MOSAIC_MAX_CELLS = 1
  const VW = TL.viewport.w, VH = TL.viewport.h
  const K = TL.stage.w / VW

  // ------------------------------------------------------------ static DOM
  const stage = $('stage')
  Object.assign(stage.style, { left: `${TL.stage.x}px`, top: `${TL.stage.y}px`, width: `${TL.stage.w}px`, height: `${TL.stage.h}px` })
  const imgA = $('imgA'), imgB = $('imgB')
  const spot = $('spot'), cursor = $('cursor'), cam = $('cam')
  const blurLayer = $('blurLayer'), calloutLayer = $('calloutLayer'), calloutLegend = $('calloutLegend')
  const ripples = TL.clicks.map(() => { const r = document.createElement('div'); r.className = 'ripple'; cam.insertBefore(r, cursor); return r })

  // ------------------------------------------------------------ brand (static, set once)
  // Colours/font/logo only ever change styling set here at load — never anything renderAt(t)
  // computes per frame — so render/state.ts's frameSignature is unaffected by the brand.
  const brand = TL.brand ?? { name: '' }
  const rootStyle = document.documentElement.style
  const kebab = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
  for (const [k, v] of Object.entries(brand.colors || {})) if (v) rootStyle.setProperty(`--brand-${kebab(k)}`, v)
  const stack = (f) => `"${f}", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`
  if (brand.font) rootStyle.setProperty('--font', stack(brand.font))
  if (brand.headingFont) rootStyle.setProperty('--heading-font', stack(brand.headingFont))
  const logos = []
  for (const [nameId, logoId] of [['brand-name', 'brand-logo'], ['outro-brand-name', 'outro-logo']]) {
    $(nameId).textContent = brand.name
    if (brand.logoSrc) { $(logoId).src = brand.logoSrc; $(logoId).style.display = ''; logos.push($(logoId)) }
  }
  // Long titles step down a size so they wrap to at most ~2-3 balanced lines.
  const sizeTitle = (el, text) => {
    const n = (text || '').length
    el.classList.toggle('long', n > 34 && n <= 58)
    el.classList.toggle('xlong', n > 58)
  }

  // Everything the first frame depends on that loads asynchronously — the brand webfont and the
  // logo's decode — resolves `window.brandReady`, which the renderer awaits before frame 0. Each
  // wait is capped so an offline render (fontUrl unreachable) falls back to the system font
  // instead of hanging.
  const capped = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))])
  const fontsReady = (async () => {
    if (brand.fontUrl) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = brand.fontUrl
      const loaded = new Promise((r) => { link.onload = r; link.onerror = r })
      document.head.appendChild(link)
      await capped(loaded, 5000)
    }
    const families = [brand.font, brand.headingFont].filter(Boolean)
    await Promise.all(families.flatMap((f) => ['500', '600', '700', '800'].map((w) =>
      document.fonts.load(`${w} 32px "${f}"`).catch(() => {}))))
    await document.fonts.ready
  })()
  // A light-background logo that would be too dark to read on the night canvas sits on a white
  // tile instead (logoDark, made for dark backgrounds, is always shown bare).
  const logoReady = (async () => {
    if (!logos.length || brand.logoForDark) return
    const img = logos[0]
    await img.decode().catch(() => {})
    if (!img.naturalWidth) return
    try {
      const c = document.createElement('canvas')
      const w = (c.width = 48), h = (c.height = 48)
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0, w, h)
      const d = ctx.getImageData(0, 0, w, h).data
      let sum = 0, n = 0
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] / 255
        if (a < 0.2) continue
        sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255
        n++
      }
      const luminance = n ? sum / n : 1
      const opaque = n / (w * h)
      // Dark artwork, or a fully opaque (non-transparent) image, reads better as a tile.
      if (luminance < 0.42 || opaque > 0.97) logos.forEach((l) => l.classList.add('tile'))
    } catch { /* tainted/undecodable: leave bare */ }
  })()
  window.brandReady = capped(Promise.all([fontsReady, logoReady]), 8000)

  $('intro-eyebrow').textContent = TL.intro.eyebrow
  $('intro-title').innerHTML = TL.intro.titleHtml
  sizeTitle($('intro-title'), $('intro-title').textContent)
  $('intro-sub').textContent = TL.intro.subtitle
  $('intro-parts').innerHTML = TL.chapters.map((c, i) => `<div class="part"><span class="n">${i + 1}</span>${c}</div>`).join('')
  $('outro-title').textContent = TL.outro.title
  sizeTitle($('outro-title'), TL.outro.title)
  const tick = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
  $('outro-recap').innerHTML = TL.outro.recap.map((r) => `<div class="row"><span class="tick">${tick}</span><span>${r}</span></div>`).join('')
  const recapRows = [...$('outro-recap').children]
  // The outro's brand row (logo + name) already shows the product, so the footer line stays empty.
  $('outro-tagline').textContent = ''

  // ------------------------------------------------------------ lookups
  function lastAtOrBefore(list, t, key = 't') {
    let lo = 0, hi = list.length - 1, ans = -1
    while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m][key] <= t) { ans = m; lo = m + 1 } else hi = m - 1 }
    return ans
  }

  function cameraAt(t) {
    const i = lastAtOrBefore(TL.cameras, t, 't0')
    if (i < 0) return TL.cameras[0].from
    const c = TL.cameras[i]
    const p = ease(ramp(t, c.t0, c.t1 - c.t0))
    return { z: lerp(c.from.z, c.to.z, p), cx: lerp(c.from.cx, c.to.cx, p), cy: lerp(c.from.cy, c.to.cy, p) }
  }

  function cursorAt(t) {
    const i = lastAtOrBefore(TL.moves, t, 't0')
    if (i < 0) return { ...TL.cursorStart }
    const m = TL.moves[i]
    const p = ease(ramp(t, m.t0, m.t1 - m.t0))
    // Gentle arc: bend the straight path sideways by a fraction of its length.
    const dx = m.to.x - m.from.x, dy = m.to.y - m.from.y
    const bend = Math.sin(Math.PI * p) * 0.08
    return { x: lerp(m.from.x, m.to.x, p) - dy * bend, y: lerp(m.from.y, m.to.y, p) + dx * bend }
  }

  // ------------------------------------------------------------ callouts + blur (M22)
  // Mirror of packages/engine/src/render/state.ts's calloutsAt/blurAt — see that file's header
  // note on keeping this in sync.
  function calloutsAt(t) {
    return (TL.callouts || []).find((w) => t >= w.t0 && t <= w.t1)
  }
  function blurAt(t) {
    return (TL.blur || []).find((w) => t >= w.t0 && t <= w.t1)
  }

  // ------------------------------------------------------------ images
  function setSrc(img, src) {
    if (img.dataset.src === src) return img.decode().catch(() => {})
    img.dataset.src = src
    img.src = src
    return img.decode().catch(() => {})
  }

  // ------------------------------------------------------------ render
  // packages/engine/src/render/state.ts's frameSignature() is a hand-kept Node-side port of every
  // value this function computes (no DOM, so it can run per-candidate-frame without a browser) —
  // video.ts's renderFrameRange uses it to skip re-rendering a frame whose signature matches the
  // previous one. Any change here that changes what's visible (a new ramp/ease term, a new
  // branch, a new style/content assignment) must be mirrored there, or a frame that actually
  // changed could get a false signature match and come out as a repeated/frozen frame with no
  // test catching it.
  async function renderAt(t) {
    const waits = []

    // Scene envelope: intro card -> stage -> outro card.
    const sIn = ease(ramp(t, TL.stageIn.t0, TL.stageIn.t1 - TL.stageIn.t0))
    const sOut = ease(ramp(t, TL.stageOut.t0, TL.stageOut.t1 - TL.stageOut.t0))
    const stageVis = sIn * (1 - sOut)
    stage.style.opacity = stageVis
    stage.style.transform = `translateY(${(1 - sIn) * 40 + sOut * -30}px) scale(${0.94 + 0.06 * sIn - 0.04 * sOut})`
    stage.style.visibility = stageVis > 0.001 ? 'visible' : 'hidden'

    // Intro card.
    const intro = $('intro')
    const iOut = ease(ramp(t, TL.stageIn.t0 - 0.45, 0.5))
    intro.style.visibility = iOut < 0.999 ? 'visible' : 'hidden'
    intro.style.opacity = 1 - iOut
    intro.style.transform = `translateY(${-50 * iOut}px)`
    const reveal = (el, start, dur = 0.7, dy = 26) => {
      const p = easeOut(ramp(t, start, dur))
      el.style.opacity = p
      el.style.transform = `translateY(${(1 - p) * dy}px)`
    }
    reveal($('intro-brand'), 0.15)
    reveal($('intro-eyebrow'), 0.45)
    reveal($('intro-title'), 0.65, 0.8, 40)
    reveal($('intro-sub'), 1.15)
    reveal($('intro-parts'), 1.6)

    // Outro card.
    const outro = $('outro')
    const oIn = ease(ramp(t, TL.stageOut.t0 + 0.25, 0.7))
    outro.style.visibility = oIn > 0.001 ? 'visible' : 'hidden'
    outro.style.opacity = oIn
    const o0 = TL.stageOut.t0 + 0.35
    reveal($('outro-title'), o0, 0.7, 40)
    recapRows.forEach((row, i) => reveal(row, o0 + 0.5 + i * 0.35, 0.6, 18))
    reveal($('outro-foot'), o0 + 0.6 + recapRows.length * 0.35)

    if (stageVis > 0.001) {
      // Screenshot layers: current frame over the previous one while fading.
      const fi = Math.max(0, lastAtOrBefore(TL.frames, t))
      const cur = TL.frames[fi], prev = TL.frames[Math.max(0, fi - 1)]
      const fadeP = cur.transition === 'fade' ? ramp(t, cur.t, TL.fade) : 1
      waits.push(setSrc(imgA, prev.src), setSrc(imgB, cur.src))
      imgB.style.opacity = fadeP

      // Camera.
      const c = cameraAt(t)
      const z = c.z
      const cx = clamp(c.cx, VW / 2 / z, VW - VW / 2 / z)
      const cy = clamp(c.cy, VH / 2 / z, VH - VH / 2 / z)
      const s = K * z
      cam.style.transform = `translate(${TL.stage.w / 2 - cx * s}px, ${TL.stage.h / 2 - cy * s}px) scale(${s})`

      // Highlight.
      const hi = TL.highlights.find((h) => t >= h.t0 && t <= h.t1)
      if (hi) {
        const a = Math.min(easeOut(ramp(t, hi.t0, 0.3)), 1 - ramp(t, hi.t1 - 0.25, 0.25))
        const pad = 8 + (1 - a) * 10
        Object.assign(spot.style, {
          display: 'block', opacity: a,
          left: `${hi.box.x - pad}px`, top: `${hi.box.y - pad}px`,
          width: `${hi.box.w + pad * 2}px`, height: `${hi.box.h + pad * 2}px`,
        })
      } else spot.style.display = 'none'

      // Callouts: numbered badges pinned to their resolved boxes, plus a legend for any with a
      // label — same red badge/legend styling as pages/annotate.ts's user callouts.
      const coWin = calloutsAt(t)
      const items = coWin ? coWin.items : []
      while (calloutLayer.children.length > items.length) calloutLayer.lastChild.remove()
      while (calloutLayer.children.length < items.length) {
        const badge = document.createElement('div')
        badge.className = 'callout-badge'
        calloutLayer.appendChild(badge)
      }
      items.forEach((item, i) => {
        const badge = calloutLayer.children[i]
        badge.textContent = String(item.num)
        Object.assign(badge.style, { left: `${item.box.x + item.box.w / 2}px`, top: `${item.box.y}px` })
      })
      const labelled = items.filter((it) => it.label)
      calloutLegend.innerHTML = labelled.map((it) => `<div><b>${it.num}.</b>${escapeHtml(it.label)}</div>`).join('')

      // Cursor (counter-scaled a little so it never balloons when zoomed).
      const p = cursorAt(t)
      const press = TL.clicks.some((k) => t >= k.t && t <= k.t + 0.16) ? 0.86 : 1
      const cs = (1 / Math.sqrt(z)) * press / K * 1.15
      const cVis = ramp(t, TL.stageIn.t1 - 0.2, 0.4)
      cursor.style.opacity = cVis
      cursor.style.transform = `translate(${p.x - 2}px, ${p.y - 1}px) scale(${cs})`

      // Click ripples.
      TL.clicks.forEach((k, i) => {
        const r = ripples[i]
        const q = (t - k.t) / 0.55
        if (q < 0 || q > 1) { r.style.display = 'none'; return }
        const d = 14 + easeOut(q) * 56
        Object.assign(r.style, { display: 'block', left: `${k.x}px`, top: `${k.y}px`, width: `${d}px`, height: `${d}px`, opacity: 1 - q })
      })
    }

    // Caption band.
    const cap = TL.captions.find((c) => t >= c.t0 && t <= c.t1)
    const capEl = $('caption')
    if (cap) {
      capEl.textContent = cap.text
      capEl.style.opacity = Math.min(ramp(t, cap.t0, 0.2), 1 - ramp(t, cap.t1 - 0.2, 0.2))
    } else capEl.style.opacity = 0
    const chip = TL.chips.find((c) => t >= c.t0 && t < c.t1)
    const chipEl = $('chip')
    if (chip) {
      chipEl.querySelector('.num').textContent = chip.num
      chipEl.querySelector('.eyebrow').textContent = chip.eyebrow
      chipEl.querySelector('.title').textContent = chip.title
      const a = easeOut(ramp(t, chip.t0, 0.35))
      chipEl.style.opacity = a
      chipEl.style.transform = `translateX(${(1 - a) * -16}px)`
    } else chipEl.style.opacity = 0

    await Promise.all(waits)

    // Blur (burned in at screenshot time, not a removable overlay — see pages/annotate.ts's
    // header note and docs/scope.md "Safe by default"): a coarse mosaic (downscale then nearest-
    // neighbour back up — see MOSAIC_MAX_CELLS there) of the current frame, drawn into a canvas
    // positioned over each active box, nested inside #cam so it pans/zooms with the camera like
    // everything else the box is meant to track. Must run after `await Promise.all(waits)` above
    // (imgA/imgB need to have finished decoding before a canvas can draw from them), which is why
    // this block sits outside the `if (stageVis > 0.001)` block that computed `cur`/`z` earlier —
    // recomputing `cur` here is cheap and keeps this block from needing those vars hoisted out.
    if (stageVis > 0.001) {
      const fi = Math.max(0, lastAtOrBefore(TL.frames, t))
      const cur = TL.frames[fi]
      const srcImg = imgB // setSrc(imgB, cur.src) above already resolved and awaited
      const blurWin = blurAt(t)
      const blurBoxes = blurWin ? blurWin.boxes : []
      while (blurLayer.children.length > blurBoxes.length) blurLayer.lastChild.remove()
      while (blurLayer.children.length < blurBoxes.length) {
        const canvas = document.createElement('canvas')
        canvas.className = 'blur-box'
        blurLayer.appendChild(canvas)
      }
      // A "broken" <img> (decode failed/404) makes drawImage throw synchronously — in production
      // this never happens (the frame files are real, and setSrc's waits already awaited decode
      // above), but this must still fail *closed*, not open: a blur box that can't draw its
      // mosaic must never fall through to showing nothing (which would expose whatever the
      // underlying page content is), so a solid fill stands in for the mosaic instead.
      const srcReady = srcImg.complete && srcImg.naturalWidth > 0
      const ratio = srcReady ? srcImg.naturalWidth / VW : 1
      blurBoxes.forEach((b, i) => {
        const c = blurLayer.children[i]
        Object.assign(c.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` })
        const cw = Math.max(1, Math.round(b.w))
        const ch = Math.max(1, Math.round(b.h))
        c.width = cw
        c.height = ch
        const ctx = c.getContext('2d')
        if (!srcReady) {
          ctx.imageSmoothingEnabled = false
          ctx.fillStyle = '#111827'
          ctx.fillRect(0, 0, cw, ch)
          return
        }
        const miniW = Math.max(1, Math.min(BLUR_MOSAIC_MAX_CELLS, Math.round(b.w / BLUR_MOSAIC_FACTOR)))
        const miniH = Math.max(1, Math.min(BLUR_MOSAIC_MAX_CELLS, Math.round(b.h / BLUR_MOSAIC_FACTOR)))
        if (!c._mini) c._mini = document.createElement('canvas')
        const mini = c._mini
        mini.width = miniW
        mini.height = miniH
        const mctx = mini.getContext('2d')
        mctx.imageSmoothingEnabled = true
        mctx.drawImage(srcImg, b.x * ratio, b.y * ratio, b.w * ratio, b.h * ratio, 0, 0, miniW, miniH)

        ctx.imageSmoothingEnabled = false // nearest-neighbour upscale — perfectly flat cells
        ctx.drawImage(mini, 0, 0, miniW, miniH, 0, 0, cw, ch)
      })
    } else {
      while (blurLayer.firstChild) blurLayer.firstChild.remove()
    }
  }
  window.renderAt = renderAt

  // ------------------------------------------------------------ live preview
  if (!/render=1/.test(location.search)) {
    const audio = new Audio(TL.previewAudio)
    let playing = false, t0 = 0
    const loop = async () => {
      if (!playing) return
      const t = audio.currentTime
      await renderAt(t)
      if (t >= TL.duration) { playing = false; return }
      requestAnimationFrame(loop)
    }
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space') return
      playing = !playing
      if (playing) { audio.play(); loop() } else audio.pause()
    })
    renderAt(t0)
    console.log('Press space to play / pause')
  }
})()
