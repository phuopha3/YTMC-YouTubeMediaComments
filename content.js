(() => {
  let CFG = null;

  const VS_BASE = 0xFE00;

  function encodeInvisible(str) {
    const bytes = new TextEncoder().encode(str);
    let out = "";
    for (const b of bytes) {
      out += String.fromCodePoint(VS_BASE + (b >> 4));
      out += String.fromCodePoint(VS_BASE + (b & 0xf));
    }
    return out;
  }
  function decodeInvisible(str) {
    const bytes = [];
    for (let i = 0; i + 1 < str.length; i += 2) {
      const hi = str.codePointAt(i) - VS_BASE;
      const lo = str.codePointAt(i + 1) - VS_BASE;
      if (hi < 0 || hi > 15 || lo < 0 || lo > 15) continue;
      bytes.push((hi << 4) | lo);
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  const NEW_TOKEN_RE = /\[(GIF|IMG)\]([\uFE00-\uFE0F]+)/g;

  const LEGACY_TOKEN_RE = /\[(img|gif):([^\]]+)\]/g;
  const ZWSP = "\u200B";

  function resolveGifUrl(giphyId) {
    return `https://media.giphy.com/media/${giphyId}/giphy.gif`;
  }
  function resolveImgUrl(path) {
    return `https://i.ibb.co/${path}`;
  }

  function isExtensionContextValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }
  function storageGet(keys) {
    return new Promise((resolve) => {
      if (!isExtensionContextValid()) return resolve({});
      try {
        chrome.storage.local.get(keys, (res) => {
          if (chrome.runtime.lastError) return resolve({});
          resolve(res || {});
        });
      } catch (e) {
        resolve({});
      }
    });
  }
  function storageSet(obj) {
    if (!isExtensionContextValid()) return;
    try {
      chrome.storage.local.set(obj);
    } catch (e) {

    }
  }

  function loadConfig() {
    CFG = window.YMC_CONFIG || {};
    return Promise.resolve(CFG);
  }
  function isConfigured() {
    if (!CFG) return false;
    return [CFG.IMGBB_API_KEY, CFG.GIPHY_API_KEY].every((v) => v && !v.startsWith("PASTE_"));
  }

  const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|svg|avif|heic|heif|tiff?)$/i;

  function isLikelyImageFile(file) {

    if (file.type) return file.type.startsWith("image/");
    return IMAGE_EXT_RE.test(file.name || "");
  }

  function randomShortName() {
    return "m" + Math.random().toString(36).slice(2, 7);
  }

  async function uploadImageToImgbb(file) {
    if (!isLikelyImageFile(file)) {
      throw new Error("Only image files are allowed (jpg, png, webp, gif...).");
    }
    const fd = new FormData();
    fd.append("image", file);
    fd.append("name", randomShortName());
    const res = await fetch(`https://api.imgbb.com/1/upload?key=${CFG.IMGBB_API_KEY}`, {
      method: "POST",
      body: fd
    });
    const json = await res.json();
    if (!json.success) throw new Error("imgbb upload failed");

    return json.data.url.replace(/^https?:\/\/i\.ibb\.co\//, "");
  }

  async function searchGifs(query) {
    const endpoint = query
      ? `https://api.giphy.com/v1/gifs/search?api_key=${CFG.GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=24&rating=pg-13`
      : `https://api.giphy.com/v1/gifs/trending?api_key=${CFG.GIPHY_API_KEY}&limit=24&rating=pg-13`;
    const res = await fetch(endpoint);
    const json = await res.json();
    return (json.data || []).map((g) => ({
      id: g.id,
      preview: g.images.fixed_width_small.url,
      full: g.images.original.url
    }));
  }

  function getRecentGifs() {
    return storageGet(["ymc_recent_gifs"]).then((res) => res.ymc_recent_gifs || []);
  }
  function pushRecentGif(g) {
    storageGet(["ymc_recent_gifs"]).then((res) => {
      let list = res.ymc_recent_gifs || [];
      list = list.filter((x) => x.id !== g.id);
      list.unshift(g);
      list = list.slice(0, 20);
      storageSet({ ymc_recent_gifs: list });
    });
  }

  const GIF_CATEGORIES = [
    { label: "Trending", query: "" },
    { label: "Meme", query: "meme" },
    { label: "Funny", query: "funny" },
    { label: "Love", query: "love" },
    { label: "Celebrate", query: "celebration" },
    { label: "Angry", query: "angry" },
    { label: "Sad", query: "sad" },
    { label: "Hello", query: "hello" }
  ];

  let lightboxEl = null;
  function openLightbox(url) {
    closeLightbox();
    lightboxEl = el(`
      <div class="ymc-lightbox">
        <button type="button" class="ymc-lightbox-close" title="Close">✕</button>
        <img src="${url}">
      </div>
    `);
    lightboxEl.addEventListener("click", (e) => {
      if (e.target === lightboxEl || e.target.classList.contains("ymc-lightbox-close")) closeLightbox();
    });
    document.addEventListener("keydown", onLightboxKeydown);
    document.body.appendChild(lightboxEl);
  }
  function onLightboxKeydown(e) {
    if (e.key === "Escape") closeLightbox();
  }
  function closeLightbox() {
    if (!lightboxEl) return;
    lightboxEl.remove();
    lightboxEl = null;
    document.removeEventListener("keydown", onLightboxKeydown);
  }

  function el(html) {

    const doc = new DOMParser().parseFromString(html.trim(), "text/html");
    return doc.body.firstElementChild;
  }

  function placeCursorAtEnd(editableEl) {
    editableEl.focus();
    const range = document.createRange();
    range.selectNodeContents(editableEl);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function getCaptionText(editableEl) {
    NEW_TOKEN_RE.lastIndex = 0;
    return (editableEl.textContent || "").replace(NEW_TOKEN_RE, "");
  }

  function setComposeMedia(editableEl, tokenText) {
    const caption = getCaptionText(editableEl);
    editableEl.replaceChildren();
    editableEl.appendChild(document.createTextNode(tokenText));
    editableEl.appendChild(document.createElement("br"));
    if (caption) editableEl.appendChild(document.createTextNode(caption));
    placeCursorAtEnd(editableEl);
    editableEl.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }

  function clearComposeMedia(editableEl) {
    const caption = getCaptionText(editableEl);
    editableEl.replaceChildren();
    if (caption) editableEl.appendChild(document.createTextNode(caption));
    placeCursorAtEnd(editableEl);
    editableEl.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }

  function hasComposeToken(editable) {
    NEW_TOKEN_RE.lastIndex = 0;
    return NEW_TOKEN_RE.test(editable.textContent || "");
  }

  function extractComposeTokens(text) {
    const out = [];
    NEW_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = NEW_TOKEN_RE.exec(text))) {
      const payload = decodeInvisible(m[2]);
      const url = m[1] === "GIF" ? resolveGifUrl(payload) : resolveImgUrl(payload);
      out.push({ full: m[0], url });
    }
    return out;
  }

  function ensurePreviewRow(commentBox, toolbarRow) {
    let row = commentBox.querySelector(".ymc-compose-preview");
    if (row) return row;
    row = el(`<div class="ymc-compose-preview" style="display:none"></div>`);
    toolbarRow.parentElement.insertBefore(row, toolbarRow);
    return row;
  }

  function refreshPreview(editable, previewRow, group) {
    const tokens = extractComposeTokens(editable.textContent || "");
    if (!tokens.length) {
      previewRow.style.display = "none";
      previewRow.replaceChildren();
    } else {
      previewRow.style.display = "flex";
      previewRow.replaceChildren();
      tokens.forEach((t) => {
        const chip = el(`
          <div class="ymc-preview-chip">
            <img src="${t.url}">
            <button type="button" class="ymc-preview-remove">✕</button>
          </div>
        `);
        chip.querySelector("img").addEventListener("click", () => openLightbox(t.url));
        chip.querySelector(".ymc-preview-remove").addEventListener("click", () => {
          clearComposeMedia(editable);
          refreshPreview(editable, previewRow, group);
        });
        previewRow.appendChild(chip);
      });
    }

    if (group) {
      const limited = tokens.length > 0;
      group.querySelectorAll("[data-act]").forEach((btn) => {
        btn.disabled = limited;
        btn.title = limited
          ? "Only one image or GIF per comment — remove the current one first"
          : btn.dataset.act === "img"
          ? "Post an image"
          : "Post a GIF";
      });
    }
  }

  const PROCESSED = new WeakSet();
  const IMG_ICON_SVG = `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`;
  const SPINNER_SVG = `<svg class="ymc-spinner" viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="42" stroke-dashoffset="14"/></svg>`;

  function buildToolbarGroup() {
    return el(`
      <div class="ymc-toolbar-group">
        <button type="button" class="ymc-icon-btn ymc-img-btn" data-act="img" title="Post an image">
          <span class="ymc-icon-slot">${IMG_ICON_SVG}</span>
          <span class="ymc-beta-badge">Beta</span>
        </button>
        <button type="button" class="ymc-icon-btn" data-act="gif" title="Post a GIF">GIF</button>
        <input type="file" accept="image/*" class="ymc-file" style="display:none">
      </div>
    `);
  }

  function wireToolbarGroup(group, editable, previewRow) {
    const fileInput = group.querySelector(".ymc-file");
    const imgBtn = group.querySelector(".ymc-img-btn");
    const gifBtn = group.querySelector('[data-act="gif"]');
    const iconSlot = imgBtn.querySelector(".ymc-icon-slot");

    function setIcon(svgMarkup) {
      iconSlot.replaceChildren(el(svgMarkup));
    }

    let busy = false;

    function syncButtons() {
      refreshPreview(editable, previewRow, group);
      if (busy) {
        imgBtn.disabled = true;
        gifBtn.disabled = true;
      }
    }

    group.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn || btn.disabled || busy) return;
      if (hasComposeToken(editable)) {
        alert("Only one image or GIF is allowed per comment. Remove the current one first.");
        return;
      }
      if (btn.dataset.act === "img") {
        busy = true;
        syncButtons();
        fileInput.click();
      } else if (btn.dataset.act === "gif") {
        busy = true;
        syncButtons();
        toggleGifPicker(group, editable, previewRow, () => {
          busy = false;
          syncButtons();
        });
      }
    });

    fileInput.addEventListener("cancel", () => {
      busy = false;
      syncButtons();
    });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      if (!file) {
        busy = false;
        syncButtons();
        return;
      }
      if (!isLikelyImageFile(file)) {
        alert("Only image files are allowed (jpg, png, webp...) — other file types are not accepted.");
        fileInput.value = "";
        busy = false;
        syncButtons();
        return;
      }
      setIcon(SPINNER_SVG);
      try {
        const path = await uploadImageToImgbb(file);
        setComposeMedia(editable, `[IMG]${encodeInvisible(path)}`);
      } catch (err) {
        alert("Image upload failed: " + err.message);
      } finally {
        setIcon(IMG_ICON_SVG);
        fileInput.value = "";
        busy = false;
        syncButtons();
      }
    });

    editable.addEventListener("input", () => {
      if (!busy) syncButtons();
    });

    const contentObserver = new MutationObserver(() => {
      if (!busy) syncButtons();
    });
    contentObserver.observe(editable, { childList: true, characterData: true, subtree: true });
  }

  function insertGroupNextToEmoji(toolbarRow, editable, previewRow) {
    const group = buildToolbarGroup();
    wireToolbarGroup(group, editable, previewRow);
    const emojiBtn = toolbarRow.querySelector("#emoji-button");
    if (emojiBtn && emojiBtn.parentElement) {
      emojiBtn.parentElement.insertBefore(group, emojiBtn.nextSibling);
    } else {
      toolbarRow.insertBefore(group, toolbarRow.firstChild);
    }
  }

  function attachToolbar(commentBox) {
    if (PROCESSED.has(commentBox)) return;

    const tryAttach = () => {
      if (PROCESSED.has(commentBox)) return true;
      const editable = commentBox.querySelector("#contenteditable-root");
      const toolbarRow =
        commentBox.querySelector("#toolbar") ||
        commentBox.querySelector("#submit-button")?.parentElement;
      if (!editable || !toolbarRow) return false;
      if (toolbarRow.querySelector(".ymc-toolbar-group")) {
        PROCESSED.add(commentBox);
        return true;
      }
      const previewRow = ensurePreviewRow(commentBox, toolbarRow);
      insertGroupNextToEmoji(toolbarRow, editable, previewRow);
      PROCESSED.add(commentBox);
      return true;
    };

    if (tryAttach()) return;
    const localObserver = new MutationObserver(() => {
      if (tryAttach()) localObserver.disconnect();
    });
    localObserver.observe(commentBox, { childList: true, subtree: true });
    setTimeout(() => localObserver.disconnect(), 5 * 60 * 1000);
  }

  let openPicker = null;
  let openPickerCleanup = null;
  let openPickerOnClose = null;

  function positionPicker(picker, anchorGroup) {
    const rect = anchorGroup.getBoundingClientRect();
    const margin = 8;
    const pickerWidth = 300;
    const maxPickerHeight = 420;

    let left = rect.left;
    if (left + pickerWidth > window.innerWidth - margin) {
      left = window.innerWidth - pickerWidth - margin;
    }
    if (left < margin) left = margin;

    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    let top, maxHeight;
    if (spaceBelow >= 240 || spaceBelow >= spaceAbove) {
      top = rect.bottom + 6;
      maxHeight = Math.min(maxPickerHeight, spaceBelow - 6);
    } else {
      maxHeight = Math.min(maxPickerHeight, spaceAbove - 6);
      top = rect.top - maxHeight - 6;
    }

    picker.style.left = `${left}px`;
    picker.style.top = `${Math.max(margin, top)}px`;
    picker.style.maxHeight = `${Math.max(160, maxHeight)}px`;
  }

  function closePicker() {
    if (!openPicker) return;
    openPicker.remove();
    openPicker = null;
    if (openPickerCleanup) {
      openPickerCleanup();
      openPickerCleanup = null;
    }
    if (openPickerOnClose) {
      const cb = openPickerOnClose;
      openPickerOnClose = null;
      cb();
    }
  }

  async function toggleGifPicker(anchorGroup, editable, previewRow, onClose) {
    if (openPicker) {
      closePicker();
      return;
    }
    const picker = el(`
      <div class="ymc-gif-picker">
        <input type="text" class="ymc-gif-search" placeholder="Search GIFs...">
        <div class="ymc-gif-categories"></div>
        <div class="ymc-gif-recent" style="display:none">
          <div class="ymc-gif-section-title">Recently sent</div>
          <div class="ymc-gif-grid ymc-gif-grid-recent"></div>
        </div>
        <div class="ymc-gif-section-title">Suggested</div>
        <div class="ymc-gif-grid ymc-gif-grid-main">Loading...</div>
      </div>
    `);

    document.body.appendChild(picker);
    positionPicker(picker, anchorGroup);
    openPicker = picker;
    openPickerOnClose = onClose || null;

    const search = picker.querySelector(".ymc-gif-search");
    const catRow = picker.querySelector(".ymc-gif-categories");
    const recentWrap = picker.querySelector(".ymc-gif-recent");
    const recentGrid = picker.querySelector(".ymc-gif-grid-recent");
    const mainGrid = picker.querySelector(".ymc-gif-grid-main");

    function pickGif(g) {
      setComposeMedia(editable, `[GIF]${encodeInvisible(g.id)}`);
      pushRecentGif(g);
      closePicker();
    }

    function renderGrid(gridEl, gifs) {
      gridEl.replaceChildren();
      gifs.forEach((g) => {
        const img = el(`<img class="ymc-gif-item" src="${g.preview}" loading="lazy">`);
        img.onclick = () => pickGif(g);
        gridEl.appendChild(img);
      });
    }

    GIF_CATEGORIES.forEach((cat, i) => {
      const chip = el(`<button type="button" class="ymc-cat-chip${i === 0 ? " active" : ""}">${cat.label}</button>`);
      chip.addEventListener("click", () => {
        catRow.querySelectorAll(".ymc-cat-chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        search.value = "";
        loadMain(cat.query);
      });
      catRow.appendChild(chip);
    });

    catRow.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          catRow.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      },
      { passive: false }
    );

    async function loadMain(query) {
      mainGrid.textContent = "Loading...";
      try {
        renderGrid(mainGrid, await searchGifs(query));
      } catch (e) {
        mainGrid.textContent = "Failed to load GIFs";
      }
    }

    let deb;
    search.addEventListener("input", () => {
      catRow.querySelectorAll(".ymc-cat-chip").forEach((c) => c.classList.remove("active"));
      clearTimeout(deb);
      deb = setTimeout(() => loadMain(search.value.trim()), 350);
    });

    getRecentGifs().then((recent) => {
      if (recent.length) {
        recentWrap.style.display = "block";
        renderGrid(recentGrid, recent);
      }
    });

    search.focus();
    loadMain("");

    const reposition = () => positionPicker(picker, anchorGroup);
    window.addEventListener("scroll", reposition, { passive: true, capture: true });
    window.addEventListener("resize", reposition, { passive: true });

    function onDocClick(ev) {
      if (!picker.contains(ev.target) && !anchorGroup.contains(ev.target)) closePicker();
    }
    setTimeout(() => document.addEventListener("click", onDocClick), 0);

    openPickerCleanup = () => {
      window.removeEventListener("scroll", reposition, { capture: true });
      window.removeEventListener("resize", reposition);
      document.removeEventListener("click", onDocClick);
    };
  }

  function scanForCommentBoxes(rootNode) {
    rootNode.querySelectorAll?.("ytd-commentbox").forEach(attachToolbar);
  }

  const RENDERED = new WeakSet();

  function findAllMatches(text) {
    const matches = [];
    NEW_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = NEW_TOKEN_RE.exec(text))) {
      const payload = decodeInvisible(m[2]);
      const url = m[1] === "GIF" ? resolveGifUrl(payload) : resolveImgUrl(payload);
      matches.push({ index: m.index, length: m[0].length, url });
    }
    LEGACY_TOKEN_RE.lastIndex = 0;
    while ((m = LEGACY_TOKEN_RE.exec(text))) {
      const url = m[2].split(ZWSP).join("");
      if (/^https?:\/\//.test(url)) {
        matches.push({ index: m.index, length: m[0].length, url });
      }
    }
    matches.sort((a, b) => a.index - b.index);
    return matches;
  }

  function renderTokensIn(contentTextEl) {
    if (RENDERED.has(contentTextEl)) return;
    const full = contentTextEl.textContent || "";
    if (!full.includes("[GIF]") && !full.includes("[IMG]") && !full.includes("[gif:") && !full.includes("[img:")) return;

    const walker = document.createTreeWalker(contentTextEl, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    let didReplace = false;
    textNodes.forEach((node) => {
      const text = node.nodeValue;
      const matches = findAllMatches(text);
      if (!matches.length) return;

      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      matches.forEach((m) => {
        if (m.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
        const img = document.createElement("img");
        img.src = m.url;
        img.className = "ymc-inline-media";
        img.loading = "lazy";
        img.addEventListener("click", (e) => {
          e.stopPropagation();
          openLightbox(m.url);
        });
        frag.appendChild(img);
        lastIndex = m.index + m.length;
        didReplace = true;
      });
      if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
      node.parentNode.replaceChild(frag, node);
    });

    if (didReplace) RENDERED.add(contentTextEl);
  }

  function scanForContentText(rootNode) {
    rootNode.querySelectorAll?.("#content-text").forEach(renderTokensIn);
  }

  async function init() {
    await loadConfig();
    if (!isConfigured()) {
      console.warn("[YTMC] IMGBB_API_KEY / GIPHY_API_KEY not configured in config.js");
    }

    scanForCommentBoxes(document);
    scanForContentText(document);

    const mo = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        mut.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.matches?.("ytd-commentbox")) attachToolbar(node);
          else scanForCommentBoxes(node);
          if (node.matches?.("#content-text")) renderTokensIn(node);
          else scanForContentText(node);
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  init();

  document.addEventListener("yt-navigate-finish", () => {
    scanForCommentBoxes(document);
    scanForContentText(document);
  });
})();
